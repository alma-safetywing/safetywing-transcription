/**
 * export_videos_for_days.js
 *
 * One-off export: copies each video's actual source file (the original
 * proxy in Drive, referenced by videos.video_drive_id in Supabase) into:
 *
 *   Videos/SF Content Week 2026/Day X/
 *
 * named with the exact same base filename as its transcript JSON in
 * Transcripts/SF Content Week 2026/Day X/ — so every transcript has a
 * matching video sitting right next to it (in the parallel Videos/ tree).
 *
 * Only copies videos that actually have a transcript in Supabase (so the
 * pairing is always 1:1). Skips any video that already has a file in its
 * destination folder, so it's safe to re-run. Copying (not moving) leaves
 * the original source file and its Drive file ID untouched — no effect on
 * dedup or future pipeline runs.
 *
 * Run:
 *   node scripts/export_videos_for_days.js          # all videos, every day
 *   node scripts/export_videos_for_days.js 1 3       # only Day 1 and Day 3
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { findDayLabel, sleep } = require('./lib/findDayLabel');

const SHARED_DRIVE_FOLDER_ID = process.env.SHARED_DRIVE_FOLDER_ID;
const SUBFOLDER_PATH = ['Videos', 'SF Content Week 2026'];
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

async function hasTranscript(supabase, videoId) {
  const { count, error } = await supabase
    .from('transcript_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('video_id', videoId)
    .eq('chunk_type', 'segment');
  if (error) throw new Error(`chunks count: ${error.message}`);
  return (count || 0) > 0;
}

// Same algorithm used by the transcript export scripts — keeps base
// filenames identical between Transcripts/ and Videos/.
function safeTitleFor(video) {
  return (video.title || video.file_name || video.id)
    .replace(/[^a-z0-9\s\-,]/gi, '').trim().substring(0, 80) || video.id;
}

async function copyVideoToDrive(drive, sourceFileId, destFolderId, fileName) {
  const res = await drive.files.copy({
    fileId: sourceFileId,
    requestBody: { name: fileName, parents: [destFolderId] },
    supportsAllDrives: true,
    fields: 'id, name',
  });
  return res.data;
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

  console.log('Fetching videos from Supabase...');
  const videos = await getAllVideos(supabase);
  console.log(`Found ${videos.length} videos total.`);
  console.log(exportAll ? 'Exporting all days.\n' : `Filtering to ${askedDays.join(', ')}...\n`);

  let done = 0, failed = 0, skippedNoTranscript = 0, skippedExisting = 0, skippedNoSource = 0, notMatched = 0;

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const day = video.video_drive_id
      ? await findDayLabel(drive, video.video_drive_id, dayCache, { verbose: false })
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
      const hasT = await hasTranscript(supabase, video.id);
      if (!hasT) {
        console.log('— no transcript yet, skipping (videos only get copied if a transcript exists).');
        skippedNoTranscript++;
        await sleep(80);
        continue;
      }

      if (!video.video_drive_id) {
        console.log('— no source video_drive_id stored, skipping.');
        skippedNoSource++;
        await sleep(80);
        continue;
      }

      if (!folderCache.has(dayFolderName)) {
        folderCache.set(dayFolderName, await getOrCreateFolder(drive, dayFolderName, rootId));
      }
      const destFolderId = folderCache.get(dayFolderName);

      const fileName = safeTitleFor(video) + '.mp4';

      if (await fileExistsInFolder(drive, destFolderId, fileName)) {
        console.log('⏭️  already exists, skipping.');
        skippedExisting++;
        await sleep(80);
        continue;
      }

      await copyVideoToDrive(drive, video.video_drive_id, destFolderId, fileName);
      console.log('✅');
      done++;

    } catch (err) {
      console.log(`❌ FAILED: ${err.message}`);
      failed++;
    }

    await sleep(80); // throttle to avoid tripping Drive API rate limits
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Export complete. Copied: ${done} | Already existed: ${skippedExisting} | No transcript: ${skippedNoTranscript} | No source file: ${skippedNoSource} | Failed: ${failed}${exportAll ? '' : ` | Other days skipped: ${notMatched}`}`);
  console.log(`Location: Videos/SF Content Week 2026/<Day X>/ (or /Misc for unresolved days)`);
  console.log('='.repeat(50));
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
