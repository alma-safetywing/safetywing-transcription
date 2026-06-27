/**
 * process_legacy_cam1_backfill.js
 *
 * Backfills transcription for the Cam 1/Day 1-4 source files in the legacy
 * "Proxies" Drive folder that have NEVER been transcribed at all -- confirmed
 * via match_legacy_videos.js (only 1 orphaned Supabase row exists, so this
 * isn't a linking problem) and diagnose_unmatched_cam1.js + check_zero_duration_files.js
 * (70 unmatched files split into 16 literal Drive duplicates of already-
 * transcribed footage, and 54 genuinely untranscribed real files, all
 * confirmed to have real byte content despite some reporting a 0.0s duration
 * in Drive's cached video metadata).
 *
 * This is a thin wrapper around process_new_videos.js, same pattern as
 * process_norway_videos.js / process_sf_content_week_videos.js:
 *   - Points PROXIES_FOLDER_ID at the legacy Proxies folder.
 *   - Scopes CAM_FOLDER_FILTER to Day 1-4 AND Cam 1 only (matches the explicit
 *     decision to keep this Cam 1-only for now).
 *   - Computes the 16 known-duplicate file IDs itself (same duration-match
 *     logic as diagnose_unmatched_cam1.js) and passes them via EXCLUDE_FILE_IDS
 *     so they don't get transcribed a second time under a new ID.
 *   - Leaves SHARED_DRIVE_FOLDER_ID unset: this backfill only needs a Supabase
 *     videos + transcript_chunks row to exist so color_correct_cam1.js can find
 *     it and produce the corrected copy in SF Content Week 2026/Videos. No
 *     extra transcript-JSON upload or video copy/rename in the legacy folder.
 *   - Loops main() until nothing's left, since one call caps at MAX_VIDEOS_PER_RUN.
 *
 * This is real transcription (AssemblyAI + GPT-4o-mini + OpenAI embeddings)
 * across 54 files, several multi-GB -- expect real time and API cost. Safe to
 * interrupt and re-run: dedup is by Supabase row (source Drive file ID).
 *
 * Run:
 *   node scripts/process_legacy_cam1_backfill.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const SOURCE_FOLDER_ID = '1bYXP6wsUrfmefU8KHgRG6musui4W019D'; // legacy Proxies folder (Day 1-4 + Cam 1, etc.)
const DAY_FILTER = /\bday\s*[1-4]\b/i;
const CAM_FILTER = /\bcam\s*1\b/i;
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.mts', '.m4v', '.mxf']);
const TIGHT_TOLERANCE_MS = 1500;

function buildDrive() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}
function buildSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function listCandidates(drive, folderId, folderPath) {
  const results = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, videoMediaMetadata)',
      pageSize: 200,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const file of res.data.files) {
      const sub = folderPath ? `${folderPath}/${file.name}` : file.name;
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        results.push(...await listCandidates(drive, file.id, sub));
      } else if (VIDEO_EXTS.has(path.extname(file.name).toLowerCase())) {
        if (DAY_FILTER.test(sub) && CAM_FILTER.test(sub)) {
          const durationMs = file.videoMediaMetadata?.durationMillis
            ? parseInt(file.videoMediaMetadata.durationMillis, 10) : null;
          results.push({ id: file.id, name: file.name, folderPath: sub, durationMs });
        }
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return results;
}

// Re-derives the same "likely Drive duplicate" set diagnose_unmatched_cam1.js
// reported, so the exclude list is always computed fresh against current
// Supabase + Drive state rather than a hardcoded, potentially-stale ID list.
async function computeDuplicateIds(drive, supabase) {
  const candidates = await listCandidates(drive, SOURCE_FOLDER_ID, '');
  const ids = candidates.map(c => c.id);
  const { data: linkedRows, error } = await supabase
    .from('videos')
    .select('id, title, file_name, video_drive_id, total_duration_ms')
    .in('video_drive_id', ids);
  if (error) throw new Error(`videos lookup failed: ${error.message}`);

  const linkedIds = new Set(linkedRows.map(r => r.video_drive_id));
  const linkedDurations = linkedRows.filter(r => r.total_duration_ms != null).map(r => r.total_duration_ms);

  const duplicateIds = [];
  for (const c of candidates) {
    if (linkedIds.has(c.id) || c.durationMs == null) continue;
    const isDuplicate = linkedDurations.some(d => Math.abs(d - c.durationMs) <= TIGHT_TOLERANCE_MS);
    if (isDuplicate) duplicateIds.push(c.id);
  }
  return { totalCandidates: candidates.length, alreadyLinked: linkedIds.size, duplicateIds };
}

async function run() {
  const drive = buildDrive();
  const supabase = buildSupabase();

  console.log('Computing known-duplicate file IDs to exclude from this backfill...');
  const { totalCandidates, alreadyLinked, duplicateIds } = await computeDuplicateIds(drive, supabase);
  console.log(`Found ${totalCandidates} Cam 1/Day 1-4 candidates, ${alreadyLinked} already linked, ${duplicateIds.length} known duplicates excluded.\n`);

  process.env.PROXIES_FOLDER_ID = SOURCE_FOLDER_ID;
  process.env.CAM_FOLDER_FILTER = '(?=.*\\bday\\s*[1-4]\\b)(?=.*\\bcam\\s*1\\b)';
  process.env.EXCLUDE_FILE_IDS = duplicateIds.join(',');
  delete process.env.SHARED_DRIVE_FOLDER_ID; // Supabase-only backfill; color_correct_cam1.js handles the corrected output copy.
  process.env.COPY_VIDEO_TO_DRIVE = 'false';
  process.env.RENAME_VIDEO_IN_PLACE = 'false';
  // Tags rows so the search UI's folder filter groups this with the rest of
  // the SF event -- color_correct_cam1.js writes its corrected copies of this
  // same footage into "SF Content Week 2026 > Videos", so filtering by that
  // collection should surface this legacy footage too.
  process.env.COLLECTION = 'SF Content Week 2026';

  const { main } = require('./process_new_videos');

  const MAX_PASSES = 25;
  let totalProcessed = 0, totalFailed = 0;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    console.log(`\n========== Legacy Cam 1 backfill — pass ${pass} ==========`);
    const result = await main();
    totalProcessed += result.processed;
    totalFailed += result.failed;

    if (result.stillRemaining === 0) {
      console.log(`\n✅ All legacy Cam 1/Day 1-4 backfill videos processed. Totals — processed: ${totalProcessed}, failed: ${totalFailed}.`);
      console.log('Next: run scripts/color_correct_cam1.js --apply to produce corrected copies for these new transcripts.');
      return;
    }
    if (result.processed === 0) {
      console.log(`\n🚨 No forward progress this pass (${result.stillRemaining} still unprocessed, every attempt failed). Stopping — check FAILED messages above.`);
      return;
    }
  }
  console.log(`\n⚠️  Hit the safety cap of ${MAX_PASSES} passes. Run this script again to continue.`);
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
