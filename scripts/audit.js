/**
 * audit.js — compare what's in Drive vs what's in Supabase
 *
 * Run: node scripts/audit.js
 *
 * Outputs:
 *   - All JSON files found in the Drive folder (recursively)
 *   - All videos currently in Supabase
 *   - Which transcripts are NOT yet ingested
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  // ── Drive client ────────────────────────────────────────────────────────────
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });

  // ── Supabase client ──────────────────────────────────────────────────────────
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const rootFolderId = process.env.TRANSCRIPT_FOLDER_ID;
  if (!rootFolderId) throw new Error('Missing TRANSCRIPT_FOLDER_ID');

  // ── 1. List all JSON files in Drive (recursively) ───────────────────────────
  console.log('\n📂  Scanning Google Drive folder recursively...\n');
  const driveFiles = await listJsonFilesRecursive(drive, rootFolderId, '');
  console.log(`\nFound ${driveFiles.length} JSON transcript file(s) in Drive.\n`);

  // ── 2. List all videos in Supabase ──────────────────────────────────────────
  const { data: videos, error } = await supabase
    .from('videos')
    .select('id, title, file_name, total_duration_ms')
    .order('created_at', { ascending: true });

  if (error) throw new Error('Supabase error: ' + error.message);
  console.log(`Found ${videos.length} video(s) already ingested in Supabase.\n`);

  // ── 3. Cross-reference ───────────────────────────────────────────────────────
  const ingestedIds = new Set(videos.map(v => v.id));
  const ingestedNames = new Set(videos.map(v => v.file_name?.replace(/\.json$/, '')));

  const missing = driveFiles.filter(f => {
    const id = f.name.replace(/\.json$/, '');
    return !ingestedIds.has(id) && !ingestedNames.has(id) && !ingestedNames.has(f.name);
  });

  // ── 4. Print ingested videos ─────────────────────────────────────────────────
  console.log('═'.repeat(60));
  console.log('✅  INGESTED VIDEOS (' + videos.length + '):');
  console.log('═'.repeat(60));
  videos.forEach(v => {
    const dur = Math.round((v.total_duration_ms || 0) / 60000);
    console.log(`  ${dur}min  ${v.title || '(no title)'}  [${v.file_name || v.id}]`);
  });

  // ── 5. Print missing/not-ingested ────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('❌  NOT YET INGESTED (' + missing.length + '):');
  console.log('═'.repeat(60));
  if (missing.length === 0) {
    console.log('  All Drive transcripts are already ingested!');
  } else {
    missing.forEach(f => console.log(`  📄 ${f.path}/${f.name}  (id: ${f.id})`));
  }

  // ── 6. Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Drive JSON files (total):   ${driveFiles.length}`);
  console.log(`  Supabase videos (ingested): ${videos.length}`);
  console.log(`  Missing (not ingested):     ${missing.length}`);
  console.log('');

  if (missing.length > 0) {
    console.log('👉  Run "node scripts/ingest_transcripts.js" to ingest missing videos.');
    console.log('    The ingest script will skip already-ingested ones automatically.\n');
  }
}

/**
 * Recursively list all .json files under a Drive folder.
 * Returns [{id, name, path}]
 */
async function listJsonFilesRecursive(drive, folderId, folderPath) {
  const results = [];

  // List all items in this folder
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 200,
      pageToken: pageToken || undefined,
    });

    for (const file of res.data.files) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        // Recurse into subfolder
        const subPath = folderPath ? `${folderPath}/${file.name}` : file.name;
        console.log(`  📁 ${subPath}/`);
        const subFiles = await listJsonFilesRecursive(drive, file.id, subPath);
        results.push(...subFiles);
      } else if (file.name.endsWith('.json')) {
        const filePath = folderPath || '(root)';
        results.push({ id: file.id, name: file.name, path: filePath });
        console.log(`     📄 ${file.name}`);
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return results;
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
