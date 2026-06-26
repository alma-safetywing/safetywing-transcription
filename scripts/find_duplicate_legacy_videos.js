/**
 * find_duplicate_legacy_videos.js
 *
 * Why this exists: match_legacy_videos.js reported 0 confident matches out
 * of 52 orphaned rows (no video_drive_id) -- every single one came back
 * "ambiguous (contested)". The actual cause isn't a bad tolerance setting:
 * almost every orphan has a twin row with the EXACT same transcript
 * duration and a differently-paraphrased title (e.g. "Søndre discussing the
 * introduction process" and "Søndre Rash discussing the introduction and
 * purpose", both 3027.0s). These are two separate Supabase `videos` rows for
 * the SAME physical source video -- which is also why match_legacy_videos.js
 * sees two orphans both claiming the same Drive file as their #1 candidate
 * and marks it "contested" instead of confident.
 *
 * This script finds those duplicate pairs/groups by exact (rounded) total
 * duration match among orphaned rows, so they can be merged into one row
 * BEFORE running match_legacy_videos.js again -- after which most of the
 * long-clip "ambiguous" cases should resolve to confident matches.
 *
 * Read-only by default. Pass --merge to actually delete the duplicate(s) in
 * each group, keeping the row with the most transcript_chunks (ties broken
 * by earliest ingested_at). transcript_chunks cascade-delete with their
 * video row (see schema.sql: `references videos(id) on delete cascade`),
 * so deleting a duplicate video row also removes its orphaned chunks --
 * this cannot be undone, so review the report first.
 *
 * Run:
 *   node scripts/find_duplicate_legacy_videos.js            # report only
 *   node scripts/find_duplicate_legacy_videos.js --merge    # delete duplicates
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const MERGE = process.argv.includes('--merge');
const DURATION_TOLERANCE_MS = 200; // group durations within 0.2s of each other

function buildSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function getOrphanedVideos(supabase) {
  const all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('videos')
      .select('id, file_name, title, total_duration_ms, ingested_at')
      .is('video_drive_id', null)
      .order('total_duration_ms', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`videos select: ${error.message}`);
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function countChunks(supabase, videoId) {
  const { count, error } = await supabase
    .from('transcript_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('video_id', videoId);
  if (error) throw new Error(`chunks count: ${error.message}`);
  return count || 0;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  }

  const supabase = buildSupabase();

  console.log('Fetching orphaned Supabase rows (no video_drive_id)...');
  const orphans = await getOrphanedVideos(supabase);
  console.log(`Found ${orphans.length} orphaned row(s).\n`);

  // Group by duration within tolerance. Since the list is duration-sorted,
  // a simple adjacent-merge sweep is enough to bucket near-identical durations.
  const groups = [];
  for (const o of orphans) {
    if (o.total_duration_ms == null) { groups.push([o]); continue; }
    const last = groups[groups.length - 1];
    const lastItem = last && last[last.length - 1];
    if (last && lastItem.total_duration_ms != null &&
        Math.abs(o.total_duration_ms - lastItem.total_duration_ms) <= DURATION_TOLERANCE_MS) {
      last.push(o);
    } else {
      groups.push([o]);
    }
  }

  const dupGroups = groups.filter(g => g.length > 1);
  const uniqueGroups = groups.filter(g => g.length === 1);

  console.log('='.repeat(70));
  console.log('DUPLICATE REPORT (same duration, different rows)');
  console.log('='.repeat(70));

  let toDelete = [];

  for (const g of dupGroups) {
    const durS = (g[0].total_duration_ms / 1000).toFixed(1);
    console.log(`\nDuration ~${durS}s — ${g.length} row(s):`);
    // Need chunk counts to decide which row to keep.
    const withCounts = [];
    for (const o of g) {
      const chunkCount = await countChunks(supabase, o.id);
      withCounts.push({ ...o, chunkCount });
      console.log(`  - id=${o.id}  "${o.title || o.file_name}"  chunks=${chunkCount}  ingested_at=${o.ingested_at}`);
    }
    withCounts.sort((a, b) => b.chunkCount - a.chunkCount || new Date(a.ingested_at) - new Date(b.ingested_at));
    const keep = withCounts[0];
    const drop = withCounts.slice(1);
    console.log(`  -> KEEP id=${keep.id} (most chunks), DROP ${drop.map(d => d.id).join(', ')}`);
    toDelete.push(...drop);
  }

  console.log('\n' + '='.repeat(70));
  console.log(`SUMMARY: ${dupGroups.length} duplicate group(s) covering ${dupGroups.flat().length} row(s) (${toDelete.length} to drop), ${uniqueGroups.length} row(s) with no duplicate.`);
  console.log('='.repeat(70));

  if (!MERGE) {
    if (toDelete.length) console.log('\nRe-run with --merge to delete the duplicate rows listed above (and their transcript_chunks, via cascade).');
    return;
  }

  console.log(`\nDeleting ${toDelete.length} duplicate row(s)...`);
  let deleted = 0;
  for (const d of toDelete) {
    const { error } = await supabase.from('videos').delete().eq('id', d.id);
    if (error) console.log(`  ⚠️  failed to delete ${d.id}: ${error.message}`);
    else { console.log(`  🗑️  deleted ${d.id} ("${d.title || d.file_name}")`); deleted++; }
  }
  console.log(`\nDone. Deleted ${deleted}/${toDelete.length}.`);
  console.log('Next: re-run match_legacy_videos.js (report, then --apply) to backfill video_drive_id for the survivors.');
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
