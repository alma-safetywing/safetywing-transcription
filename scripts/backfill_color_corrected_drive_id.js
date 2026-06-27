/**
 * backfill_color_corrected_drive_id.js
 *
 * One-time repair for videos that were already color-corrected by
 * color_correct_cam1.js BEFORE that script started recording the corrected
 * copy's Drive ID on the Supabase `videos` row (column
 * color_corrected_drive_id). Those runs successfully uploaded the corrected
 * file into SF Content Week 2026/Videos, but nothing ever told Supabase
 * about it -- so the search app's "Open video" button kept linking to the
 * raw, non-color-corrected original forever. This script closes that gap
 * for everything color_correct_cam1.js already finished.
 *
 * For every entry in color_correction_progress.json marked done:
 *   1. Look up the video row by video_drive_id (the ORIGINAL raw file's
 *      Drive ID -- the progress file is keyed by source file ID).
 *   2. Skip if color_corrected_drive_id is already set (idempotent --
 *      also safely picks up any future run where the live update in
 *      color_correct_cam1.js failed transiently, not just pre-fix runs).
 *   3. Find the corrected copy in the destination folder by its recorded
 *      destFileName.
 *   4. Set color_corrected_drive_id to that file's ID.
 *
 * Run:
 *   node scripts/backfill_color_corrected_drive_id.js            # dry run
 *   node scripts/backfill_color_corrected_drive_id.js --apply     # write
 *
 * Run the SQL migration first if you haven't:
 *   scripts/add_color_corrected_drive_id.sql
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const PROGRESS_FILE = path.join(__dirname, 'color_correction_progress.json');
const DEST_FOLDER_ID = process.env.PROXIES_FOLDER_ID; // SF Content Week 2026/Videos -- same var color_correct_cam1.js uses

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

async function findFileByName(drive, folderId, fileName) {
  const safeName = fileName.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name='${safeName}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files[0] || null;
}

async function main() {
  console.log(APPLY ? '🔴  LIVE MODE — Supabase rows will be updated.\n' : '🟡  DRY RUN — no changes will be written. Pass --apply to write.\n');

  if (!DEST_FOLDER_ID) throw new Error('Missing PROXIES_FOLDER_ID in .env (this is the SF Content Week 2026/Videos destination folder)');

  let progress;
  try {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (err) {
    throw new Error(`Couldn't read ${PROGRESS_FILE}: ${err.message}`);
  }

  const doneEntries = Object.entries(progress).filter(([, e]) => e?.done && e.destFileName);
  console.log(`Found ${doneEntries.length} completed color-correction entr${doneEntries.length === 1 ? 'y' : 'ies'} in progress file.\n`);

  const drive = buildDrive();
  const supabase = buildSupabase();

  let linked = 0, alreadyLinked = 0, noVideoRow = 0, noDriveFile = 0, failed = 0;

  for (const [sourceId, entry] of doneEntries) {
    process.stdout.write(`[${entry.destFileName}] `);

    const { data: rows, error: lookupErr } = await supabase
      .from('videos')
      .select('id, title, color_corrected_drive_id')
      .eq('video_drive_id', sourceId)
      .limit(1);

    if (lookupErr) {
      console.log(`— Supabase lookup failed: ${lookupErr.message}`);
      failed++;
      continue;
    }
    const video = rows?.[0];
    if (!video) {
      console.log('— no matching video row by original video_drive_id, skipping.');
      noVideoRow++;
      continue;
    }
    if (video.color_corrected_drive_id) {
      console.log('— already linked, skipping.');
      alreadyLinked++;
      continue;
    }

    const file = await findFileByName(drive, DEST_FOLDER_ID, entry.destFileName);
    if (!file) {
      console.log(`— couldn't find "${entry.destFileName}" in the destination Drive folder (renamed or removed?), skipping.`);
      noDriveFile++;
      continue;
    }

    if (!APPLY) {
      console.log(`would link → color_corrected_drive_id = ${file.id}`);
      linked++;
      continue;
    }

    const { error: updateErr } = await supabase
      .from('videos')
      .update({ color_corrected_drive_id: file.id })
      .eq('id', video.id);
    if (updateErr) {
      console.log(`— update failed: ${updateErr.message}`);
      failed++;
      continue;
    }
    console.log(`✓ linked → color_corrected_drive_id = ${file.id}`);
    linked++;
  }

  console.log('\n' + '═'.repeat(60));
  console.log(APPLY ? 'Backfill complete.' : 'Dry run complete — nothing was written.');
  console.log(`  ${APPLY ? 'Linked' : 'Would link'}         : ${linked}`);
  console.log(`  Already linked        : ${alreadyLinked}`);
  console.log(`  No matching video row : ${noVideoRow}`);
  console.log(`  No Drive file found   : ${noDriveFile}`);
  console.log(`  Failed                : ${failed}`);
  console.log('═'.repeat(60));
  if (!APPLY && linked > 0) console.log('\nRe-run with --apply to write these changes.');
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
