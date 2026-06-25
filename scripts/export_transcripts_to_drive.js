/**
 * export_transcripts_to_drive.js
 *
 * One-off export: pulls every transcript currently saved in Supabase and
 * uploads it as a labeled JSON file into a target Drive folder, organized
 * into "Day X" subfolders (looked up by walking each source video's actual
 * Drive parent folders). Falls back to a "Misc" subfolder if no Day label
 * can be found.
 *
 * Does NOT touch Supabase or re-transcribe anything — pure export of what's
 * already there.
 *
 * Run:
 *   TARGET_DRIVE_FOLDER_ID=1TM8zQGcoU6dBYB2efoFoJM_Rs6B1UHrQ node scripts/export_transcripts_to_drive.js
 *
 * Requires: the target folder must be shared with the service account
 * (safetywing-transcription@safetywing-transcription.iam.gserviceaccount.com)
 * with at least Editor access, since this script writes files into it.
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { Readable } = require('stream');
const { findDayLabel: findDayLabelShared, sleep } = require('./lib/findDayLabel');

// Service accounts can't own files in a personal "My Drive" folder (zero quota),
// so this must point at something inside a Shared Drive. Defaults to the
// existing Shared Drive root (SHARED_DRIVE_FOLDER_ID) and writes into its
// "Transcripts" subfolder — the same one process_new_videos.js already uses.
const TARGET_DRIVE_FOLDER_ID = process.env.TARGET_DRIVE_FOLDER_ID || process.env.SHARED_DRIVE_FOLDER_ID;

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

async function getAllVideos(supabase) {
  const all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('videos')
      .select('id, file_name, title, video_drive_id')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`videos select: ${error.message}`);
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function getSegmentsForVideo(supabase, videoId) {
  const { data, error } = await supabase
    .from('transcript_chunks')
    .select('speaker_label, text, start_ms, end_ms')
    .eq('video_id', videoId)
    .eq('chunk_type', 'segment')
    .order('start_ms', { ascending: true });
  if (error) throw new Error(`chunks select: ${error.message}`);
  return data;
}

async function fileExistsInFolder(drive, folderId, fileName) {
  const safeName = fileName.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name='${safeName}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files.length > 0;
}

async function uploadJsonToDrive(drive, folderId, fileName, data) {
  const stream = Readable.from([JSON.stringify(data, null, 2)]);
  const res = await drive.files.create({
    requestBody: { name: fileName, mimeType: 'application/json', parents: [folderId] },
    media: { mimeType: 'application/json', body: stream },
    supportsAllDrives: true,
    fields: 'id',
  });
  return res.data.id;
}

async function main() {
  if (!TARGET_DRIVE_FOLDER_ID) throw new Error('Set TARGET_DRIVE_FOLDER_ID env var');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');

  const drive = buildDrive();
  const supabase = buildSupabase();
  const dayCache = new Map();
  const folderCache = new Map();

  const transcriptsRootId = await getOrCreateFolder(drive, 'Transcripts', TARGET_DRIVE_FOLDER_ID);

  console.log(`\nShared Drive root: ${TARGET_DRIVE_FOLDER_ID}`);
  console.log(`Writing into: Transcripts/ (${transcriptsRootId})`);
  console.log('Fetching videos from Supabase...');
  const videos = await getAllVideos(supabase);
  console.log(`Found ${videos.length} videos.\n`);

  let done = 0, failed = 0, skipped = 0;

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const label = video.title || video.file_name || video.id;
    process.stdout.write(`[${i + 1}/${videos.length}] ${label} `);

    try {
      const segments = await getSegmentsForVideo(supabase, video.id);
      if (!segments.length) {
        console.log('— no transcript chunks, skipping.');
        skipped++;
        continue;
      }

      const transcript = segments.map(s => ({
        speaker: s.speaker_label,
        text: s.text,
        start_ms: s.start_ms,
        end_ms: s.end_ms,
      }));

      const dayLabel = video.video_drive_id
        ? await findDayLabelShared(drive, video.video_drive_id, dayCache, { verbose: false })
        : 'Misc';

      if (!folderCache.has(dayLabel)) {
        folderCache.set(dayLabel, await getOrCreateFolder(drive, dayLabel, transcriptsRootId));
      }
      const destFolderId = folderCache.get(dayLabel);

      const safeTitle = (video.title || video.file_name || video.id)
        .replace(/[^a-z0-9\s\-,]/gi, '').trim().substring(0, 80) || video.id;
      const fileName = safeTitle + '.json';

      if (await fileExistsInFolder(drive, destFolderId, fileName)) {
        console.log(`⏭️  already exists in ${dayLabel}, skipping.`);
        skipped++;
        continue;
      }

      const transcriptData = {
        title: video.title || null,
        source_video: video.file_name,
        video_drive_id: video.video_drive_id,
        transcript,
      };

      await uploadJsonToDrive(drive, destFolderId, fileName, transcriptData);
      console.log(`✅ (${dayLabel})`);
      done++;

    } catch (err) {
      console.log(`❌ FAILED: ${err.message}`);
      failed++;
    }

    await sleep(80); // throttle to avoid tripping Drive API rate limits
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Export complete. Uploaded: ${done} | Skipped: ${skipped} | Failed: ${failed}`);
  console.log('='.repeat(50));
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
