/**
 * backfill_norway_video_names.js
 *
 * One-off catch-up script. The rename-in-place feature (process_new_videos.js
 * + RENAME_VIDEO_IN_PLACE) didn't exist yet when the first Norway 2026 test
 * video (IMG_5542.MOV) was processed, so it was transcribed but left under its
 * original camera filename. This script finds every video file under Norway
 * 2026/Videos (recursive), looks up its transcript title in Supabase, and
 * renames the Drive file to match -- exactly what the live pipeline now does
 * automatically right after transcribing.
 *
 * Safe to re-run: videos with no Supabase row yet are skipped (not processed
 * yet), and videos whose name already matches their title are left alone.
 *
 * Run:
 *   node scripts/backfill_norway_video_names.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const NORWAY_VIDEOS_ID = '1E9nAnRKL4XnpdykJD__WC17HvIo0szAO';

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

async function listAllVideoFiles(drive, folderId, out) {
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
    for (const f of res.data.files) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        await listAllVideoFiles(drive, f.id, out);
      } else if (f.mimeType && f.mimeType.startsWith('video/')) {
        out.push(f);
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
}

async function main() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');

  const drive = buildDrive();
  const supabase = buildSupabase();

  console.log('Scanning Norway 2026/Videos (recursive)...');
  const files = [];
  await listAllVideoFiles(drive, NORWAY_VIDEOS_ID, files);
  console.log(`Found ${files.length} video file(s).\n`);

  let renamed = 0, skippedNoTranscript = 0, alreadyMatched = 0, failed = 0;

  for (const f of files) {
    const { data, error } = await supabase.from('videos').select('title').eq('id', f.id).maybeSingle();
    if (error) {
      console.log(`  ⚠️  ${f.name}: Supabase lookup failed: ${error.message}`);
      failed++;
      continue;
    }
    if (!data?.title) {
      console.log(`  - ${f.name}: no transcript yet, skipping.`);
      skippedNoTranscript++;
      continue;
    }

    const ext = path.extname(f.name);
    const safeTitle = data.title.replace(/[^a-z0-9\s\-_,]/gi, '').trim().substring(0, 80);
    const newName = safeTitle + ext;

    if (f.name === newName) {
      console.log(`  ✓ ${f.name}: already matches.`);
      alreadyMatched++;
      continue;
    }

    try {
      await drive.files.update({ fileId: f.id, requestBody: { name: newName }, supportsAllDrives: true });
      console.log(`  ✏️  "${f.name}" -> "${newName}"`);
      renamed++;
    } catch (e) {
      console.log(`  ⚠️  ${f.name}: rename failed: ${e.message}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Renamed: ${renamed} | Already matched: ${alreadyMatched} | No transcript: ${skippedNoTranscript} | Failed: ${failed}`);
  console.log('='.repeat(60));
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
