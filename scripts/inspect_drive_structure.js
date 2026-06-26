/**
 * inspect_drive_structure.js
 *
 * Read-only. Prints what SHARED_DRIVE_FOLDER_ID, TRANSCRIPT_FOLDER_ID, and
 * PROXIES_FOLDER_ID actually point to (name + parent), plus their immediate
 * children -- so we can confirm whether SHARED_DRIVE_FOLDER_ID is really the
 * "SafetyWing Content" shared drive ROOT (sibling to "SF Content Week 2026",
 * "Norway 2026", etc.) or already the "SF Content Week 2026" folder itself,
 * and find the existing "Videos" folder ID next to where TRANSCRIPT_FOLDER_ID
 * lives, if one already exists.
 *
 * Run: node scripts/inspect_drive_structure.js
 */

require('dotenv').config();
const { google } = require('googleapis');

function buildDrive() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function describe(drive, label, id) {
  if (!id) { console.log(`${label}: (not set in .env)`); return; }
  try {
    const res = await drive.files.get({
      fileId: id,
      fields: 'id, name, mimeType, parents, driveId',
      supportsAllDrives: true,
    });
    const f = res.data;
    console.log(`${label} = ${id}`);
    console.log(`  name: "${f.name}"`);
    console.log(`  mimeType: ${f.mimeType}`);
    console.log(`  parents: ${(f.parents || []).join(', ') || '(none -- likely a Shared Drive root itself)'}`);
    console.log(`  driveId: ${f.driveId || '(n/a)'}`);
    return f;
  } catch (e) {
    console.log(`${label} = ${id}  ❌ ERROR: ${e.message}`);
    return null;
  }
}

async function listChildren(drive, label, id) {
  if (!id) return;
  try {
    const res = await drive.files.list({
      q: `'${id}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    console.log(`\nChildren of ${label} (${id}):`);
    if (res.data.files.length === 0) console.log('  (none)');
    for (const f of res.data.files) {
      const tag = f.mimeType === 'application/vnd.google-apps.folder' ? '📁' : '📄';
      console.log(`  ${tag} ${f.name}  (id: ${f.id})`);
    }
  } catch (e) {
    console.log(`\nChildren of ${label}: ❌ ERROR: ${e.message}`);
  }
}

async function main() {
  const drive = buildDrive();

  console.log('='.repeat(70));
  console.log('CURRENT .env VALUES');
  console.log('='.repeat(70));
  const shared = await describe(drive, 'SHARED_DRIVE_FOLDER_ID', process.env.SHARED_DRIVE_FOLDER_ID);
  console.log();
  const transcriptFolder = await describe(drive, 'TRANSCRIPT_FOLDER_ID', process.env.TRANSCRIPT_FOLDER_ID);
  console.log();
  await describe(drive, 'PROXIES_FOLDER_ID', process.env.PROXIES_FOLDER_ID);

  console.log('\n' + '='.repeat(70));
  console.log('CHILDREN');
  console.log('='.repeat(70));
  await listChildren(drive, 'SHARED_DRIVE_FOLDER_ID', process.env.SHARED_DRIVE_FOLDER_ID);

  // If TRANSCRIPT_FOLDER_ID has a parent, that parent is very likely the
  // "SF Content Week 2026" event folder -- list ITS children too, to look
  // for an existing sibling "Videos" folder.
  if (transcriptFolder?.parents?.length) {
    const parentId = transcriptFolder.parents[0];
    const parentInfo = await describe(drive, '\nTRANSCRIPT_FOLDER_ID parent (likely the event folder)', parentId);
    await listChildren(drive, 'that parent folder', parentId);
  }
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
