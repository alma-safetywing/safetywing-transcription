/**
 * export_transcripts_for_days.js
 *
 * One-off export: pulls transcripts from Supabase and uploads them as
 * labeled JSON files into:
 *
 *   Transcripts/SF Content Week 2026/Day X/
 *
 * (under the existing Shared Drive). Creates "Day X" subfolders as needed.
 * Videos whose day can't be resolved land in a "Misc" subfolder instead of
 * being silently dropped. Skips any video that already has a file in its
 * destination folder, so it's safe to re-run. Does NOT touch Supabase or
 * re-transcribe — pure export of what's already there.
 *
 * Day resolution uses scripts/lib/findDayLabel.js, which retries on Drive
 * API rate-limit errors instead of giving up after one failed call — with
 * 71 videos × up to 6 parent lookups each, an unguarded version of this
 * walk previously mislabeled 52/71 videos "Unknown" purely from rate
 * limiting, not because their day was actually unresolvable.
 *
 * Run:
 *   node scripts/export_transcripts_for_days.js          # all videos, every day
 *   node scripts/export_transcripts_for_days.js 1 3       # only Day 1 and Day 3
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { Readable } = require('stream');
const { findDayLabel, sleep } = require('./lib/findDayLabel');

const SHARED_DRIVE_FOLDER_ID = process.env.SHARED_DRIVE_FOLDER_ID;
const SUBFOLDER_PATH = ['Transcripts', 'SF Content Week 2026'];
const askedDays = process.argv.slice(2).map(d => `Day ${d}`); // empty = all days

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
  if (!SHARED_DRIVE_FOLDER_ID) throw new Error('Missing SHARED_DRIVE_FOLDER_ID');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');

  const exportAll = askedDays.length === 0;
  const drive = buildDrive();
  const supabase = buildSupabase();
  const dayCache = new Map();
  const folderCache = new Map();

  console.log(`Locating ${SUBFOLDER_PATH.join('/')} under Shared Drive ${SHARED_DRIVE_FOLDER_ID}...`);
  let parentId = SHARED_DRIVE_FOLDER_ID;
  for (const seg of SUBFOLDER_PATH) {
    parentId = await getOrCreateFolder(drive, seg, parentId);
  }
  const rootId = parentId;
  console.log(`Root folder: ${rootId}\n`);

  if (!exportAll) {
    console.log(`Creating/finding day subfolders: ${askedDays.join(', ')}`);
    for (const day of askedDays) {
      folderCache.set(day, await getOrCreateFolder(drive, day, rootId));
    }
  }

  console.log('\nFetching videos from Supabase...');
  const videos = await getAllVideos(supabase);
  console.log(`Found ${videos.length} videos total.`);
  console.log(exportAll ? 'Exporting all days.\n' : `Filtering to ${askedDays.join(', ')}...\n`);

  let done = 0, failed = 0, skippedNoTranscript = 0, skippedExisting = 0, notMatched = 0;

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const day = video.video_drive_id
      ? await findDayLabel(drive, video.video_drive_id, dayCache, { verbose: true })
      : 'Unknown';
    const dayFolderName = day === 'Unknown' ? 'Misc' : day;

    if (!exportAll && !askedDays.includes(day)) {
      notMatched++;
      await sleep(80);
      continue;
    }

    const label = video.title || video.file_name || video.id;
    process.stdout.write(`[${dayFolderName}] ${label} `);

    try {
      const segments = await getSegmentsForVideo(supabase, video.id);
      if (!segments.length) {
        console.log('— no transcript chunks, skipping.');
        skippedNoTranscript++;
        await sleep(80);
        continue;
      }

      const transcript = segments.map(s => ({
        speaker: s.speaker_label,
        text: s.text,
        start_ms: s.start_ms,
        end_ms: s.end_ms,
      }));

      if (!folderCache.has(dayFolderName)) {
        folderCache.set(dayFolderName, await getOrCreateFolder(drive, dayFolderName, rootId));
      }
      const destFolderId = folderCache.get(dayFolderName);

      const safeTitle = (video.title || video.file_name || video.id)
        .replace(/[^a-z0-9\s\-,]/gi, '').trim().substring(0, 80) || video.id;
      const fileName = safeTitle + '.json';

      if (await fileExistsInFolder(drive, destFolderId, fileName)) {
        console.log('⏭️  already exists, skipping.');
        skippedExisting++;
        await sleep(80);
        continue;
      }

      const transcriptData = {
        title: video.title || null,
        source_video: video.file_name,
        video_drive_id: video.video_drive_id,
        transcript,
      };

      await uploadJsonToDrive(drive, destFolderId, fileName, transcriptData);
      console.log('✅');
      done++;

    } catch (err) {
      console.log(`❌ FAILED: ${err.message}`);
      failed++;
    }

    await sleep(80); // throttle to avoid tripping Drive API rate limits
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Export complete. Uploaded: ${done} | Already existed: ${skippedExisting} | No transcript: ${skippedNoTranscript} | Failed: ${failed}${exportAll ? '' : ` | Other days skipped: ${notMatched}`}`);
  console.log(`Location: Transcripts/SF Content Week 2026/<Day X>/ (or /Misc for unresolved days)`);
  console.log('='.repeat(50));
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
