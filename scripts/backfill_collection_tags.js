/**
 * backfill_collection_tags.js
 *
 * The "collection" column (videos.collection) was just added so the search
 * UI can filter results to one parent folder/event (Norway 2026, SF Content
 * Week 2026, Webinars). Every video ingested AFTER this change gets tagged
 * automatically by its wrapper script (process_norway_videos.js etc. now set
 * COLLECTION before calling process_new_videos.js). This script is the
 * one-time backfill for every row ingested BEFORE that -- they all currently
 * have collection = null.
 *
 * Strategy: for each of the four known source folders, recursively scan
 * Drive for video file IDs, then update every Supabase videos row whose id
 * matches one of those file IDs (id == source video's Drive file ID, per
 * process_new_videos.js's dedup key).
 *
 *   - Norway 2026/Videos                     -> "Norway 2026"
 *   - SF Content Week 2026/Videos            -> "SF Content Week 2026"
 *   - Webinars/Videos                        -> "Webinars"
 *   - legacy Proxies folder (Day 1-4, Cam 1-4) -> "SF Content Week 2026"
 *     (color_correct_cam1.js writes its corrected copies of this footage
 *     into SF Content Week 2026/Videos, so this legacy footage belongs in
 *     the same collection from the filter's point of view)
 *
 * Read + update only -- no downloads, no ffmpeg, no transcription. Safe to
 * re-run; it only ever sets collection for rows it can positively match,
 * and re-running just re-confirms the same tags.
 *
 * Any existing row whose id doesn't show up in any of the four scans is left
 * alone (collection stays null) and gets printed at the end so you can see
 * what's still untagged.
 *
 * Run:
 *   node scripts/backfill_collection_tags.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.mts', '.m4v', '.mxf']);

const SOURCES = [
  { folderId: '1E9nAnRKL4XnpdykJD__WC17HvIo0szAO', collection: 'Norway 2026' },             // Norway 2026/Videos
  { folderId: '1Y8ZxO3Ck5a68FZq580ioGdpGQyXqx0Hn', collection: 'SF Content Week 2026' },    // SF Content Week 2026/Videos
  { folderId: '1M1YdA7ILePOSq3gAe34D--GQhyLs-SD1', collection: 'Webinars' },                // Webinars/Videos
  { folderId: '1bYXP6wsUrfmefU8KHgRG6musui4W019D', collection: 'SF Content Week 2026' },    // legacy Proxies folder (Day 1-4, all cams)
];

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

// Skip "Content for Socials" subfolders, same convention as process_new_videos.js --
// those are edited output, not source footage, and shouldn't be tagged here either
// (they have no Supabase row anyway, but skipping keeps the scan fast and consistent).
const EXCLUDED_FOLDER_NAME = /^content\s+for\s+socials?$/i;

async function listVideoIds(drive, folderId) {
  const ids = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 200,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const file of res.data.files) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        if (EXCLUDED_FOLDER_NAME.test(file.name.trim())) continue;
        ids.push(...await listVideoIds(drive, file.id));
      } else if (VIDEO_EXTS.has(path.extname(file.name).toLowerCase())) {
        ids.push(file.id);
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return ids;
}

async function getAllVideoRowIds(supabase) {
  const ids = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    // video_drive_id is needed too -- a batch of legacy rows (ingested before
    // the dedup-by-Drive-file-ID rewrite) use a filename-derived slug as their
    // primary key (e.g. "CODC3_0002_1") instead of the actual Drive file ID,
    // so matching on `id` alone misses them. Their real current Drive file ID
    // (if it's been linked via match_legacy_videos.js) lives in video_drive_id.
    const { data, error } = await supabase.from('videos').select('id, collection, video_drive_id').range(from, from + pageSize - 1);
    if (error) throw new Error(`videos select: ${error.message}`);
    ids.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return ids;
}

async function main() {
  const drive = buildDrive();
  const supabase = buildSupabase();

  console.log('Loading existing Supabase video rows...');
  const allRows = await getAllVideoRowIds(supabase);
  console.log(`Found ${allRows.length} total video rows.\n`);

  // Map each Drive file ID to its target collection. If a file ID appears in
  // more than one source folder (shouldn't happen, but be defensive), first
  // match wins and a warning is printed.
  const idToCollection = new Map();

  for (const { folderId, collection } of SOURCES) {
    console.log(`Scanning ${collection} (${folderId})...`);
    const ids = await listVideoIds(drive, folderId);
    console.log(`   Found ${ids.length} video file(s).`);
    for (const id of ids) {
      if (idToCollection.has(id) && idToCollection.get(id) !== collection) {
        console.log(`   ⚠️  ${id} already mapped to "${idToCollection.get(id)}", skipping conflicting "${collection}" tag.`);
        continue;
      }
      idToCollection.set(id, collection);
    }
  }
  console.log(`\nTotal distinct video file IDs across all sources: ${idToCollection.size}\n`);

  let updated = 0, alreadyTagged = 0, untaggable = 0;
  const untaggedRows = [];

  for (const row of allRows) {
    // Try the row's id first (the normal case -- id IS the Drive file ID),
    // then fall back to video_drive_id for legacy slug-keyed rows.
    const collection = idToCollection.get(row.id) || (row.video_drive_id && idToCollection.get(row.video_drive_id));
    if (!collection) {
      untaggable++;
      untaggedRows.push(row.id);
      continue;
    }
    if (row.collection === collection) {
      alreadyTagged++;
      continue;
    }
    const { error } = await supabase.from('videos').update({ collection }).eq('id', row.id);
    if (error) {
      console.log(`   ❌ Failed to update ${row.id}: ${error.message}`);
      continue;
    }
    updated++;
  }

  console.log('═'.repeat(60));
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`Updated this run     : ${updated}`);
  console.log(`Already correctly tagged : ${alreadyTagged}`);
  console.log(`Could not match to a known source folder : ${untaggable}`);
  if (untaggedRows.length) {
    console.log('\nThese row IDs are not in any of the 4 known source folders (left untagged):');
    for (const id of untaggedRows.slice(0, 50)) console.log(`  - ${id}`);
    if (untaggedRows.length > 50) console.log(`  ... and ${untaggedRows.length - 50} more`);
  }
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
