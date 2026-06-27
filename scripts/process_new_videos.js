/**
 * process_new_videos.js
 *
 * The full pipeline in ONE pass, per video:
 *   1. Scan the proxies Drive folder for videos
 *   2. Skip anything already in Supabase (checked by source Drive file ID —
 *      NOT a local file, so this is safe to run as a stateless cron job)
 *   3. Download + extract audio (stall-aware — won't hang or get killed on slow-but-fine transfers;
 *      downloads to a local temp file first so ffmpeg can seek, since MOV/MP4 files commonly
 *      store metadata at the end of the file and a non-seekable pipe can't read that)
 *   4. Transcribe with AssemblyAI (speaker diarization)
 *   5. Generate a title with GPT-4o-mini
 *   6. Best-effort: upload transcript JSON + copy video into the Shared Drive
 *   7. Chunk the transcript, generate OpenAI embeddings
 *   8. Upsert directly into Supabase (videos + transcript_chunks)
 *
 * Supabase and Drive are the only durable stores — any local files (the
 * downloaded source video, the extracted audio) are temp files deleted
 * immediately after use, which is what makes this safe to run on Render
 * (ephemeral disk, fresh container per run).
 *
 * Designed to run as a recurring job (e.g. Render Cron Job, every 15-30 min):
 *   - Bounded by MAX_VIDEOS_PER_RUN and RUN_TIME_BUDGET_MS so one run never
 *     overlaps the next.
 *   - Anything not finished this run gets picked up next run automatically,
 *     since "done" is determined by querying Supabase, not local state.
 *
 * Run manually:
 *   node scripts/process_new_videos.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { spawn, execSync } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────

const PROXIES_FOLDER_ID      = process.env.PROXIES_FOLDER_ID;
const SHARED_DRIVE_FOLDER_ID = process.env.SHARED_DRIVE_FOLDER_ID;

// Tags every video this run ingests with which parent folder/event it came
// from (e.g. "Norway 2026", "SF Content Week 2026", "Webinars"), so the
// search UI can filter results down to just one source instead of always
// searching everything. Each wrapper script (process_norway_videos.js etc.)
// sets this before requiring this file. Leave unset and rows are saved with
// collection = null (searchable as normal, just won't show up under any
// folder filter until backfilled).
const COLLECTION = process.env.COLLECTION || null;
const ASSEMBLYAI_API_KEY     = process.env.ASSEMBLYAI_API_KEY;
const OPENAI_API_KEY         = process.env.OPENAI_API_KEY;
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.mts', '.m4v', '.mxf']);

// Off by default: when the proxies folder being scanned IS the same "Videos"
// folder the output would copy into (e.g. videographers upload straight into
// Norway 2026/Videos and transcripts land in the sibling Norway 2026/Transcripts),
// copying a renamed duplicate back into Videos just clutters it next to the
// original. Set COPY_VIDEO_TO_DRIVE=true only if proxies and output live in
// genuinely different folders and you want a labeled copy alongside the original.
const COPY_VIDEO_TO_DRIVE = /^true$/i.test(process.env.COPY_VIDEO_TO_DRIVE || 'false');

// Off by default: when proxies and output live in the SAME folder (the
// Norway 2026 case), there's no copy to make -- but the original file as
// uploaded by the videographer (IMG_5542.MOV) still won't match its transcript
// (e.g. "Sara on safety culture.json") by name. Set RENAME_VIDEO_IN_PLACE=true
// to rename the original source file itself (same Drive file ID, so dedup is
// unaffected) to match the transcript title once processing finishes.
const RENAME_VIDEO_IN_PLACE = /^true$/i.test(process.env.RENAME_VIDEO_IN_PLACE || 'false');

// Some clips (short test recordings, B-roll, camera tests) have no audio track,
// or an audio track with effectively nothing in it. Sending that to AssemblyAI
// produces a hard "Transcoding failed" error every time -- and since the script
// never writes a Supabase row for a failed video, it would retry (and fail) on
// every future run forever. Detect this case from ffmpeg's own probe output and
// skip transcription entirely instead, saving the video with an empty transcript
// so it's marked processed and never retried.
const MIN_USABLE_AUDIO_BYTES = 4 * 1024; // below this is effectively silence/empty at 16kHz mono 32kbps

// Optional regex (as a string) to scope which subfolder paths count, e.g. "\\bcam\\s*1\\b".
// Leave unset to process every camera/folder found under PROXIES_FOLDER_ID.
const CAM_FOLDER_FILTER = process.env.CAM_FOLDER_FILTER ? new RegExp(process.env.CAM_FOLDER_FILTER, 'i') : null;

// Optional comma-separated list of source Drive file IDs to skip even though
// they're not yet in Supabase. Used for legacy-folder backfills where a scan
// turns up literal duplicate copies (e.g. "Copy of X.mp4") of footage that's
// already been transcribed under a different file ID -- without this, those
// duplicates would look "unprocessed" forever (dedup is by file ID, and a
// duplicate has its own ID) and get transcribed a second time for no reason.
const EXCLUDE_FILE_IDS = new Set(
  (process.env.EXCLUDE_FILE_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

// Optional local backup dir for transcript JSONs. Only useful for manual local runs —
// on Render this is ephemeral and pointless, so leave LOCAL_BACKUP_DIR unset there.
const LOCAL_BACKUP_DIR = process.env.LOCAL_BACKUP_DIR
  ? path.resolve(process.env.LOCAL_BACKUP_DIR)
  : null;

// Bound a single run so cron invocations never pile up on each other.
const MAX_VIDEOS_PER_RUN  = parseInt(process.env.MAX_VIDEOS_PER_RUN || '8', 10);
const RUN_TIME_BUDGET_MS  = parseInt(process.env.RUN_TIME_BUDGET_MS || String(12 * 60 * 1000), 10);

const CHUNK_TARGETS_MS = [30_000, 60_000, 90_000];
const CHUNK_LABEL      = { 30000: '30s', 60000: '60s', 90000: '90s' };
const EMBED_BATCH_SIZE = 20;
const EMBED_MODEL      = 'text-embedding-3-small';

const STALL_TIMEOUT_MS = 90 * 1000;      // no bytes received for 90s = genuinely stalled
const MAX_STREAM_MS    = 30 * 60 * 1000; // absolute safety cap for pathological cases

function requireEnv() {
  const missing = [];
  if (!PROXIES_FOLDER_ID) missing.push('PROXIES_FOLDER_ID');
  if (!ASSEMBLYAI_API_KEY) missing.push('ASSEMBLYAI_API_KEY');
  if (!OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) missing.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

// ─── Clients ──────────────────────────────────────────────────────────────────

function buildDrive() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

function buildOpenAI() {
  return new OpenAI({ apiKey: OPENAI_API_KEY });
}

function buildSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ─── Drive folder helpers ─────────────────────────────────────────────────────

async function getOrCreateFolder(drive, name, parentId) {
  const res = await drive.files.list({
    q: `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    supportsAllDrives: true,
    fields: 'id',
  });
  return created.data.id;
}

// ─── Video scanning ───────────────────────────────────────────────────────────

// Every parent folder (Norway 2026, SF Content Week 2026, Webinars, and any
// future ones) now has a "Content for Socials" subfolder containing the
// edited short clips actually uploaded to Instagram/LinkedIn/etc. Those are
// finished, derivative output -- not new raw source footage -- and must never
// be scanned as if they need their own transcript. Skip this subfolder
// entirely wherever it's found, at any depth, under any parent.
const EXCLUDED_FOLDER_NAME = /^content\s+for\s+socials?$/i;

// `skipped` is an optional array the caller can pass in to collect every
// non-folder file that did NOT match VIDEO_EXTS, so nothing silently
// vanishes from the scan with no trace. (Previously these were just dropped
// with zero log output -- the cause of an 11-video gap going unnoticed.)
async function listAllVideos(drive, folderId, folderPath, skipped) {
  const results = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageSize: 200,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const file of res.data.files) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        if (EXCLUDED_FOLDER_NAME.test(file.name.trim())) {
          console.log(`   ⏭️  Skipping "${folderPath ? folderPath + '/' : ''}${file.name}" (Content for Socials — edited output, not source footage).`);
          continue;
        }
        const sub = folderPath ? `${folderPath}/${file.name}` : file.name;
        results.push(...await listAllVideos(drive, file.id, sub, skipped));
      } else if (VIDEO_EXTS.has(path.extname(file.name).toLowerCase())) {
        results.push({ ...file, folderPath: folderPath || '' });
      } else if (skipped) {
        skipped.push({ name: file.name, mimeType: file.mimeType, folderPath: folderPath || '' });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return results;
}

// ─── ffmpeg ───────────────────────────────────────────────────────────────────

function findFfmpeg() {
  for (const bin of ['ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) {
    try { execSync(`"${bin}" -version`, { stdio: 'ignore' }); return bin; } catch {}
  }
  try {
    const s = require('ffmpeg-static');
    if (s && fs.existsSync(s)) return s;
  } catch {}
  return null;
}

// ffmpeg always logs the input's stream layout to stderr while probing, even on
// success, e.g. "Stream #0:1(eng): Audio: aac (...), 44100 Hz, stereo, ...".
// If that line never appears, the source file has no audio track at all.
function hasAudioStream(stderr) {
  return /Stream #\d+:\d+[^\n]*:\s*Audio:/i.test(stderr || '');
}

// Downloads the source video to a local temp file first, THEN runs ffmpeg
// against that local path (rather than piping the Drive stream straight into
// ffmpeg's stdin). This matters specifically for .MOV/.MP4 files: camera-native
// footage very commonly stores its metadata atom ("moov") at the END of the
// file rather than the front. ffmpeg's mov/mp4 demuxer needs random seek access
// to read a trailing moov atom -- a stdin pipe can't seek, so on some clips
// ffmpeg would "succeed" (exit 0) while only managing to decode a sliver of
// audio, producing a tiny/corrupt extract that AssemblyAI then rejects with a
// generic "Transcoding failed" error. A local file is fully seekable, which
// avoids this whole class of failure. Disk cost is temporary and bounded to
// one proxy video at a time, then deleted immediately after.
async function downloadToFile(drive, fileId, destPath, onProgress) {
  const driveRes = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytesReceived = 0;
    const startedAt = Date.now();
    const out = fs.createWriteStream(destPath);

    const cleanup = () => { clearTimeout(stallTimer); clearTimeout(maxTimer); };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { driveRes.data.destroy(); } catch {}
      try { out.destroy(); } catch {}
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    let stallTimer = setTimeout(
      () => fail(new Error(`Streaming stalled — no data received for ${STALL_TIMEOUT_MS / 1000}s`)),
      STALL_TIMEOUT_MS
    );
    const maxTimer = setTimeout(
      () => fail(new Error(`Streaming exceeded max duration of ${MAX_STREAM_MS / 60000} min`)),
      MAX_STREAM_MS
    );

    driveRes.data.on('data', chunk => {
      bytesReceived += chunk.length;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => fail(new Error(`Streaming stalled — no data received for ${STALL_TIMEOUT_MS / 1000}s`)),
        STALL_TIMEOUT_MS
      );
      if (onProgress) onProgress(bytesReceived, Date.now() - startedAt);
    });

    driveRes.data.pipe(out);
    driveRes.data.on('error', fail);
    out.on('error', fail);
    out.on('finish', succeed);
  });
}

function runFfmpegExtract(ffmpegBin, srcPath, audioPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin, [
      '-i', srcPath,
      '-vn', '-acodec', 'libmp3lame', '-ac', '1', '-ar', '16000', '-b:a', '32k',
      '-f', 'mp3', audioPath, '-y',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      if (code === 0) resolve({ stderr });
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
    });
    ff.on('error', reject);
  });
}

async function streamExtractAudio(drive, fileId, audioPath, ffmpegBin, onProgress) {
  const tmpVideoPath = audioPath + '.src.bin';
  try {
    await downloadToFile(drive, fileId, tmpVideoPath, onProgress);
    return await runFfmpegExtract(ffmpegBin, tmpVideoPath, audioPath);
  } finally {
    try { fs.unlinkSync(tmpVideoPath); } catch {}
  }
}

// ─── AssemblyAI ───────────────────────────────────────────────────────────────

const AAI = { authorization: ASSEMBLYAI_API_KEY };

async function transcribeAudio(audioPath) {
  const audioData = fs.readFileSync(audioPath);
  const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioData, {
    headers: { ...AAI, 'content-type': 'application/octet-stream' },
    timeout: 600000, maxBodyLength: Infinity,
  });
  const submitRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
    audio_url: uploadRes.data.upload_url,
    speaker_labels: true,
    language_code: 'en_us', // confirmed: all Norway 2026 footage is English
  }, { headers: AAI });

  const id = submitRes.data.id;
  for (let i = 0; i < 240; i++) {
    await sleep(5000);
    const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${id}`, { headers: AAI });
    const { status } = poll.data;
    if (status === 'completed') return poll.data;
    if (status === 'error') throw new Error(`AssemblyAI: ${poll.data.error}`);
  }
  throw new Error('AssemblyAI timed out after 20 min');
}

// ─── Title + speaker detection ────────────────────────────────────────────────

async function generateTitle(utterances) {
  if (!utterances?.length) return null;
  try {
    const sample = utterances.slice(0, 20).map(u => `${u.speaker}: ${u.text}`).join('\n');
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Generate a short descriptive title (5-10 words) for this video conversation. Capture who is speaking and the main topic. Examples: "Sara on SafetyWing mission and product integrity", "Team discussing remote work culture". Respond with ONLY the title, no quotes.\n\n${sample}`,
      }],
      max_tokens: 20,
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: 30000 });
    return res.data.choices[0].message.content.trim().replace(/['"]/g, '');
  } catch { return null; }
}

function detectNamesFromText(utterances) {
  const found = {};
  const patterns = [
    /\bI'?m\s+([A-Z][a-záéíóúñ]+)\b/,
    /\bmy name is\s+([A-Z][a-záéíóúñ]+)\b/i,
    /\bI am\s+([A-Z][a-záéíóúñ]+)\b/,
    /\bthis is\s+([A-Z][a-záéíóúñ]+)\b/i,
  ];
  for (const u of (utterances || []).slice(0, 30)) {
    if (found[u.speaker]) continue;
    for (const p of patterns) {
      const m = u.text.match(p);
      if (m?.[1]) { found[u.speaker] = m[1]; break; }
    }
  }
  return found;
}

function buildTranscript(aaiData, title, videoDriveId, sourceVideoName) {
  if (!aaiData.utterances?.length) {
    return {
      title,
      source_video: sourceVideoName,
      video_drive_id: videoDriveId,
      language: aaiData.language_code,
      speakers: {},
      transcript: [{ speaker: 'Speaker 1', text: aaiData.text || '', start_ms: 0, end_ms: 0 }],
    };
  }
  const names = detectNamesFromText(aaiData.utterances);
  const labelMap = {};
  let count = 1;
  const transcript = aaiData.utterances.map(u => {
    if (!labelMap[u.speaker]) labelMap[u.speaker] = names[u.speaker] || `Speaker ${count++}`;
    return { speaker: labelMap[u.speaker], text: u.text, start_ms: u.start, end_ms: u.end };
  });
  return {
    title,
    source_video: sourceVideoName,
    video_drive_id: videoDriveId,
    language: aaiData.language_code,
    speakers: labelMap,
    transcript,
  };
}

// ─── Drive uploads (best-effort, never blocks ingestion) ─────────────────────

async function uploadTranscriptToDrive(drive, folderId, fileName, data) {
  const { Readable } = require('stream');
  const stream = Readable.from([JSON.stringify(data, null, 2)]);
  const res = await drive.files.create({
    requestBody: { name: fileName, mimeType: 'application/json', parents: [folderId] },
    media: { mimeType: 'application/json', body: stream },
    supportsAllDrives: true,
    fields: 'id',
  });
  return res.data.id;
}

async function copyVideoToDrive(drive, sourceFileId, destFolderId, newName) {
  const safeTitle = newName.replace(/[^a-z0-9\s\-_,]/gi, '').trim().substring(0, 80);
  const res = await drive.files.copy({
    fileId: sourceFileId,
    requestBody: { name: safeTitle + '.mp4', parents: [destFolderId] },
    supportsAllDrives: true,
    fields: 'id, name',
  });
  return res.data;
}

// Renames the original source file in place -- same Drive file ID, just a new
// `name`, so the already-uploaded video (e.g. IMG_5542.MOV) ends up matching
// its transcript's title while staying exactly where the videographer put it.
async function renameVideoInPlace(drive, fileId, newName, originalExt) {
  const safeTitle = newName.replace(/[^a-z0-9\s\-_,]/gi, '').trim().substring(0, 80);
  const res = await drive.files.update({
    fileId,
    requestBody: { name: safeTitle + originalExt },
    supportsAllDrives: true,
    fields: 'id, name',
  });
  return res.data;
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

// text-embedding-3-small's hard limit is 8192 tokens. AssemblyAI normally
// breaks speech into many short utterances, so per-segment chunks are tiny --
// but every so often (single continuous speaker, no detected pauses) it
// returns ONE utterance for an entire long recording, and that segment's
// text alone can blow past 8192 tokens, which makes the whole video FAIL at
// the embedding step with "400 Invalid 'input[0]': maximum input length is
// 8192 tokens." (exactly what happened on the "Sarah discussing SafetyWings
// remote work culture" video). ~4 chars/token for English is the rule of
// thumb, so cap segment text well under that before it ever reaches OpenAI.
const EMBED_MAX_CHARS = 20000; // ≈5000 tokens — safe margin under the 8192 limit

// Splits long text on sentence boundaries (falls back to a hard cut if a
// single "sentence" is itself too long) so no single chunk ever risks
// tripping the embedding model's token limit.
function splitTextForEmbedding(text, maxChars = EMBED_MAX_CHARS) {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [text];
  const pieces = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      // A single "sentence" is itself too long (e.g. no punctuation at all) — hard-split it.
      if (current) { pieces.push(current); current = ''; }
      for (let i = 0; i < sentence.length; i += maxChars) pieces.push(sentence.slice(i, i + maxChars));
      continue;
    }
    if ((current + sentence).length > maxChars) {
      pieces.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function buildChunks(segments) {
  const chunks = [];
  for (const seg of segments) {
    if (!seg.text?.trim()) continue;
    const text = seg.text.trim();
    const pieces = splitTextForEmbedding(text);
    if (pieces.length > 1) {
      console.log(`  ⚠️  Segment text is ${text.length} chars (~${Math.ceil(text.length / 4)} tokens) — splitting into ${pieces.length} sub-chunks to stay under the embedding model's limit.`);
    }
    const totalDuration = (seg.end_ms ?? 0) - (seg.start_ms ?? 0);
    let charOffset = 0;
    for (const piece of pieces) {
      // Interpolate start/end proportionally by character position so
      // timestamp-jump in search still lands roughly in the right place.
      const pieceStartMs = (seg.start_ms ?? 0) + Math.round((charOffset / text.length) * totalDuration);
      charOffset += piece.length;
      const pieceEndMs = (seg.start_ms ?? 0) + Math.round((charOffset / text.length) * totalDuration);
      chunks.push({
        speaker_label: seg.speaker || null,
        text: piece.trim(),
        start_ms: pieces.length > 1 ? pieceStartMs : seg.start_ms,
        end_ms: pieces.length > 1 ? pieceEndMs : seg.end_ms,
        chunk_type: 'segment',
      });
    }
  }
  for (const windowMs of CHUNK_TARGETS_MS) {
    const stepMs = windowMs / 2;
    let windowStart = segments[0]?.start_ms ?? 0;
    const totalDuration = segments[segments.length - 1]?.end_ms ?? 0;
    while (windowStart < totalDuration) {
      const windowEnd = windowStart + windowMs;
      const included = segments.filter(
        s => s.start_ms >= windowStart && s.start_ms < windowEnd && s.text?.trim()
      );
      if (included.length > 0) {
        const chunkStart = included[0].start_ms;
        const chunkEnd   = included[included.length - 1].end_ms;
        const text       = included.map(s => s.text.trim()).join(' ');
        const duration   = chunkEnd - chunkStart;
        if (duration >= windowMs * 0.4 && duration <= windowMs * 1.6) {
          chunks.push({
            speaker_label: majoritySpeaker(included),
            text,
            start_ms: chunkStart,
            end_ms: chunkEnd,
            chunk_type: CHUNK_LABEL[windowMs],
          });
        }
      }
      windowStart += stepMs;
    }
  }
  return chunks;
}

function majoritySpeaker(segments) {
  const dur = {};
  for (const s of segments) {
    const spk = s.speaker || 'Unknown';
    dur[spk] = (dur[spk] || 0) + (s.end_ms - s.start_ms);
  }
  return Object.entries(dur).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

async function addEmbeddings(openai, chunks) {
  // Defensive backstop: buildChunks() should already keep every chunk under
  // EMBED_MAX_CHARS, but truncate here too in case a chunk ever slips through
  // (e.g. future chunking changes) so a single oversized chunk can never
  // again take down the whole video's embedding step with a 400 error.
  const results = chunks.map(c => {
    if (c.text.length > EMBED_MAX_CHARS) {
      console.log(`  ⚠️  Chunk still ${c.text.length} chars after splitting — hard-truncating before embedding (this shouldn't normally happen).`);
      return { ...c, text: c.text.slice(0, EMBED_MAX_CHARS) };
    }
    return c;
  });
  for (let i = 0; i < results.length; i += EMBED_BATCH_SIZE) {
    const batch = results.slice(i, i + EMBED_BATCH_SIZE);
    const res = await openai.embeddings.create({ model: EMBED_MODEL, input: batch.map(c => c.text) });
    const embeddings = res.data.sort((a, b) => a.index - b.index).map(e => e.embedding);
    for (let j = 0; j < batch.length; j++) results[i + j].embedding = embeddings[j];
    if (i + EMBED_BATCH_SIZE < results.length) await sleep(300);
  }
  return results;
}

// ─── Supabase ─────────────────────────────────────────────────────────────────
// Dedup key = the SOURCE proxy video's Drive file ID. This is known up front
// (before transcription), stable, and unique — unlike a title-derived slug.
// We use it as both the videos.id primary key and videos.video_drive_id.

async function getAlreadyProcessedIds(supabase) {
  const ids = new Set();
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase.from('videos').select('id').range(from, from + pageSize - 1);
    if (error) throw new Error(`videos select: ${error.message}`);
    for (const row of data) ids.add(row.id);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return ids;
}

async function upsertVideo(supabase, sourceFileId, fileName, segments, title, transcriptDriveId) {
  const totalDuration = segments[segments.length - 1]?.end_ms ?? 0;
  const speakerCount  = new Set(segments.map(s => s.speaker).filter(Boolean)).size;
  const { error } = await supabase.from('videos').upsert({
    id: sourceFileId,
    file_name: fileName,
    drive_file_id: transcriptDriveId,   // transcript JSON's Drive ID, if uploaded
    video_drive_id: sourceFileId,       // source video's Drive ID (for direct link)
    collection: COLLECTION,             // parent folder/event, e.g. "Norway 2026" — set by the wrapper script
    total_duration_ms: totalDuration,
    speaker_count: speakerCount,
    title,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`videos upsert: ${error.message}`);
}

async function upsertChunks(supabase, sourceFileId, chunks) {
  await supabase.from('transcript_chunks').delete().eq('video_id', sourceFileId);
  for (let i = 0; i < chunks.length; i += 50) {
    const batch = chunks.slice(i, i + 50).map(c => ({
      video_id:      sourceFileId,
      speaker_label: c.speaker_label,
      speaker_name:  null,
      text:          c.text,
      start_ms:      c.start_ms,
      end_ms:        c.end_ms,
      chunk_type:    c.chunk_type,
      embedding:     c.embedding,
    }));
    const { error } = await supabase.from('transcript_chunks').insert(batch);
    if (error) throw new Error(`chunks insert: ${error.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const runStart = Date.now();
  requireEnv();

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found (expected ffmpeg-static to provide it)');

  const drive    = buildDrive();
  const openai   = buildOpenAI();
  const supabase = buildSupabase();

  console.log(`\n🚀 process_new_videos.js — ${new Date().toISOString()}`);
  console.log(`   Proxies folder: ${PROXIES_FOLDER_ID}`);
  console.log(`   Collection:     ${COLLECTION || '(none set — rows will save with collection = null)'}`);
  console.log(`   Camera filter:  ${CAM_FOLDER_FILTER ? process.env.CAM_FOLDER_FILTER : '(none — all cameras)'}`);
  console.log(`   Max per run:    ${MAX_VIDEOS_PER_RUN}`);
  console.log(`   Time budget:    ${RUN_TIME_BUDGET_MS / 60000} min`);

  const driveEnabled = !!SHARED_DRIVE_FOLDER_ID;
  let transcriptsDriveFolderId = null;
  let videosDriveFolderId = null;
  const driveFolderCache = {};
  if (driveEnabled) {
    transcriptsDriveFolderId = await getOrCreateFolder(drive, 'Transcripts', SHARED_DRIVE_FOLDER_ID);
    videosDriveFolderId      = await getOrCreateFolder(drive, 'Videos', SHARED_DRIVE_FOLDER_ID);
  }
  // Mirrors the source video's actual subfolder path (e.g. "Day 2/Cam 1" or
  // "Norway/Bergen/Cam A") underneath `root`, creating nested folders as needed.
  // No assumption about naming convention — works for any structure.
  async function getDriveFolder(root, folderPath) {
    if (!folderPath) return root;
    const segments = folderPath.split('/').filter(Boolean);
    let parentId = root;
    let built = '';
    for (const seg of segments) {
      built = built ? `${built}/${seg}` : seg;
      const cacheKey = root + '::' + built;
      if (!driveFolderCache[cacheKey]) {
        driveFolderCache[cacheKey] = await getOrCreateFolder(drive, seg, parentId);
      }
      parentId = driveFolderCache[cacheKey];
    }
    return parentId;
  }

  console.log('\n📂 Scanning proxies folder...');
  const skippedFiles = [];
  const scanned = await listAllVideos(drive, PROXIES_FOLDER_ID, '', skippedFiles);
  console.log(`   Found ${scanned.length} videos total.`);
  if (skippedFiles.length) {
    console.log(`   ⚠️  Skipped ${skippedFiles.length} non-video file(s) (extension not recognized) — these were NOT counted or processed:`);
    for (const f of skippedFiles) console.log(`      - ${f.folderPath ? f.folderPath + '/' : ''}${f.name} (${f.mimeType})`);
  }

  const scoped = CAM_FOLDER_FILTER ? scanned.filter(v => CAM_FOLDER_FILTER.test(v.folderPath)) : scanned;
  if (CAM_FOLDER_FILTER) console.log(`   Matching camera filter: ${scoped.length}`);

  console.log('\n🔎 Checking Supabase for already-processed videos...');
  const processedIds = await getAlreadyProcessedIds(supabase);
  console.log(`   Already in Supabase: ${processedIds.size}`);

  const excludedCount = scoped.filter(v => !processedIds.has(v.id) && EXCLUDE_FILE_IDS.has(v.id)).length;
  if (excludedCount) console.log(`   Excluding ${excludedCount} known-duplicate file(s) via EXCLUDE_FILE_IDS.`);
  const unprocessed = scoped.filter(v => !processedIds.has(v.id) && !EXCLUDE_FILE_IDS.has(v.id));
  const todo = unprocessed.slice(0, MAX_VIDEOS_PER_RUN);
  console.log(`   To process this run: ${todo.length} (of ${unprocessed.length} unprocessed total)\n`);

  if (unprocessed.length > todo.length) {
    console.log('🚨'.repeat(20));
    console.log(`🚨 MAX_VIDEOS_PER_RUN cap (${MAX_VIDEOS_PER_RUN}) is smaller than the backlog.`);
    console.log(`🚨 ${unprocessed.length - todo.length} video(s) will be LEFT UNPROCESSED after this run.`);
    console.log('🚨 Run this script again (or raise MAX_VIDEOS_PER_RUN) until this warning disappears.');
    console.log('🚨'.repeat(20) + '\n');
  }

  if (todo.length === 0) {
    console.log('✅ Nothing new to process.');
    return { processed: 0, failed: 0, stillRemaining: 0, skipped: skippedFiles.length };
  }

  let processed = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < todo.length; i++) {
    if (Date.now() - runStart > RUN_TIME_BUDGET_MS) {
      console.log(`\n⏱  Time budget reached — stopping early. Remaining videos will be picked up next run.`);
      break;
    }

    const video = todo[i];
    const sizeMB = video.size ? `${(parseInt(video.size) / 1024 / 1024).toFixed(0)}MB` : '?';
    const baseName = path.basename(video.name, path.extname(video.name));
    // Used for Drive output organization and the optional local backup — mirrors
    // wherever the video actually lives under the source folder.
    const folderLabel = video.folderPath || 'Misc';

    console.log(`[${i + 1}/${todo.length}] ${video.folderPath}/${video.name} (${sizeMB}MB)`);
    const tmpAudio = path.join(os.tmpdir(), baseName + '_' + video.id.slice(0, 6) + '.mp3');

    try {
      process.stdout.write('  🎵 Extracting audio');
      let lastLog = 0;
      const { stderr: extractLog } = await streamExtractAudio(drive, video.id, tmpAudio, ffmpeg, (bytes, elapsedMs) => {
        if (elapsedMs - lastLog > 15000) {
          lastLog = elapsedMs;
          process.stdout.write(`\n     ... ${(bytes / 1024 / 1024).toFixed(0)}MB received (${(elapsedMs / 1000).toFixed(0)}s)`);
        }
      });
      const audioBytes = fs.statSync(tmpAudio).size;
      console.log(`\n     done (${(audioBytes / 1024 / 1024).toFixed(1)}MB audio)`);

      const sourceHasAudio = hasAudioStream(extractLog);
      let aaiData;
      if (sourceHasAudio && audioBytes >= MIN_USABLE_AUDIO_BYTES) {
        process.stdout.write('  🎙️  Transcribing...');
        aaiData = await transcribeAudio(tmpAudio);
        fs.unlinkSync(tmpAudio);
        console.log(` ${aaiData.utterances?.length || 0} utterances`);
      } else {
        fs.unlinkSync(tmpAudio);
        const reason = sourceHasAudio ? 'audio track present but effectively empty' : 'no audio track in source video';
        console.log(`  ⚠️  Skipping transcription (${reason}) — saving with no dialogue.`);
        aaiData = { utterances: [], text: '', language_code: null };
      }

      process.stdout.write('  💡 Title...');
      const title = await generateTitle(aaiData.utterances) || baseName.replace(/[_-]/g, ' ');
      console.log(` "${title}"`);
      const safeTitle = title.replace(/[^a-z0-9\s\-,]/gi, '').trim().substring(0, 80);

      const transcriptData = buildTranscript(aaiData, title, video.id, video.name);
      const segments = transcriptData.transcript;

      if (LOCAL_BACKUP_DIR) {
        try {
          const dir = path.join(LOCAL_BACKUP_DIR, ...folderLabel.split('/'));
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, safeTitle + '.json'), JSON.stringify(transcriptData, null, 2));
        } catch (e) { console.log(`  ⚠️  local backup failed: ${e.message}`); }
      }

      let transcriptDriveId = null;
      if (driveEnabled) {
        try {
          const destFolder = await getDriveFolder(transcriptsDriveFolderId, folderLabel);
          transcriptDriveId = await uploadTranscriptToDrive(drive, destFolder, safeTitle + '.json', transcriptData);
        } catch (e) { console.log(`  ⚠️  transcript Drive upload failed: ${e.message}`); }
        if (COPY_VIDEO_TO_DRIVE) {
          try {
            const destFolder = await getDriveFolder(videosDriveFolderId, folderLabel);
            await copyVideoToDrive(drive, video.id, destFolder, safeTitle);
          } catch (e) { console.log(`  ⚠️  video Drive copy failed: ${e.message}`); }
        }
        if (RENAME_VIDEO_IN_PLACE) {
          try {
            const originalExt = path.extname(video.name);
            await renameVideoInPlace(drive, video.id, safeTitle, originalExt);
            console.log(`  ✏️  Renamed video to "${safeTitle}${originalExt}"`);
          } catch (e) { console.log(`  ⚠️  video rename failed: ${e.message}`); }
        }
      }

      process.stdout.write('  🧩 Chunking + embedding...');
      const rawChunks = buildChunks(segments);
      const chunks = await addEmbeddings(openai, rawChunks);
      console.log(` ${chunks.length} chunks`);

      process.stdout.write('  💾 Saving to Supabase...');
      await upsertVideo(supabase, video.id, video.name, segments, title, transcriptDriveId);
      await upsertChunks(supabase, video.id, chunks);
      console.log(' ✓');

      console.log(`  ✅ Done\n`);
      processed++;

    } catch (err) {
      console.log(`\n  ❌ FAILED: ${err.message}\n`);
      if (fs.existsSync(tmpAudio)) { try { fs.unlinkSync(tmpAudio); } catch {} }
      failures.push({ name: video.name, error: err.message });
      failed++;
    }

    await sleep(500);
  }

  console.log('═'.repeat(60));
  console.log(`Run complete. Processed: ${processed} | Failed: ${failed}`);
  if (failures.length) {
    console.log('Failures (will retry automatically next run, since Supabase has no row for them):');
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
  }
  const stillRemaining = unprocessed.length - processed - failed;
  if (stillRemaining > 0) {
    console.log(`🚨 ${stillRemaining} video(s) from this folder are STILL UNPROCESSED. Run this script again.`);
  } else if (skippedFiles.length) {
    console.log(`ℹ️  Note: ${skippedFiles.length} file(s) in this folder were skipped for not matching a recognized video extension — see warning above.`);
  } else {
    console.log('✅ Everything in this folder has been processed.');
  }
  console.log('═'.repeat(60));

  return { processed, failed, stillRemaining, skipped: skippedFiles.length };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
}

module.exports = { main };
