/**
 * process_sf_content_week_videos.js
 *
 * Thin wrapper around process_new_videos.js, pointed at the "SF Content Week
 * 2026" folder in the SafetyWing Content shared drive. Same pattern as
 * process_norway_videos.js and process_webinars_videos.js -- one explicit,
 * named script per content source, so it's never ambiguous which folder a
 * pipeline run will actually touch (the previous setup relied on bare .env
 * defaults that had drifted to point at an unrelated folder outside the
 * shared drive entirely -- see .env comments for the full story).
 *
 *   Scans:  SF Content Week 2026/Videos   (PROXIES_FOLDER_ID)
 *   Writes: SF Content Week 2026/Transcripts (SHARED_DRIVE_FOLDER_ID =
 *           SF Content Week 2026, so the script finds the existing
 *           Transcripts folder next to Videos)
 *
 * Video copy-back is off: proxies and output Videos are the SAME folder here
 * (new footage gets uploaded straight into SF Content Week 2026/Videos), so
 * there's nothing to copy. Instead the original file is renamed in place
 * (same Drive file ID, dedup unaffected) so it matches its transcript's title.
 *
 * This does NOT touch the legacy "SF Content Week" Shared Drive (Day 1-4 +
 * Proxies, a totally separate Drive from "SafetyWing Content") where the
 * original footage lives -- those videos are already in Supabase and linked
 * via match_legacy_videos.js. This script is only for NEW footage uploaded
 * going forward, through the new designed pathway:
 *   SafetyWing Content > SF Content Week 2026 > Videos
 *
 * dotenv (loaded inside process_new_videos.js) does not override variables
 * already set on process.env, so setting these here before requiring it
 * takes precedence over whatever's in .env.
 *
 * Loops main() until the whole backlog is processed (see process_norway_videos.js
 * for why -- a single bounded call used to silently leave videos unprocessed
 * with no warning).
 *
 * Run manually:
 *   node scripts/process_sf_content_week_videos.js
 *
 * Dedup is still by Supabase row (source Drive file ID), so it's always
 * safe to re-run or interrupt -- nothing gets processed twice.
 */

process.env.PROXIES_FOLDER_ID      = '1Y8ZxO3Ck5a68FZq580ioGdpGQyXqx0Hn'; // SF Content Week 2026/Videos
process.env.SHARED_DRIVE_FOLDER_ID = '1Zfc5A4Nb0aZS3rHIssL6WX2fmiN3_Miy'; // SF Content Week 2026
process.env.COPY_VIDEO_TO_DRIVE    = 'false';
process.env.RENAME_VIDEO_IN_PLACE  = 'true';

const { main } = require('./process_new_videos');

const MAX_PASSES = 25; // safety cap: 25 passes * 8 videos/pass = up to 200 videos per invocation

async function run() {
  let totalProcessed = 0;
  let totalFailed = 0;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    console.log(`\n========== SF Content Week 2026 pipeline — pass ${pass} ==========`);
    const result = await main();
    totalProcessed += result.processed;
    totalFailed += result.failed;

    if (result.stillRemaining === 0) {
      console.log(`\n✅ All SF Content Week 2026 videos processed. Totals this invocation — processed: ${totalProcessed}, failed: ${totalFailed}.`);
      return;
    }

    if (result.processed === 0) {
      console.log(`\n🚨 No forward progress this pass (${result.stillRemaining} video(s) still unprocessed, every attempt this pass failed).`);
      console.log('🚨 Stopping here instead of retrying forever -- check the FAILED messages above for the actual error per video.');
      return;
    }
  }

  console.log(`\n⚠️  Hit the safety cap of ${MAX_PASSES} passes (up to ${MAX_PASSES * 8} videos). Run this script again to continue with the rest.`);
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
