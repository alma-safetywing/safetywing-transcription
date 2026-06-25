/**
 * check_transcripts_by_day.js
 *
 * Read-only check: for every video in Supabase, figures out which "Day X"
 * folder it came from (by walking its source Drive file's parent folders)
 * and prints a count per day, plus the full list of titles for whichever
 * days you ask about.
 *
 * Run:
 *   node scripts/check_transcripts_by_day.js            # summary of all days
 *   node scripts/check_transcripts_by_day.js 1 3         # list videos for Day 1 and Day 3
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const askedDays = process.argv.slice(2).map(d => `Day ${d}`);

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

async function findDayLabel(drive, fileId, cache) {
  if (cache.has(fileId)) return cache.get(fileId);
  try {
    let currentId = fileId;
    for (let depth = 0; depth < 6 && currentId; depth++) {
      const res = await drive.files.get({
        fileId: currentId,
        fields: 'id, name, parents',
        supportsAllDrives: true,
      });
      const m = res.data.name?.match(/day\s*\d+/i);
      if (m) {
        const label = m[0].replace(/\s+/g, ' ').replace(/day\s/i, 'Day ');
        cache.set(fileId, label);
        return label;
      }
      currentId = res.data.parents?.[0];
    }
  } catch {
    // inaccessible — fall through to Unknown
  }
  cache.set(fileId, 'Unknown');
  return 'Unknown';
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

async function hasTranscript(supabase, videoId) {
  const { count, error } = await supabase
    .from('transcript_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('video_id', videoId)
    .eq('chunk_type', 'segment');
  if (error) throw new Error(`chunks count: ${error.message}`);
  return (count || 0) > 0;
}

async function main() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');

  const drive = buildDrive();
  const supabase = buildSupabase();
  const dayCache = new Map();

  console.log('Fetching videos from Supabase...');
  const videos = await getAllVideos(supabase);
  console.log(`Found ${videos.length} video rows.\n`);

  const byDay = new Map();

  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    process.stdout.write(`\r[${i + 1}/${videos.length}] resolving day labels...`);
    const day = v.video_drive_id
      ? await findDayLabel(drive, v.video_drive_id, dayCache)
      : 'Unknown';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(v);
  }
  console.log('\n');

  console.log('='.repeat(50));
  console.log('Summary — videos in Supabase by day:');
  console.log('='.repeat(50));
  const sortedDays = [...byDay.keys()].sort();
  for (const day of sortedDays) {
    console.log(`${day}: ${byDay.get(day).length} video(s)`);
  }

  if (askedDays.length) {
    console.log('\n' + '='.repeat(50));
    for (const day of askedDays) {
      const list = byDay.get(day) || [];
      console.log(`\n${day}: ${list.length} video(s) in Supabase`);
      if (!list.length) {
        console.log('  (none found — either not processed yet, or Drive folder name doesn\'t match "Day N")');
        continue;
      }
      for (const v of list) {
        process.stdout.write(`  - ${v.title || v.file_name} ... `);
        const ok = await hasTranscript(supabase, v.id);
        console.log(ok ? '✅ has transcript' : '⚠️  row exists but no transcript chunks');
      }
    }
  }
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
