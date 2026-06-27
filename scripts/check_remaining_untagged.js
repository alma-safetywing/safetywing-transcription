/**
 * check_remaining_untagged.js
 *
 * backfill_collection_tags.js couldn't tag 6 specific legacy rows
 * (CODC3_0001_1, 0003_1, 0004_1, 0035_1, 0036_1, 0039_1) even after falling
 * back to video_drive_id. This just prints those 6 rows' raw Supabase fields
 * so we can see why -- most likely video_drive_id is null (never backfilled),
 * meaning there's nothing for the collection-matcher to compare against.
 *
 * Read-only, no Drive calls.
 *
 * Run:
 *   node scripts/check_remaining_untagged.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const IDS = ['CODC3_0001_1', 'CODC3_0003_1', 'CODC3_0004_1', 'CODC3_0035_1', 'CODC3_0036_1', 'CODC3_0039_1'];

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data, error } = await supabase
    .from('videos')
    .select('id, title, file_name, video_drive_id, drive_file_id, total_duration_ms, collection')
    .in('id', IDS);
  if (error) throw new Error(error.message);

  for (const row of data) {
    console.log(JSON.stringify(row, null, 2));
  }
  if (data.length < IDS.length) {
    const found = new Set(data.map(r => r.id));
    console.log('\nNOT FOUND in videos table at all:', IDS.filter(id => !found.has(id)));
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
