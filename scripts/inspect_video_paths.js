/**
 * inspect_video_paths.js
 *
 * Read-only: for a sample of videos in Supabase, prints the literal chain
 * of Drive folder names from the source video file up to the Shared Drive
 * root — no "Day X" regex filtering, just the real names — so we can see
 * exactly how the "Unknown" videos are actually organized in Drive.
 *
 * Run:
 *   node scripts/inspect_video_paths.js          # one sample per resolved day bucket
 *   node scripts/inspect_video_paths.js 10       # sample size per bucket
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { findDayLabel, sleep } = require('./lib/findDayLabel');

const SAMPLE_SIZE = parseInt(process.argv[2], 10) || 3;

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

async function getAllVideos(supabase) {
  const all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('videos')
      .select('id, file_name, title, video_drive_id')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`videos select: ${error.message}`);
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function printFullChain(drive, fileId) {
  let currentId = fileId;
  const chain = [];
  for (let depth = 0; depth < 10 && currentId; depth++) {
    try {
      const res = await drive.files.get({
        fileId: currentId,
        fields: 'id, name, parents',
        supportsAllDrives: true,
      });
      chain.push(res.data.name);
      currentId = res.data.parents?.[0];
    } catch (err) {
      chain.push(`<ERROR: ${err.code || err.response?.status || ''} ${err.message}>`);
      break;
    }
  }
  return chain;
}

async function main() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');

  const drive = buildDrive();
  const supabase = buildSupabase();
  const dayCache = new Map();

  console.log('Fetching videos from Supabase...');
  const videos = await getAllVideos(supabase);
  console.log(`Found ${videos.length} videos.\n`);

  const byDay = new Map();
  for (const v of videos) {
    const day = v.video_drive_id ? await findDayLabel(drive, v.video_drive_id, dayCache) : 'Unknown';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(v);
    await sleep(60);
  }

  for (const [day, list] of byDay.entries()) {
    console.log('='.repeat(70));
    console.log(`${day} — ${list.length} video(s) total, showing up to ${SAMPLE_SIZE} sample(s)`);
    console.log('='.repeat(70));
    for (const v of list.slice(0, SAMPLE_SIZE)) {
      const label = v.title || v.file_name;
      console.log(`\n${label}  (video_drive_id: ${v.video_drive_id || 'NONE'})`);
      if (!v.video_drive_id) {
        console.log('  -> no video_drive_id stored, cannot trace.');
        continue;
      }
      const chain = await printFullChain(drive, v.video_drive_id);
      console.log('  ' + chain.join('  <-  '));
      await sleep(60);
    }
    console.log('');
  }
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
