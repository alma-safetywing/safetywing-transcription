/**
 * check_norway_access.js
 *
 * Read-only sanity check before running the real pipeline: confirms the
 * service account can actually see the Norway 2026 folder and its Videos
 * subfolder, and lists what's in Videos right now. Costs nothing (no
 * AssemblyAI/OpenAI calls) -- just Drive reads.
 *
 * Run:
 *   node scripts/check_norway_access.js
 */

require('dotenv').config();
const { google } = require('googleapis');

const NORWAY_ROOT_ID = '1hNrhmERcmsA_WeDivPoI6G_OlZqUWiH4';
const NORWAY_VIDEOS_ID = '1E9nAnRKL4XnpdykJD__WC17HvIo0szAO';

function buildDrive() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function main() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const clientEmail = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email;
  const drive = buildDrive();

  console.log(`Service account: ${clientEmail}\n`);

  for (const [label, id] of [['Norway 2026', NORWAY_ROOT_ID], ['Norway 2026/Videos', NORWAY_VIDEOS_ID]]) {
    try {
      const meta = await drive.files.get({ fileId: id, fields: 'id, name, mimeType', supportsAllDrives: true });
      console.log(`✅ Can see "${label}" -> Drive name: "${meta.data.name}"`);
    } catch (err) {
      console.log(`❌ Cannot see "${label}": ${err.code || err.response?.status || ''} ${err.message}`);
      console.log(`   Add ${clientEmail} as a member of the shared drive (or this folder) and retry.`);
    }
  }

  console.log('\nListing contents of Norway 2026/Videos...');
  try {
    const res = await drive.files.list({
      q: `'${NORWAY_VIDEOS_ID}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, size)',
      pageSize: 50,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (!res.data.files.length) {
      console.log('  (empty -- nothing uploaded yet, or access issue)');
    } else {
      for (const f of res.data.files) {
        const kind = f.mimeType === 'application/vnd.google-apps.folder' ? '[folder]' : '[file]';
        const size = f.size ? `${(parseInt(f.size, 10) / 1024 / 1024).toFixed(0)}MB` : '';
        console.log(`  ${kind} ${f.name} ${size}`);
      }
    }
  } catch (err) {
    console.log(`  ❌ list failed: ${err.code || err.response?.status || ''} ${err.message}`);
  }
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
