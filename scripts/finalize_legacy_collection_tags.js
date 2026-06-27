/**
 * finalize_legacy_collection_tags.js
 *
 * Closes out the last 6 untagged rows from backfill_collection_tags.js:
 *   - CODC3_0001_1, 0003_1, 0035_1, 0036_1, 0039_1: confirmed via
 *     check_legacy_video_drive_ids.js to be real, non-trashed files on the
 *     same legacy SF Content Week shared drive -- just raw camera originals
 *     (no "_1" proxy suffix) living in a sibling folder to "Proxies", which
 *     is why the Proxies-only scan in backfill_collection_tags.js missed
 *     them. No ambiguity about which event they're from.
 *   - CODC3_0004_1: has no video_drive_id at all (a separate, pre-existing
 *     orphan-linking gap flagged by match_legacy_videos.js), but its id/
 *     title/naming convention make it unambiguously part of the same legacy
 *     batch as the other 21 CODC3_* rows already tagged "SF Content Week 2026".
 *
 * This sets collection directly for these 6 specific row IDs rather than
 * widening the Drive scan to the whole shared drive -- we already have
 * positive identification for each one.
 *
 * Run:
 *   node scripts/finalize_legacy_collection_tags.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const IDS = ['CODC3_0001_1', 'CODC3_0003_1', 'CODC3_0004_1', 'CODC3_0035_1', 'CODC3_0036_1', 'CODC3_0039_1'];
const COLLECTION = 'SF Content Week 2026';

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  for (const id of IDS) {
    const { error } = await supabase.from('videos').update({ collection: COLLECTION }).eq('id', id);
    if (error) {
      console.log(`❌ ${id}: ${error.message}`);
    } else {
      console.log(`✓ ${id} -> "${COLLECTION}"`);
    }
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
