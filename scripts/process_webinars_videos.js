/**
 * process_webinars_videos.js
 *
 * Thin wrapper around process_new_videos.js, pointed at the Webinars folder
 * in the SafetyWing Content shared drive. Keeps this pipeline completely
 * separate from the SF and Norway 2026 runs -- does NOT touch .env.
 *
 *   Scans:  Webinars/Videos        (PROXIES_FOLDER_ID)
 *   Writes: Webinars/Transcripts   (SHARED_DRIVE_FOLDER_ID = Webinars,
 *           so the script finds the existing Transcripts folder next to Videos)
 *
 * Video copy-back is off: proxies and output Videos live in the same folder
 * here, so there's nothing to copy. Instead the original file is renamed in
 * place (same Drive file ID, dedup unaffected) so it matches its transcript's
 * title.
 *
 * dotenv (loaded inside process_new_videos.js) does not override variables
 * already set on process.env, so setting these here before requiring it
 * takes precedence over whatever's in .env.
 *
 * --- Why this loops instead of calling main() once -------------------------
 * process_new_videos.js caps itself at MAX_VIDEOS_PER_RUN (default 8) per
 * call -- that's intentional for a recurring cron job, but it means a single
 * manual invocation of this script used to silently stop after 8 videos with
 * no loud warning, leaving the rest of the backlog unprocessed. That's
 * exactly what happened on 2026-06: 25 videos in Webinars/Videos, only 14
 * transcripts came out, and nothing told anyone the run was incomplete.
 *
 * Fixed two ways:
 *   1. process_new_videos.js now prints a 🚨 warning whenever a pass leaves
 *      videos unprocessed, and reports `stillRemaining` in its return value.
 *   2. This wrapper calls main() in a loop until stillRemaining hits 0,
 *      so one manual run always finishes the entire backlog (or stops and
 *      tells you exactly why it can't, instead of stopping silently).
 *
 * Run manually:
 *   node scripts/process_webinars_videos.js
 *
 * Dedup is still by Supabase row (source Drive file ID), so it's always
 * safe to re-run or interrupt -- nothing gets processed twice.
 */

process.env.PROXIES_FOLDER_ID      = '1M1YdA7ILePOSq3gAe34D--GQhyLs-SD1'; // Webinars/Videos
process.env.SHARED_DRIVE_FOLDER_ID = '19NPYGQjPbZUm4eccExqY6bSav-z1xb5o'; // Webinars
process.env.COPY_VIDEO_TO_DRIVE    = 'false';
process.env.RENAME_VIDEO_IN_PLACE  = 'true'; // proxies === output Videos folder, so rename in place instead of copying
process.env.COLLECTION             = 'Webinars'; // tags rows so the search UI's folder filter can scope to just this event

const { main } = require('./process_new_videos');

const MAX_PASSES = 25; // safety cap: 25 passes * 8 videos/pass = up to 200 videos per invocation

async function run() {
  let totalProcessed = 0;
  let totalFailed = 0;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    console.log(`\n========== Webinars pipeline — pass ${pass} ==========`);
    const result = await main();
    totalProcessed += result.processed;
    totalFailed += result.failed;

    if (result.stillRemaining === 0) {
      console.log(`\n✅ All Webinars videos processed. Totals this invocation — processed: ${totalProcessed}, failed: ${totalFailed}.`);
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
