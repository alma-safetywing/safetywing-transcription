/**
 * reorganize_drive_folder.js
 *
 * One-time reorg: moves everything currently directly inside a folder under
 * the Shared Drive (default: "Transcripts") into a new subfolder, e.g.
 * "SF Content Week 2026". Uses Drive parent updates (addParents/removeParents)
 * — instant, no re-upload, works because everything stays inside the same
 * Shared Drive (no service-account quota issue).
 *
 * Run:
 *   node scripts/reorganize_drive_folder.js "SF Content Week 2026"
 *   node scripts/reorganize_drive_folder.js "SF Content Week 2026" Videos   # to do the same for Videos/
 */

require('dotenv').config();
const { google } = require('googleapis');

const SHARED_DRIVE_FOLDER_ID = process.env.SHARED_DRIVE_FOLDER_ID;
const NEW_SUBFOLDER_NAME = process.argv[2];
const TARGET_FOLDER_NAME = process.argv[3] || 'Transcripts';

function buildDrive() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
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

async function getOrCreateFolder(drive, name, parentId) {
  const existing = await findFolderByName(drive, name, parentId);
  if (existing) return existing;
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    supportsAllDrives: true,
    fields: 'id',
  });
  return created.data.id;
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

async function main() {
  if (!SHARED_DRIVE_FOLDER_ID) throw new Error('Missing SHARED_DRIVE_FOLDER_ID');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!NEW_SUBFOLDER_NAME) throw new Error('Usage: node scripts/reorganize_drive_folder.js "<new subfolder name>" [TargetFolderName]');

  const drive = buildDrive();

  console.log(`Locating "${TARGET_FOLDER_NAME}" folder under Shared Drive ${SHARED_DRIVE_FOLDER_ID}...`);
  const targetFolderId = await findFolderByName(drive, TARGET_FOLDER_NAME, SHARED_DRIVE_FOLDER_ID);
  if (!targetFolderId) throw new Error(`Could not find "${TARGET_FOLDER_NAME}" folder under SHARED_DRIVE_FOLDER_ID`);
  console.log(`Found: ${targetFolderId}`);

  console.log(`\nCreating/finding subfolder "${NEW_SUBFOLDER_NAME}"...`);
  const newSubfolderId = await getOrCreateFolder(drive, NEW_SUBFOLDER_NAME, targetFolderId);
  console.log(`Subfolder ID: ${newSubfolderId}`);

  console.log(`\nListing current children of ${TARGET_FOLDER_NAME}/...`);
  const children = await listChildren(drive, targetFolderId);
  const toMove = children.filter(c => c.id !== newSubfolderId);
  console.log(`Found ${toMove.length} items to move (excluding the new subfolder itself).\n`);

  let moved = 0, failed = 0;
  for (const item of toMove) {
    process.stdout.write(`Moving "${item.name}"... `);
    try {
      await drive.files.update({
        fileId: item.id,
        addParents: newSubfolderId,
        removeParents: targetFolderId,
        supportsAllDrives: true,
        fields: 'id, parents',
      });
      console.log('✅');
      moved++;
    } catch (err) {
      console.log(`❌ FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Done. Moved: ${moved} | Failed: ${failed}`);
  console.log(`Everything that was directly in ${TARGET_FOLDER_NAME}/ is now in ${TARGET_FOLDER_NAME}/${NEW_SUBFOLDER_NAME}/`);
  console.log('='.repeat(50));
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
