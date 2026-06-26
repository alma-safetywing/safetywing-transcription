/**
 * inspect_sf_content_week.js
 *
 * Follow-up to inspect_drive_structure.js. That script showed:
 *   - SHARED_DRIVE_FOLDER_ID is the shared drive ROOT (not "SF Content Week 2026")
 *   - TRANSCRIPT_FOLDER_ID ("Transcripts") lives at that ROOT, not nested inside
 *     "SF Content Week 2026" -- a stray sibling folder
 *   - PROXIES_FOLDER_ID points to a folder named "Content and Transcripts" with
 *     no parents and no driveId -- i.e. NOT inside the SafetyWing Content shared
 *     drive at all. Wrong/unrelated folder.
 *
 * match_legacy_videos.js (separately, hardcoded) scans SOURCE_FOLDER_ID =
 * '1PYaVpIoaaszLaM-T-sE73SI4GI7w_Q45' and found the real Day X/Cam Y and
 * Proxies/Day X footage -- this is almost certainly the actual correct
 * proxies/source folder. This script checks:
 *   1. What "SF Content Week 2026" (1Zfc5A4Nb0aZS3rHIssL6WX2fmiN3_Miy) actually
 *      contains -- to see if it already has a Proxies/Videos/Transcripts
 *      structure inside it.
 *   2. What SOURCE_FOLDER_ID (1PYaVpIoaaszLaM-T-sE73SI4GI7w_Q45) actually is,
 *      and where it lives, to confirm it's the right replacement for
 *      PROXIES_FOLDER_ID.
 *
 * Run: node scripts/inspect_sf_content_week.js
 */

require('dotenv').config();
const { google } = require('googleapis');

const SF_CONTENT_WEEK_ID = '1Zfc5A4Nb0aZS3rHIssL6WX2fmiN3_Miy';
const LEGACY_SOURCE_FOLDER_ID = '1PYaVpIoaaszLaM-T-sE73SI4GI7w_Q45'; // from match_legacy_videos.js

function buildDrive() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function describe(drive, label, id) {
  try {
    const res = await drive.files.get({
      fileId: id,
      fields: 'id, name, mimeType, parents, driveId',
      supportsAllDrives: true,
    });
    const f = res.data;
    console.log(`${label} = ${id}`);
    console.log(`  name: "${f.name}"`);
    console.log(`  parents: ${(f.parents || []).join(', ') || '(none)'}`);
    console.log(`  driveId: ${f.driveId || '(n/a)'}`);
    return f;
  } catch (e) {
    console.log(`${label} = ${id}  ❌ ERROR: ${e.message}`);
    return null;
  }
}

async function listChildren(drive, label, id) {
  try {
    const res = await drive.files.list({
      q: `'${id}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 200,
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
  console.log('"SF Content Week 2026" folder');
  console.log('='.repeat(70));
  await describe(drive, 'SF Content Week 2026', SF_CONTENT_WEEK_ID);
  await listChildren(drive, 'SF Content Week 2026', SF_CONTENT_WEEK_ID);

  console.log('\n' + '='.repeat(70));
  console.log('match_legacy_videos.js\'s SOURCE_FOLDER_ID (likely the real proxies folder)');
  console.log('='.repeat(70));
  const src = await describe(drive, 'SOURCE_FOLDER_ID', LEGACY_SOURCE_FOLDER_ID);
  await listChildren(drive, 'SOURCE_FOLDER_ID', LEGACY_SOURCE_FOLDER_ID);
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
