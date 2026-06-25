/**
 * rename_videos.js
 *
 * Renames MP4 video files in Google Drive to descriptive titles generated
 * by GPT-4o-mini from their corresponding transcript content.
 *
 * Two modes:
 *   --from-supabase  Use titles already stored in the videos table (fast, no re-processing)
 *   --from-drive     Download each transcript JSON and generate titles fresh (slower)
 *
 * Usage:
 *   node scripts/rename_videos.js --from-supabase
 *   node scripts/rename_videos.js --from-drive
 *
 * The script searches your entire Drive for MP4 files whose current name
 * matches the original transcript filename (e.g. CODC3_0002_1.mp4).
 * It will NOT rename files that already have a descriptive name.
 *
 * REQUIRED env vars (same .env as the rest of the project):
 *   GOOGLE_SERVICE_ACCOUNT_JSON
 *   SUPABASE_URL + SUPABASE_SERVICE_KEY   (for --from-supabase mode)
 *   OPENAI_API_KEY                         (for --from-drive mode)
 *   TRANSCRIPT_FOLDER_ID                   (for --from-drive mode)
 *
 * OPTIONAL:
 *   VIDEO_FOLDER_ID   Drive folder to restrict the search to (recommended).
 *                     If omitted, searches all Drive files visible to the service account.
 */

require('dotenv').config();
const { google } = require('googleapis');
const OpenAI    = require('openai');
const { createClient } = require('@supabase/supabase-js');
const path      = require('path');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  return createClient(url, key);
}

function buildOpenAI() {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Sanitize a title for use as a filename
function toFileName(title, ext = '.mp4') {
  return title
    .replace(/[\/\\:*?"<>|]/g, '')   // remove illegal filename chars
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100)               // keep under 100 chars
    + ext;
}

// Looks like a raw camera filename: starts with letters, has underscores, ends with digits
function isRawCameraName(name) {
  const base = path.basename(name, path.extname(name));
  return /^[A-Z0-9]+_\d+/.test(base);
}

// ─── Drive: search for video file by original name ────────────────────────────

async function findVideoFile(drive, originalStem, folderConstraint) {
  // Try both .mp4 and .mov
  const exts = ['.mp4', '.MP4', '.mov', '.MOV'];
  for (const ext of exts) {
    const filename = originalStem + ext;
    let q = `name = '${filename.replace(/'/g, "\\'")}' and trashed = false`;
    if (folderConstraint) {
      // Search recursively within folder — Drive API doesn't support recursive search
      // directly, so we omit the folder filter and rely on service-account-visible files
    }
    const res = await drive.files.list({
      q,
      fields: 'files(id, name, parents)',
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0];
    }
  }
  return null;
}

async function renameFile(drive, fileId, newName) {
  await drive.files.update({
    fileId,
    requestBody: { name: newName },
    supportsAllDrives: true,
  });
}

// ─── Mode 1: Titles from Supabase ────────────────────────────────────────────

async function renameFromSupabase(drive, supabase) {
  console.log('Fetching video titles from Supabase...');
  const { data: videos, error } = await supabase
    .from('videos')
    .select('id, title, file_name')
    .not('title', 'is', null);

  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  console.log(`Found ${videos.length} videos with titles.\n`);

  let renamed = 0, skipped = 0, notFound = 0, failed = 0;

  for (const video of videos) {
    const stem = video.id; // original filename without extension, e.g. CODC3_0002_1

    process.stdout.write(`[${stem}] `);

    if (!isRawCameraName(stem)) {
      console.log('already has a descriptive name, skipping.');
      skipped++;
      continue;
    }

    const newName = toFileName(video.title);
    process.stdout.write(`searching Drive... `);

    const file = await findVideoFile(drive, stem, null);
    if (!file) {
      console.log('video file not found in Drive.');
      notFound++;
      continue;
    }

    if (!isRawCameraName(file.name)) {
      console.log(`already renamed to "${file.name}", skipping.`);
      skipped++;
      continue;
    }

    try {
      process.stdout.write(`renaming to "${newName}"... `);
      await renameFile(drive, file.id, newName);
      console.log('✅');
      renamed++;
    } catch (e) {
      console.log(`❌  ${e.message}`);
      failed++;
    }

    await sleep(200); // avoid Drive API rate limits
  }

  printSummary(renamed, skipped, notFound, failed);
}

// ─── Mode 2: Titles from Drive transcripts ───────────────────────────────────

async function downloadJson(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' }
  );
  return JSON.parse(res.data);
}

async function generateTitle(openai, segments) {
  const sample = segments.slice(0, 20)
    .map(s => `${s.speaker || 'Speaker'}: ${s.text}`)
    .join('\n');

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `Generate a short descriptive title for this video that captures who is speaking and the main topic. Examples: "Sondre on why he founded SafetyWing", "Team discussing remote work benefits". Respond with ONLY the title, no quotes, no punctuation at end.\n\n${sample}`
    }],
    max_tokens: 30,
  });
  return res.choices[0].message.content.trim();
}

async function listTranscriptFiles(drive, folderId) {
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/json' and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function renameFromDrive(drive, openai) {
  const folderId = process.env.TRANSCRIPT_FOLDER_ID;
  if (!folderId) throw new Error('Missing TRANSCRIPT_FOLDER_ID env var');

  console.log('Fetching transcript list from Drive...');
  const transcripts = await listTranscriptFiles(drive, folderId);
  console.log(`Found ${transcripts.length} transcript files.\n`);

  let renamed = 0, skipped = 0, notFound = 0, failed = 0;

  for (const tf of transcripts) {
    const stem = path.basename(tf.name, '.json');
    process.stdout.write(`[${stem}] `);

    if (!isRawCameraName(stem)) {
      console.log('transcript already renamed — skipping video too.');
      skipped++;
      continue;
    }

    try {
      // Find the video file
      const file = await findVideoFile(drive, stem, null);
      if (!file) {
        console.log('video not found in Drive.');
        notFound++;
        continue;
      }

      if (!isRawCameraName(file.name)) {
        console.log(`already renamed to "${file.name}", skipping.`);
        skipped++;
        continue;
      }

      // Download transcript and generate title
      process.stdout.write('downloading transcript... ');
      const raw = await downloadJson(drive, tf.id);
      const segments = Array.isArray(raw) ? raw : (raw.transcript || []);
      if (!segments.length) {
        console.log('empty transcript, skipping.');
        skipped++;
        continue;
      }

      process.stdout.write('titling... ');
      const title = await generateTitle(openai, segments);
      const newName = toFileName(title);

      process.stdout.write(`renaming to "${newName}"... `);
      await renameFile(drive, file.id, newName);
      console.log('✅');
      renamed++;
    } catch (e) {
      console.log(`❌  ${e.message}`);
      failed++;
    }

    await sleep(300);
  }

  printSummary(renamed, skipped, notFound, failed);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function printSummary(renamed, skipped, notFound, failed) {
  console.log('\n' + '═'.repeat(50));
  console.log('Done.');
  console.log(`  ✅ Renamed    : ${renamed}`);
  console.log(`  ⏭  Skipped    : ${skipped}`);
  console.log(`  ❓ Not found  : ${notFound}`);
  console.log(`  ❌ Failed     : ${failed}`);
  console.log('═'.repeat(50));

  if (notFound > 0) {
    console.log(`
⚠️  Some video files were not found. This usually means:
   1. The service account doesn't have access to the video folder yet.
      → Share the "SF Content Week" (or Proxies) folder with:
        ${JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}').client_email || '<your service account email>'}
   2. The video files are in a Shared Drive.
      → Make sure the service account is a member of the Shared Drive.`);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2];
  if (!mode || (mode !== '--from-supabase' && mode !== '--from-drive')) {
    console.error('Usage: node scripts/rename_videos.js --from-supabase');
    console.error('       node scripts/rename_videos.js --from-drive');
    process.exit(1);
  }

  const drive = buildDrive();

  if (mode === '--from-supabase') {
    const supabase = buildSupabase();
    await renameFromSupabase(drive, supabase);
  } else {
    const openai = buildOpenAI();
    await renameFromDrive(drive, openai);
  }
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
