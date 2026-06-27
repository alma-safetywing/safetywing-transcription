/**
 * organize_and_transcribe.js
 *
 * Does everything in one pass:
 *   1. Scans all videos in the proxies folder (all days, all cameras)
 *   2. Transcribes each with AssemblyAI (speaker diarization)
 *   3. Generates an intuitive title with GPT-4o-mini
 *   4. Creates an organized Drive folder: "SafetyWing Flight Week / Day X / ..."
 *   5. Copies each video there, renamed to the intuitive title
 *   6. Saves transcript JSON (same name as video) with video_drive_id embedded
 *   7. Saves progress locally so it can resume if interrupted
 *
 * After this runs:
 *   node scripts/ingest_transcripts.js
 *
 * Run:
 *   node scripts/organize_and_transcribe.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { spawn, execSync } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────

const PROXIES_FOLDER_ID     = process.env.PROXIES_FOLDER_ID    || '1bYXP6wsUrfmefU8KHgRG6musui4W019D';
const TRANSCRIPT_FOLDER_ID  = process.env.TRANSCRIPT_FOLDER_ID;
const SHARED_DRIVE_FOLDER_ID = process.env.SHARED_DRIVE_FOLDER_ID || TRANSCRIPT_FOLDER_ID;
const ASSEMBLYAI_API_KEY    = process.env.ASSEMBLYAI_API_KEY   || '76ee7730d1d54c17a49c924f1137122e';
const OPENAI_API_KEY        = process.env.OPENAI_API_KEY;
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.mts', '.m4v', '.mxf']);
const PROGRESS_FILE = path.join(__dirname, 'transcription_progress.json');
const CAM_FILTER = /\bcam\s*1\b/i; // scope: Cam 1 only, all days

// ─── Progress tracking ────────────────────────────────────────────────────────
// Keyed by source video Drive file ID — survives renames and restarts.

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { return {}; }
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ─── Drive client ─────────────────────────────────────────────────────────────

function buildDrive() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// ─── Drive folder helpers ─────────────────────────────────────────────────────

async function getOrCreateFolder(drive, name, parentId) {
  // Check if folder already exists
  const res = await drive.files.list({
    q: `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (res.data.files.length > 0) return res.data.files[0].id;

  // Create it
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    supportsAllDrives: true,
    fields: 'id',
  });
  return created.data.id;
}

async function getProxiesFolderParent(drive, proxiesFolderId) {
  const res = await drive.files.get({
    fileId: proxiesFolderId,
    fields: 'parents',
    supportsAllDrives: true,
  });
  return res.data.parents?.[0] || null;
}

// ─── Video scanning ───────────────────────────────────────────────────────────

async function listAllVideos(drive, folderId, folderPath) {
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
        const sub = folderPath ? `${folderPath}/${file.name}` : file.name;
        console.log(`  📁 ${sub}/`);
        results.push(...await listAllVideos(drive, file.id, sub));
      } else if (VIDEO_EXTS.has(path.extname(file.name).toLowerCase())) {
        results.push({ ...file, folderPath: folderPath || '' });
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

const STALL_TIMEOUT_MS = 90 * 1000;      // no bytes received for 90s = genuinely stalled
const MAX_STREAM_MS    = 30 * 60 * 1000; // absolute safety cap for pathological cases

async function streamExtractAudio(drive, fileId, audioPath, ffmpegBin, onProgress) {
  const driveRes = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytesReceived = 0;
    const startedAt = Date.now();

    const ff = spawn(ffmpegBin, [
      '-i', 'pipe:0',
      '-vn', '-acodec', 'libmp3lame', '-ac', '1', '-ar', '16000', '-b:a', '32k',
      '-f', 'mp3', audioPath, '-y',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const cleanup = () => {
      clearTimeout(stallTimer);
      clearTimeout(maxTimer);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { ff.kill('SIGKILL'); } catch {}
      try { driveRes.data.destroy(); } catch {}
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    // Stall timer — resets every time data arrives. Only fires if the connection truly stops.
    let stallTimer = setTimeout(
      () => fail(new Error(`Streaming stalled — no data received for ${STALL_TIMEOUT_MS / 1000}s`)),
      STALL_TIMEOUT_MS
    );

    // Absolute safety cap — covers pathological cases (e.g. ffmpeg hangs after stream ends)
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

    driveRes.data.pipe(ff.stdin);
    driveRes.data.on('error', fail);
    ff.stdin.on('error', () => {});
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      if (code === 0) succeed();
      else fail(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
    });
    ff.on('error', fail);
  });
}

// ─── AssemblyAI ───────────────────────────────────────────────────────────────

const AAI = { authorization: ASSEMBLYAI_API_KEY };

async function transcribeAudio(audioPath) {
  // Upload
  const audioData = fs.readFileSync(audioPath);
  const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioData, {
    headers: { ...AAI, 'content-type': 'application/octet-stream' },
    timeout: 600000, maxBodyLength: Infinity,
  });

  // Submit with speaker diarization
  const submitRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
    audio_url: uploadRes.data.upload_url,
    speaker_labels: true,
  }, { headers: AAI });

  // Poll
  const id = submitRes.data.id;
  for (let i = 0; i < 240; i++) {
    await sleep(5000);
    const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${id}`, { headers: AAI });
    const { status } = poll.data;
    process.stdout.write(`\r  ⏳ ${status} (${i * 5}s)   `);
    if (status === 'completed') { process.stdout.write('\n'); return poll.data; }
    if (status === 'error') throw new Error(`AssemblyAI: ${poll.data.error}`);
  }
  throw new Error('Timed out after 20 min');
}

// ─── Title generation ─────────────────────────────────────────────────────────

async function generateTitle(utterances) {
  if (!OPENAI_API_KEY || !utterances?.length) return null;
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

// ─── Speaker detection ────────────────────────────────────────────────────────

// Name detection lives in scripts/lib/speaker_names.js — shared with every
// other transcription entry point so a fix only has to be made once instead
// of drifting out of sync across copy-pasted versions (which is what
// happened: this file already excluded third-person intros like "this is
// Sara", but process_new_videos.js and transcribe_videos.js still had the
// old, buggier pattern set). The shared version also fixes a first-match-
// wins bug where a single false positive (e.g. "I'm Head of People..."
// capturing "Head") permanently locked out a real self-intro found later in
// the same conversation, by scoring every candidate across the whole
// transcript instead of stopping at the first hit.
const { detectNamesFromUtterances } = require('./lib/speaker_names');
function detectNamesFromText(utterances) {
  return detectNamesFromUtterances(utterances);
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

// ─── Save transcript locally ───────────────────────────────────────────────────

function saveTranscriptLocally(dayLabel, fileName, data) {
  const transcriptsDir = path.join(__dirname, 'transcripts', dayLabel);
  fs.mkdirSync(transcriptsDir, { recursive: true });
  const filePath = path.join(transcriptsDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.error('\n❌  ffmpeg not found. Run: npm install ffmpeg-static\n');
    process.exit(1);
  }

  const drive = buildDrive();
  const progress = loadProgress();

  // Local transcripts output dir (always saved here for ingest)
  const transcriptsRoot = path.join(__dirname, 'transcripts');
  fs.mkdirSync(transcriptsRoot, { recursive: true });
  console.log(`\n📁  Transcripts will be saved locally to: scripts/transcripts/`);

  // Drive folders (only works with Shared Drive where service account is a member)
  const driveFolderCache = {};
  const driveEnabled = !!SHARED_DRIVE_FOLDER_ID;
  if (driveEnabled) {
    console.log(`    Drive upload enabled → Shared Drive folder: ${SHARED_DRIVE_FOLDER_ID}`);
  } else {
    console.log(`    Drive upload disabled (set SHARED_DRIVE_FOLDER_ID to enable)`);
  }

  // Lazy-create Day subfolders inside Transcripts/ and Videos/ on the Shared Drive
  let transcriptsDriveFolderId = null;
  let videosDriveFolderId = null;
  if (driveEnabled) {
    transcriptsDriveFolderId = await getOrCreateFolder(drive, 'Transcripts', SHARED_DRIVE_FOLDER_ID);
    videosDriveFolderId      = await getOrCreateFolder(drive, 'Videos',      SHARED_DRIVE_FOLDER_ID);
    console.log(`    Transcripts subfolder ready`);
    console.log(`    Videos subfolder ready`);
  }

  async function getDriveFolder(root, dayLabel) {
    const key = root + '_' + dayLabel;
    if (!driveFolderCache[key]) {
      driveFolderCache[key] = await getOrCreateFolder(drive, dayLabel, root);
    }
    return driveFolderCache[key];
  }

  // Scan all videos
  console.log('\n📂  Scanning proxies folder...');
  const scanned = await listAllVideos(drive, PROXIES_FOLDER_ID, '');
  console.log(`\n    Found ${scanned.length} videos total (all cameras).`);

  // Scope to Cam 1 only, all 4 days
  const allVideos = scanned.filter(v => CAM_FILTER.test(v.folderPath));
  console.log(`    Cam 1 videos (all days): ${allVideos.length}`);

  // Filter already done
  const todo = allVideos.filter(v => !progress[v.id]?.done);
  const done = allVideos.length - todo.length;
  console.log(`    Already done: ${done}`);
  console.log(`    To process:   ${todo.length}\n`);

  if (todo.length === 0) {
    console.log('✅  All videos transcribed!');
    console.log('    Run: node scripts/ingest_transcripts.js');
    return;
  }

  let transcribed = 0, failed = 0;

  for (let i = 0; i < todo.length; i++) {
    const video = todo[i];
    const sizeMB = video.size ? `${(parseInt(video.size)/1024/1024).toFixed(0)}MB` : '?';
    const baseName = path.basename(video.name, path.extname(video.name));

    // Determine day label from folder path (e.g. "Day 1/Cam 1" → "Day 1")
    const dayMatch = video.folderPath.match(/day\s*\d+/i);
    const dayLabel = dayMatch ? dayMatch[0].replace(/\s+/g, ' ').replace(/day\s/i, 'Day ') : 'Day Unknown';

    console.log(`\n[${i + 1}/${todo.length}] ${video.folderPath}/${video.name} (${sizeMB}MB)`);

    const tmpAudio = path.join(os.tmpdir(), baseName + '_' + video.id.slice(0,6) + '.mp3');

    try {
      // Stream extract audio (logs progress every ~10s so large files don't look stuck)
      process.stdout.write('  🎵 Extracting audio (streaming)');
      let lastLog = 0;
      await streamExtractAudio(drive, video.id, tmpAudio, ffmpeg, (bytes, elapsedMs) => {
        if (elapsedMs - lastLog > 10000) {
          lastLog = elapsedMs;
          process.stdout.write(`\n     ... ${(bytes / 1024 / 1024).toFixed(0)}MB received (${(elapsedMs / 1000).toFixed(0)}s)`);
        }
      });
      const audioMB = (fs.statSync(tmpAudio).size / 1024 / 1024).toFixed(1);
      console.log(`\n     done — extracted ${audioMB}MB of audio`);

      // Transcribe
      process.stdout.write('  🎙️  Transcribing with AssemblyAI...\n');
      const aaiData = await transcribeAudio(tmpAudio);
      fs.unlinkSync(tmpAudio);

      // Generate title
      process.stdout.write('  💡 Generating title...');
      const title = await generateTitle(aaiData.utterances) || baseName.replace(/[_-]/g, ' ');
      console.log(` "${title}"`);

      const safeTitle = title.replace(/[^a-z0-9\s\-,]/gi, '').trim().substring(0, 80);

      // Build transcript JSON with original video's Drive file ID for direct linking
      const transcriptData = buildTranscript(aaiData, title, video.id, video.name);
      const transcriptFileName = safeTitle + '.json';

      // 1. Always save locally
      process.stdout.write(`  💾 Saving locally...`);
      const savedPath = saveTranscriptLocally(dayLabel, transcriptFileName, transcriptData);
      console.log(` ✓`);

      let transcriptDriveId = null;
      let copiedVideoId = null;

      if (driveEnabled) {
        // 2. Upload transcript JSON to Shared Drive → Transcripts/Day X/
        const transcriptDayFolder = await getDriveFolder(transcriptsDriveFolderId, dayLabel);
        process.stdout.write(`  ☁️  Uploading transcript to Drive...`);
        try {
          transcriptDriveId = await uploadTranscriptToDrive(drive, transcriptDayFolder, transcriptFileName, transcriptData);
          console.log(` ✓`);
        } catch (e) {
          console.log(` ⚠️  ${e.message.includes('quota') ? 'quota error — is this a Shared Drive?' : e.message}`);
        }

        // 3. Copy video to Shared Drive → Videos/Day X/
        const videoDayFolder = await getDriveFolder(videosDriveFolderId, dayLabel);
        process.stdout.write(`  📹 Copying video to Drive...`);
        try {
          const copied = await copyVideoToDrive(drive, video.id, videoDayFolder, safeTitle);
          copiedVideoId = copied.id;
          console.log(` ✓ "${copied.name}"`);
        } catch (e) {
          console.log(` ⚠️  ${e.message.includes('quota') ? 'quota error — is this a Shared Drive?' : e.message}`);
        }
      }

      // Save progress
      progress[video.id] = {
        done: true,
        title,
        safeTitle,
        dayLabel,
        transcriptFileName,
        localPath: savedPath,
        transcriptDriveId,
        copiedVideoId,
        utterances: aaiData.utterances?.length || 0,
      };
      saveProgress(progress);

      console.log(`  ✅ ${aaiData.utterances?.length || 0} utterances | ${Object.keys(transcriptData.speakers).length} speakers`);
      transcribed++;

    } catch (err) {
      console.log(`\n  ❌ FAILED: ${err.message}`);
      if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio);
      progress[video.id] = { done: false, error: err.message, name: video.name };
      saveProgress(progress);
      failed++;
    }

    await sleep(500);
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`Done. Transcribed: ${transcribed} | Failed: ${failed}`);
  console.log(`Local transcripts: scripts/transcripts/`);
  console.log('═'.repeat(60));

  if (transcribed > 0) {
    console.log(`\n👉  Next: node scripts/ingest_transcripts_local.js`);
  }

  if (failed > 0) {
    const failedVideos = Object.entries(progress)
      .filter(([, v]) => !v.done && v.error)
      .map(([, v]) => `  - ${v.name}: ${v.error}`);
    console.log('\nFailed videos (can retry by running script again):');
    console.log(failedVideos.join('\n'));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
