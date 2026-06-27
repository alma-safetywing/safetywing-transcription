/**
 * color_correct_cam1.js
 *
 * One-off, on-demand script (not part of the automatic pipeline). Replaces
 * the manual CapCut round-trip for SF Content Week Cam 1 footage across
 * Day 1, 2, 3, and 4:
 *
 *   1. Scans the Proxies folder (SOURCE_FOLDER_ID — confirmed by the user as
 *      https://drive.google.com/drive/u/0/folders/1bYXP6wsUrfmefU8KHgRG6musui4W019D,
 *      same ID organize_and_transcribe.js already defaults to as its
 *      PROXIES_FOLDER_ID) for every Cam 1 file under any Day 1-4 subfolder.
 *   2. For each one, looks up its matching Supabase `videos` row by
 *      video_drive_id (the same link match_legacy_videos.js already
 *      established) to get its title/transcript and confirm it actually
 *      has a transcript — videos with no transcript match are skipped, not
 *      guessed at.
 *   3. Streams the source video straight from Drive through ffmpeg, applying
 *      your LUT file as a color-correction filter, and re-encodes to mp4
 *      locally (no manual CapCut step).
 *   4. Uploads the corrected file directly into:
 *        SafetyWing Content (shared drive) / SF Content Week 2026 / Videos
 *      (PROXIES_FOLDER_ID — the same folder the live pipeline already uploads
 *      new SF Content Week footage into, flat, no Day subfolders), named
 *      identically to its transcript (same safeTitleFor() algorithm
 *      export_videos_for_days.js uses), REPLACING any existing uncorrected
 *      copy already sitting there.
 *
 * From here, you upload directly from that Drive folder into Opus Clip —
 * no CapCut, no extra download/upload round trip.
 *
 * SETUP:
 *   Add to your .env (PROXIES_FOLDER_ID, GOOGLE_SERVICE_ACCOUNT_JSON,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY are already set for the live pipeline
 *   — only LUT_FILE_PATH is new):
 *     LUT_FILE_PATH=/absolute/path/to/your-color-correction.cube
 *
 *   Install deps if needed: npm install googleapis @supabase/supabase-js dotenv
 *   Needs ffmpeg on PATH (or `npm install ffmpeg-static`) — same as the rest
 *   of the pipeline.
 *
 * SAFE BY DEFAULT — this only lists what it would do until you pass --apply:
 *   node scripts/color_correct_cam1.js              # dry run / report only
 *   node scripts/color_correct_cam1.js --apply       # actually process + upload
 *
 * Resumable: progress is saved to scripts/color_correction_progress.json,
 * keyed by source file ID, so re-running after an interruption skips
 * whatever already finished.
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────

const SOURCE_FOLDER_ID = '1bYXP6wsUrfmefU8KHgRG6musui4W019D'; // Proxies folder — user-confirmed URL, matches organize_and_transcribe.js's default PROXIES_FOLDER_ID
// Destination: SafetyWing Content shared drive / SF Content Week 2026 / Videos.
// Reuses the SAME env var the live pipeline (process_sf_content_week_videos.js)
// already points at this exact folder with — no path reconstruction, no
// risk of creating a duplicate-nested folder.
const DEST_FOLDER_ID = process.env.PROXIES_FOLDER_ID;
const LUT_FILE_PATH = process.env.LUT_FILE_PATH;
const DAY_FILTER = /\bday\s*[1-4]\b/i; // any of Day 1, 2, 3, 4
const CAM_FILTER = /\bcam\s*1\b/i;
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.mts', '.m4v', '.mxf']);
const PROGRESS_FILE = path.join(__dirname, 'color_correction_progress.json');
const APPLY = process.argv.includes('--apply');

// ─── Progress tracking (keyed by source Drive file ID) ──────────────────────

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { return {}; }
}
function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// ─── Drive / Supabase clients ─────────────────────────────────────────────────

function buildDrive() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

function buildSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
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

// Escape an absolute path for safe use inside an ffmpeg filtergraph argument
// (lut3d=filename='...'). Backslashes, colons, and single quotes all need
// escaping inside the quoted filter value.
function escapeForFilterArg(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

const STALL_TIMEOUT_MS = 90 * 1000;
const MAX_STREAM_MS = 4 * 60 * 60 * 1000; // raised from 60 min — some full-res source files run well past an hour to download+encode

// Streams a Drive file straight into ffmpeg's stdin and writes the
// LUT-corrected, re-encoded result to a local path. Same stall-detection
// approach as organize_and_transcribe.js's streamExtractAudio, generalized
// for video instead of audio-only extraction.
async function streamColorCorrect(drive, fileId, outputPath, ffmpegBin, lutPath, onProgress) {
  const driveRes = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  const lutArg = `lut3d=file='${escapeForFilterArg(lutPath)}'`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let bytesReceived = 0;
    const startedAt = Date.now();

    const ff = spawn(ffmpegBin, [
      '-i', 'pipe:0',
      '-vf', lutArg,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-c:a', 'copy',
      outputPath, '-y',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const cleanup = () => { clearTimeout(stallTimer); clearTimeout(maxTimer); };
    const fail = (err) => {
      if (settled) return;
      settled = true; cleanup();
      try { ff.kill('SIGKILL'); } catch {}
      try { driveRes.data.destroy(); } catch {}
      reject(err);
    };
    const succeed = () => { if (settled) return; settled = true; cleanup(); resolve(); };

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

    driveRes.data.pipe(ff.stdin);
    driveRes.data.on('error', fail);
    ff.stdin.on('error', () => {});
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      if (code === 0) succeed();
      else fail(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
    ff.on('error', fail);
  });
}

// ─── Drive folder helpers ─────────────────────────────────────────────────────

async function getOrCreateFolder(drive, name, parentId) {
  const safeName = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name='${safeName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
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

async function findExistingFile(drive, folderId, fileName) {
  const safeName = fileName.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name='${safeName}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files[0] || null;
}

async function uploadFile(drive, localPath, destFolderId, fileName) {
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [destFolderId] },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(localPath) },
    supportsAllDrives: true,
    fields: 'id, name',
  });
  return res.data;
}

// ─── Scan Day 1 / Cam 1 proxy videos ──────────────────────────────────────────

async function listDay1Cam1Videos(drive, folderId, folderPath) {
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
      const sub = folderPath ? `${folderPath}/${file.name}` : file.name;
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        results.push(...await listDay1Cam1Videos(drive, file.id, sub));
      } else if (VIDEO_EXTS.has(path.extname(file.name).toLowerCase())) {
        if (DAY_FILTER.test(sub) && CAM_FILTER.test(sub)) {
          results.push({ ...file, folderPath: sub });
        }
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return results;
}

// ─── Supabase lookups ─────────────────────────────────────────────────────────

// Transient network blips (e.g. "fetch failed", DNS hiccups during a long
// unattended run) used to crash the entire multi-hour batch on whatever file
// happened to be next. Retry a few times with backoff before giving up.
async function withRetry(fn, label, retries = 3, delayMs = 2000) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        console.log(`\n     ⚠️  ${label} failed (attempt ${attempt}/${retries}: ${err.message}), retrying in ${delayMs / 1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
        delayMs *= 2;
      }
    }
  }
  throw lastErr;
}

async function findVideoByDriveId(supabase, driveFileId) {
  return withRetry(async () => {
    const { data, error } = await supabase
      .from('videos')
      .select('id, title, file_name, video_drive_id')
      .eq('video_drive_id', driveFileId)
      .limit(1);
    if (error) throw new Error(`videos lookup failed: ${error.message}`);
    return data[0] || null;
  }, 'videos lookup');
}

// Records the corrected copy's Drive file ID on the video row so the search
// app's "Open video" link points at it instead of the raw original. Without
// this, the upload above happens but nothing ever tells Supabase about it --
// which was the actual bug: corrected files were landing in Drive, but every
// search result kept linking to the uncorrected source video forever.
async function recordCorrectedDriveId(supabase, videoId, correctedDriveId) {
  return withRetry(async () => {
    const { error } = await supabase
      .from('videos')
      .update({ color_corrected_drive_id: correctedDriveId })
      .eq('id', videoId);
    if (error) throw new Error(`videos update (color_corrected_drive_id) failed: ${error.message}`);
  }, 'color_corrected_drive_id update');
}

async function hasTranscript(supabase, videoId) {
  return withRetry(async () => {
    const { count, error } = await supabase
      .from('transcript_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('video_id', videoId)
      .eq('chunk_type', 'segment');
    if (error) throw new Error(`chunks count failed: ${error.message}`);
    return (count || 0) > 0;
  }, 'transcript chunks lookup');
}

// Same algorithm export_videos_for_days.js uses, so filenames line up exactly
// with the existing Transcripts/ tree.
function safeTitleFor(video) {
  return (video.title || video.file_name || video.id)
    .replace(/[^a-z0-9\s\-,]/gi, '').trim().substring(0, 80) || video.id;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(APPLY ? '🔴  LIVE MODE — files will be processed and uploaded.\n' : '🟡  DRY RUN — listing only, nothing will be processed or uploaded. Pass --apply to run.\n');

  if (!DEST_FOLDER_ID) throw new Error('Missing PROXIES_FOLDER_ID in .env (this is the SF Content Week 2026/Videos destination folder)');
  if (!LUT_FILE_PATH) throw new Error('Missing LUT_FILE_PATH in .env — set it to the absolute path of your .cube file');
  if (!fs.existsSync(LUT_FILE_PATH)) throw new Error(`LUT file not found at: ${LUT_FILE_PATH}`);

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found. Run: npm install ffmpeg-static');

  const drive = buildDrive();
  const supabase = buildSupabase();
  const progress = loadProgress();

  console.log(`LUT file: ${LUT_FILE_PATH}`);
  console.log(`Scanning ${SOURCE_FOLDER_ID} for Cam 1 proxy videos across Day 1-4...\n`);
  const candidates = await listDay1Cam1Videos(drive, SOURCE_FOLDER_ID, '');
  console.log(`Found ${candidates.length} video file(s) under a Day 1-4 + Cam 1 path.\n`);

  if (candidates.length === 0) {
    console.log('Nothing to do — check SOURCE_FOLDER_ID / folder naming if this is unexpected.');
    return;
  }

  const destFolderId = DEST_FOLDER_ID; // SF Content Week 2026/Videos — already exists, no creation needed
  console.log(`Destination: SF Content Week 2026/Videos (${destFolderId})\n`);

  let matched = 0, skippedNoMatch = 0, skippedNoTranscript = 0, skippedDone = 0, processed = 0, failed = 0;

  // Two different source files can end up generating the same title (seen in
  // practice — duplicate Drive proxies, or generic GPT titles like "A on X").
  // Without tracking this, the delete-then-upload step below would silently
  // overwrite an earlier video with a later one sharing the same name,
  // collapsing two distinct transcripts down to a single surviving file.
  // Pre-seed with everything already-done from a past run so cross-run
  // collisions are caught too, not just collisions within this run.
  const claimedNames = new Map(); // destFileName -> source file.id that claimed it
  for (const [sourceId, entry] of Object.entries(progress)) {
    if (entry?.done && entry.destFileName) claimedNames.set(entry.destFileName, sourceId);
  }

  for (const file of candidates) {
    process.stdout.write(`[${file.folderPath}] `);

    let video;
    try {
      video = await findVideoByDriveId(supabase, file.id);
    } catch (err) {
      console.log(`— Supabase lookup failed after retries (${err.message}), skipping this run (will retry next run).`);
      failed++;
      continue;
    }
    if (!video) {
      console.log('— no matching Supabase video row (video_drive_id not linked), skipping.');
      skippedNoMatch++;
      continue;
    }
    let okTranscript;
    try {
      okTranscript = await hasTranscript(supabase, video.id);
    } catch (err) {
      console.log(`— transcript-chunks lookup failed after retries (${err.message}), skipping this run (will retry next run).`);
      failed++;
      continue;
    }
    if (!okTranscript) {
      console.log(`— matched "${video.title}" but it has no transcript chunks, skipping.`);
      skippedNoTranscript++;
      continue;
    }
    matched++;

    const baseDestFileName = safeTitleFor(video) + '.mp4';
    let destFileName = baseDestFileName;
    const claimedBy = claimedNames.get(destFileName);
    if (claimedBy && claimedBy !== file.id) {
      const disambiguator = path.basename(file.name, path.extname(file.name));
      destFileName = `${baseDestFileName.replace(/\.mp4$/, '')} (${disambiguator}).mp4`;
      console.log(`⚠️  title collision with another source file (already claimed by ${claimedBy}) — disambiguating as "${destFileName}"`);
    }
    claimedNames.set(destFileName, file.id);

    if (!APPLY) {
      console.log(`would process → "${destFileName}"`);
      continue;
    }

    if (progress[file.id]?.done) {
      console.log(`already done (${progress[file.id].destFileName}), skipping.`);
      skippedDone++;
      continue;
    }

    const tmpOut = path.join(os.tmpdir(), `cc_${file.id.slice(0, 8)}.mp4`);

    try {
      process.stdout.write(`color-correcting → "${destFileName}" `);
      let lastLog = 0;
      await streamColorCorrect(drive, file.id, tmpOut, ffmpeg, LUT_FILE_PATH, (bytes, elapsedMs) => {
        if (elapsedMs - lastLog > 15000) {
          lastLog = elapsedMs;
          process.stdout.write(`\n     ... ${(bytes / 1024 / 1024).toFixed(0)}MB read (${(elapsedMs / 1000).toFixed(0)}s)`);
        }
      });
      console.log('\n     ✓ encoded locally');

      const existing = await findExistingFile(drive, destFolderId, destFileName);
      if (existing) {
        process.stdout.write('     replacing existing copy in Drive...');
        try {
          await drive.files.delete({ fileId: existing.id, supportsAllDrives: true });
          console.log(' ✓ deleted old copy');
        } catch (delErr) {
          // Already gone (404) or some other transient issue — not fatal.
          // The upload below still gets the corrected file into place either way.
          console.log(` ⚠️  couldn't delete old copy (${delErr.message}) — continuing anyway`);
        }
      }

      process.stdout.write('     uploading corrected file...');
      const uploaded = await uploadFile(drive, tmpOut, destFolderId, destFileName);
      console.log(' ✓');

      process.stdout.write('     linking corrected copy in Supabase...');
      try {
        await recordCorrectedDriveId(supabase, video.id, uploaded.id);
        console.log(' ✓');
      } catch (linkErr) {
        // The corrected file is safely in Drive either way -- this only means
        // the search app will keep linking to the raw original until it's
        // retried. Don't fail the whole run over it.
        console.log(` ⚠️  couldn't link in Supabase (${linkErr.message}) — corrected file is still in Drive, re-run to retry the link.`);
      }

      fs.unlinkSync(tmpOut);
      progress[file.id] = { done: true, destFileName, processedAt: new Date().toISOString() };
      saveProgress(progress);
      processed++;

    } catch (err) {
      console.log(`\n     ❌ FAILED: ${err.message}`);
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
      progress[file.id] = { done: false, error: err.message };
      saveProgress(progress);
      failed++;
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log(APPLY ? 'Run complete.' : 'Dry run complete — nothing was processed.');
  console.log(`  Matched to a transcript : ${matched}`);
  console.log(`  ${APPLY ? 'Processed' : 'Would process'}        : ${APPLY ? processed : matched - skippedDone}`);
  if (APPLY) console.log(`  Already done (skipped) : ${skippedDone}`);
  console.log(`  No Supabase match       : ${skippedNoMatch}`);
  console.log(`  No transcript yet       : ${skippedNoTranscript}`);
  if (APPLY) console.log(`  Failed                  : ${failed}`);
  console.log('═'.repeat(60));
  if (!APPLY) console.log('\nRe-run with --apply to actually process and upload these.');
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
