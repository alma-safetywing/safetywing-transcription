/**
 * diagnose_transcript_gap.js
 *
 * Read-only diagnostic: explains a mismatch between "N videos in Supabase"
 * and "M transcript files in Drive" by cross-referencing:
 *   1. Every video row in Supabase, whether it actually has transcript_chunks,
 *      and which "Day X" folder it's from (via its source Drive file's parents).
 *   2. Every JSON file that actually exists anywhere under the Shared Drive's
 *      Transcripts/ folder (recursively, any depth), with its day folder.
 *
 * Then prints a per-day table: Supabase count (with transcript) vs Drive
 * file count, so you can see exactly which days are missing and why
 * (no transcript yet vs. never exported).
 *
 * Run:
 *   node scripts/diagnose_transcript_gap.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { findDayLabel, sleep } = require('./lib/findDayLabel');

const SHARED_DRIVE_FOLDER_ID = process.env.SHARED_DRIVE_FOLDER_ID;

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

async function findFolderByName(drive, name, parentId) {
  const safeName = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name='${safeName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files[0]?.id || null;
}

async function listChildren(drive, folderId) {
  const all = [];
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
    all.push(...res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

// Recursively walk every folder under `folderId`, collecting every
// non-folder file along with its day-folder label (first ancestor segment
// matching /day\s*\d+/i, else the immediate parent folder name).
async function walkTranscripts(drive, folderId, pathSoFar, out) {
  const children = await listChildren(drive, folderId);
  for (const child of children) {
    const childPath = pathSoFar.concat(child.name);
    if (child.mimeType === 'application/vnd.google-apps.folder') {
      await walkTranscripts(drive, child.id, childPath, out);
    } else {
      const dayMatch = childPath.find(seg => /day\s*\d+/i.test(seg));
      const day = dayMatch ? dayMatch.replace(/.*?(day\s*\d+).*/i, '$1').replace(/\s+/g, ' ').replace(/day\s/i, 'Day ') : (pathSoFar[pathSoFar.length - 1] || 'Transcripts root');
      out.push({ name: child.name, path: childPath.join('/'), day });
    }
  }
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

async function countChunksForVideo(supabase, videoId) {
  const { count, error } = await supabase
    .from('transcript_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('video_id', videoId)
    .eq('chunk_type', 'segment');
  if (error) throw new Error(`chunks count: ${error.message}`);
  return count || 0;
}

async function main() {
  if (!SHARED_DRIVE_FOLDER_ID) throw new Error('Missing SHARED_DRIVE_FOLDER_ID');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');

  const drive = buildDrive();
  const supabase = buildSupabase();
  const dayCache = new Map();
  const errorSamples = new Map(); // "code message" -> { count, examples: [] }

  console.log('--- Step 1: Supabase side ---');
  const videos = await getAllVideos(supabase);
  console.log(`Total video rows in Supabase: ${videos.length}\n`);

  const supabaseByDay = new Map(); // day -> { withChunks: [], withoutChunks: [] }
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    process.stdout.write(`\r  Checking ${i + 1}/${videos.length}...`);
    const day = v.video_drive_id
      ? await findDayLabel(drive, v.video_drive_id, dayCache, {
          verbose: false,
          onError: (fileId, err) => {
            const code = err.code || err.response?.status || 'ERR';
            const key = `${code} ${err.message}`;
            if (!errorSamples.has(key)) errorSamples.set(key, { count: 0, examples: [] });
            const entry = errorSamples.get(key);
            entry.count++;
            if (entry.examples.length < 3) entry.examples.push(v.title || v.file_name || fileId);
          },
        })
      : 'Unknown';
    const chunkCount = await countChunksForVideo(supabase, v.id);
    await sleep(80); // throttle to avoid tripping Drive API rate limits over 71 videos
    if (!supabaseByDay.has(day)) supabaseByDay.set(day, { withChunks: [], withoutChunks: [] });
    if (chunkCount > 0) supabaseByDay.get(day).withChunks.push(v);
    else supabaseByDay.get(day).withoutChunks.push(v);
  }
  console.log('\n');

  console.log('--- Step 2: Drive side (recursive scan of Transcripts/) ---');
  const transcriptsRootId = await findFolderByName(drive, 'Transcripts', SHARED_DRIVE_FOLDER_ID);
  if (!transcriptsRootId) throw new Error('Could not find "Transcripts" folder under SHARED_DRIVE_FOLDER_ID');
  const driveFiles = [];
  await walkTranscripts(drive, transcriptsRootId, [], driveFiles);
  console.log(`Total files found anywhere under Transcripts/: ${driveFiles.length}\n`);

  const driveByDay = new Map();
  for (const f of driveFiles) {
    if (!driveByDay.has(f.day)) driveByDay.set(f.day, []);
    driveByDay.get(f.day).push(f);
  }

  console.log('='.repeat(70));
  console.log('PER-DAY BREAKDOWN');
  console.log('='.repeat(70));
  const allDays = new Set([...supabaseByDay.keys(), ...driveByDay.keys()]);
  const sortedDays = [...allDays].sort();
  let totalWithChunks = 0, totalNoChunks = 0, totalDriveFiles = 0;

  for (const day of sortedDays) {
    const sb = supabaseByDay.get(day) || { withChunks: [], withoutChunks: [] };
    const dr = driveByDay.get(day) || [];
    totalWithChunks += sb.withChunks.length;
    totalNoChunks += sb.withoutChunks.length;
    totalDriveFiles += dr.length;
    console.log(`\n${day}:`);
    console.log(`  Supabase — has transcript chunks: ${sb.withChunks.length}`);
    console.log(`  Supabase — row exists, NO chunks (failed/incomplete): ${sb.withoutChunks.length}`);
    console.log(`  Drive — JSON files found under Transcripts/: ${dr.length}`);
    const gap = sb.withChunks.length - dr.length;
    if (gap > 0) console.log(`  ⚠️  ${gap} video(s) have a transcript in Supabase but no file in Drive for this day`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('TOTALS');
  console.log('='.repeat(70));
  console.log(`Supabase videos with a real transcript: ${totalWithChunks}`);
  console.log(`Supabase videos with NO transcript chunks yet: ${totalNoChunks}`);
  console.log(`Files actually present in Drive under Transcripts/: ${totalDriveFiles}`);
  console.log(`Missing from Drive (has transcript in Supabase, no file in Drive): ${totalWithChunks - totalDriveFiles}`);

  if (errorSamples.size) {
    console.log('\n' + '='.repeat(70));
    console.log('WHY DAY LOOKUPS FAILED (these became "Unknown")');
    console.log('='.repeat(70));
    for (const [reason, info] of errorSamples.entries()) {
      console.log(`\n${reason}  — ${info.count} video(s)`);
      for (const ex of info.examples) console.log(`    e.g. ${ex}`);
    }
  }
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
