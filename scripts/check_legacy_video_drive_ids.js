/**
 * check_legacy_video_drive_ids.js
 *
 * 5 legacy rows (CODC3_0001_1, 0003_1, 0035_1, 0036_1, 0039_1) have a
 * non-null video_drive_id, but backfill_collection_tags.js's scan of the
 * legacy Proxies folder didn't turn up a matching file ID for any of them.
 * That scan only lists trashed=false files, so this looks each ID up
 * directly via drive.files.get to see its real current state: still there
 * but somewhere else (parents), trashed, or gone entirely (404).
 *
 * Read-only.
 *
 * Run:
 *   node scripts/check_legacy_video_drive_ids.js
 */

require('dotenv').config();
const { google } = require('googleapis');

const ROWS = [
  { id: 'CODC3_0001_1', video_drive_id: '16YuD23x1mV6xTTrPZtIDW6DfalAuVBAt' },
  { id: 'CODC3_0003_1', video_drive_id: '1XPDmQZAfOxc7pyb042Trlmr_p7ynuLYC' },
  { id: 'CODC3_0035_1', video_drive_id: '1--GcAgPCFk7PDuJ5Xl21pGEG0joYsoCi' },
  { id: 'CODC3_0036_1', video_drive_id: '1yfTH-AQ-frmGePAP7kKODJC-sI1pIboR' },
  { id: 'CODC3_0039_1', video_drive_id: '162GMCQA99tENRDupQP97R9aECzCScEOX' },
];

function buildDrive() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function main() {
  const drive = buildDrive();
  for (const row of ROWS) {
    console.log(`\n${row.id} -> video_drive_id ${row.video_drive_id}`);
    try {
      const res = await drive.files.get({
        fileId: row.video_drive_id,
        fields: 'id, name, trashed, parents, mimeType, driveId',
        supportsAllDrives: true,
      });
      console.log('  ', JSON.stringify(res.data));
    } catch (e) {
      console.log(`   ERROR: ${e.response?.status || ''} ${e.message}`);
    }
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
