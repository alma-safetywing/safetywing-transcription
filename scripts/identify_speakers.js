/**
 * identify_speakers.js
 *
 * Run this once to figure out who is "Speaker 1", "Speaker 2", etc. in each video.
 * It prints the first utterance from each speaker per file so you can listen and
 * fill in their real names. Then it writes a template speaker_mappings.json.
 *
 * SETUP:
 *   1. Add to your .env:
 *        GOOGLE_SERVICE_ACCOUNT_JSON=<paste the full JSON key as a single line>
 *        TRANSCRIPT_FOLDER_ID=<Google Drive folder ID containing transcript JSONs>
 *
 *   2. Install deps (if not already):
 *        npm install googleapis dotenv
 *
 *   3. Run:
 *        node scripts/identify_speakers.js
 *
 *   4. Open speaker_mappings.json, fill in the real names, save.
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// ─── Auth ────────────────────────────────────────────────────────────────────

function getAuthClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON env var');
  const key = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

// ─── Drive helpers ───────────────────────────────────────────────────────────

async function listTranscriptFiles(drive, folderId) {
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/json' and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      pageToken: pageToken || undefined,
    });
    files.push(...res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function downloadJson(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'text' }
  );
  return JSON.parse(res.data);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const folderId = process.env.TRANSCRIPT_FOLDER_ID;
  if (!folderId) throw new Error('Missing TRANSCRIPT_FOLDER_ID env var');

  const auth = getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  console.log('Fetching transcript files from Drive...\n');
  const files = await listTranscriptFiles(drive, folderId);
  console.log(`Found ${files.length} transcript files.\n`);

  const mappingTemplate = {};

  for (const file of files) {
    // Derive a clean video ID from the filename (strip .json extension)
    const videoId = path.basename(file.name, '.json');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📁 ${file.name}  (video_id: "${videoId}")`);
    console.log('─'.repeat(60));

    let segments;
    try {
      segments = await downloadJson(drive, file.id);
    } catch (err) {
      console.log(`  ⚠️  Could not read file: ${err.message}`);
      continue;
    }

    if (!Array.isArray(segments) || segments.length === 0) {
      console.log('  ⚠️  Empty or invalid transcript, skipping.');
      continue;
    }

    // Collect first utterance per speaker
    const seen = new Set();
    const firstLines = {};

    for (const seg of segments) {
      const speaker = seg.speaker || 'Unknown';
      if (!seen.has(speaker)) {
        seen.add(speaker);
        firstLines[speaker] = {
          start: formatMs(seg.start_ms),
          text: seg.text.slice(0, 200) + (seg.text.length > 200 ? '...' : ''),
        };
      }
      if (seen.size >= 6) break; // cap at 6 speakers per file
    }

    // Print and build template
    mappingTemplate[videoId] = {};
    for (const [speaker, info] of Object.entries(firstLines)) {
      console.log(`\n  ${speaker} @ ${info.start}:`);
      console.log(`  "${info.text}"`);
      mappingTemplate[videoId][speaker] = 'FILL_IN_NAME';
    }
  }

  // Write template file
  const outPath = path.join(process.cwd(), 'speaker_mappings.json');
  fs.writeFileSync(outPath, JSON.stringify(mappingTemplate, null, 2));

  console.log('\n\n' + '═'.repeat(60));
  console.log(`✅  Template written to: speaker_mappings.json`);
  console.log('    Open it and replace every "FILL_IN_NAME" with the real name.');
  console.log('    Use "Interviewer" for hosts, "Crew" for brief off-camera voices.');
  console.log('═'.repeat(60) + '\n');
}

function formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
