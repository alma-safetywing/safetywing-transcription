/**
 * backfill_sf_video_copies.js
 *
 * Why this exists: process_new_videos.js has a COPY_VIDEO_TO_DRIVE flag that
 * places a renamed copy of each processed video into the Shared Drive's
 * "Videos" folder. For the SF Content Week pipeline that flag was never set
 * in .env (it defaults to false), so every video processed so far has a
 * transcript in Drive but NO copy in the Videos folder -- only transcripts
 * ever got uploaded. .env now has COPY_VIDEO_TO_DRIVE=true so this happens
 * automatically for every video processed FROM NOW ON, but that doesn't
 * retroactively fix videos already sitting in Supabase. This script is the
 * one-time catch-up for those.
 *
 * For each Supabase `videos` row whose source file (video_drive_id) lives
 * somewhere under PROXIES_FOLDER_ID (the SF Content Week source tree --
 * walked via the file's actual Drive parents, not assumed), it:
 *   1. Mirrors that file's subfolder path under SHARED_DRIVE_FOLDER_ID/Videos
 *      (creating folders as needed), same convention process_new_videos.js uses.
 *   2. Skips it if a same-named file already exists in that destination folder
 *      (so it's always safe to re-run, e.g. if interrupted).
 *   3. Otherwise copies the source video there, renamed to the row's title --
 *      this is a Drive COPY, never touches or deletes the original proxy file.
 *
 * Rows whose source file is NOT found under PROXIES_FOLDER_ID (e.g. Norway
 * 2026 or Webinars rows, which use their own separate proxies folders and
 * already have their own copy/rename handling) are skipped automatically.
 *
 * Run:
 *   node scripts/backfill_sf_video_copies.js            # dry run, no copies made
 *   node scripts/backfill_sf_video_copies.js --apply     # actually copy
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const APPLY = process.argv.includes('--apply');
const PROXIES_FOLDER_ID      = process.env.PROXIES_FOLDER_ID;
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

async function getOrCreateFolder(drive, name, parentId) {
  const res = await drive.files.list({
    q: `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
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

async function getDriveFolder(drive, root, folderPath, cache) {
  if (!folderPath) return root;
  const segments = folderPath.split('/').filter(Boolean);
  let parentId = root;
  let built = '';
  for (const seg of segments) {
    built = built ? `${built}/${seg}` : seg;
    const cacheKey = root + '::' + built;
    if (!cache[cacheKey]) cache[cacheKey] = await getOrCreateFolder(drive, seg, parentId);
    parentId = cache[cacheKey];
  }
  return parentId;
}

// Walks a file's actual Drive parents upward until it finds PROXIES_FOLDER_ID
// (returning the relative subfolder path travelled) or runs out of parents
// (returning null -- file isn't under the SF proxies tree, e.g. Norway/Webinars).
async function findRelativePath(drive, fileId, folderNameCache) {
  const pathParts = [];
  let currentId = fileId;
  for (let depth = 0; depth < 20; depth++) {
    const res = await drive.files.get({
      fileId: currentId,
      fields: 'id, name, parents',
      supportsAllDrives: true,
    });
    const parents = res.data.parents || [];
    if (parents.length === 0) return null;
    const parentId = parents[0];
    if (parentId === PROXIES_FOLDER_ID) {
      return pathParts.reverse().join('/');
    }
    if (!folderNameCache[parentId]) {
      try {
        const pf = await drive.files.get({ fileId: parentId, fields: 'id, name', supportsAllDrives: true });
        folderNameCache[parentId] = pf.data.name;
      } catch {
        return null; // can't read this far up (e.g. left the shared drive) -- not under proxies
      }
    }
    pathParts.push(folderNameCache[parentId]);
    currentId = parentId;
  }
  return null; // too deep / probably not under PROXIES_FOLDER_ID at all
}

async function fileExistsInFolder(drive, folderId, name) {
  const res = await drive.files.list({
    q: `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files.length > 0;
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

async function getAllVideoRows(supabase) {
  const all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('videos')
      .select('id, file_name, title, video_drive_id')
      .not('video_drive_id', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`videos select: ${error.message}`);
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function main() {
  if (!PROXIES_FOLDER_ID || !SHARED_DRIVE_FOLDER_ID) {
    throw new Error('Missing PROXIES_FOLDER_ID / SHARED_DRIVE_FOLDER_ID in .env');
  }
  const drive = buildDrive();
  const supabase = buildSupabase();

  console.log(`Mode: ${APPLY ? 'APPLY (will copy files)' : 'DRY RUN (no files will be copied -- pass --apply to actually copy)'}\n`);

  console.log('Fetching Supabase video rows with a video_drive_id...');
  const rows = await getAllVideoRows(supabase);
  console.log(`Found ${rows.length} row(s).\n`);

  const videosRoot = await getOrCreateFolder(drive, 'Videos', SHARED_DRIVE_FOLDER_ID);
  const folderCache = {};
  const folderNameCache = {};

  let underProxies = 0, notUnderProxies = 0, alreadyExists = 0, copied = 0, failed = 0;

  for (const row of rows) {
    const title = row.title || row.file_name || row.id;
    process.stdout.write(`[${row.id}] "${title}" ... `);
    try {
      const relPath = await findRelativePath(drive, row.video_drive_id, folderNameCache);
      if (relPath === null) {
        console.log('skip (not under PROXIES_FOLDER_ID -- likely Norway/Webinars, already handled separately)');
        notUnderProxies++;
        continue;
      }
      underProxies++;
      const destFolder = await getDriveFolder(drive, videosRoot, relPath, folderCache);
      const safeTitle = title.replace(/[^a-z0-9\s\-_,]/gi, '').trim().substring(0, 80);
      const exists = await fileExistsInFolder(drive, destFolder, safeTitle + '.mp4');
      if (exists) {
        console.log(`already in Videos/${relPath} -- skipping`);
        alreadyExists++;
        continue;
      }
      if (!APPLY) {
        console.log(`would copy -> Videos/${relPath}/${safeTitle}.mp4`);
        continue;
      }
      await copyVideoToDrive(drive, row.video_drive_id, destFolder, title);
      console.log(`✅ copied -> Videos/${relPath}/${safeTitle}.mp4`);
      copied++;
    } catch (e) {
      console.log(`❌ FAILED: ${e.message}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(`Under SF proxies tree: ${underProxies} | Not under it (skipped, other pipelines): ${notUnderProxies}`);
  if (APPLY) {
    console.log(`Copied: ${copied} | Already existed: ${alreadyExists} | Failed: ${failed}`);
  } else {
    console.log(`Already existed (would skip): ${alreadyExists} | Would copy: ${underProxies - alreadyExists}`);
    console.log('\nRe-run with --apply to actually perform the copies above.');
  }
  console.log('='.repeat(70));
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
