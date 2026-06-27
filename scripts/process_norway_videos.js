/**
 * process_norway_videos.js
 *
 * Thin wrapper around process_new_videos.js, pointed at the new SafetyWing
 * Content shared drive instead of the old Flight Week one. Keeps the two
 * pipelines completely separate -- this does NOT touch .env or affect the
 * existing SF proxies run.
 *
 *   Scans:  Norway 2026/Videos        (PROXIES_FOLDER_ID)
 *   Writes: Norway 2026/Transcripts   (SHARED_DRIVE_FOLDER_ID = Norway 2026,
 *           so the script finds the existing Transcripts folder next to Videos)
 *
 * Video copy-back is off: proxies and output Videos live in the same folder
 * here, so there's nothing to copy. Instead the original file is renamed in
 * place (same Drive file ID, dedup unaffected) so it matches its transcript's
 * title. Transcription is locked to English.
 *
 * dotenv (loaded inside process_new_videos.js) does not override variables
 * already set on process.env, so setting these here before requiring it
 * takes precedence over whatever's in .env.
 *
 * --- Why this loops instead of calling main() once -------------------------
 * process_new_videos.js caps itself at MAX_VIDEOS_PER_RUN (default 8) per
 * call -- intentional for a recurring cron job, but it means a single manual
 * invocation used to silently stop after 8 videos with no warning, leaving
 * the rest of a backlog unprocessed (this is what happened to the Webinars
 * pipeline: 25 videos in, only 14 transcripts out, no warning). Fixed by
 * looping main() until it reports nothing left, instead of calling it once.
 *
 * Run manually:
 *   node scripts/process_norway_videos.js
 *
 * Dedup is still by Supabase row (source Drive file ID), so it's always
 * safe to re-run or interrupt -- nothing gets processed twice.
 */

process.env.PROXIES_FOLDER_ID      = '1E9nAnRKL4XnpdykJD__WC17HvIo0szAO'; // Norway 2026/Videos
process.env.SHARED_DRIVE_FOLDER_ID = '1hNrhmERcmsA_WeDivPoI6G_OlZqUWiH4'; // Norway 2026
process.env.COPY_VIDEO_TO_DRIVE    = 'false';
process.env.RENAME_VIDEO_IN_PLACE  = 'true'; // proxies === output Videos folder, so rename in place instead of copying
process.env.COLLECTION             = 'Norway 2026'; // tags rows so the search UI's folder filter can scope to just this event

const { main } = require('./process_new_videos');

const MAX_PASSES = 25; // safety cap: 25 passes * 8 videos/pass = up to 200 videos per invocation

async function run() {
  let totalProcessed = 0;
  let totalFailed = 0;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    console.log(`\n========== Norway 2026 pipeline — pass ${pass} ==========`);
    const result = await main();
    totalProcessed += result.processed;
    totalFailed += result.failed;

    if (result.stillRemaining === 0) {
      console.log(`\n✅ All Norway 2026 videos processed. Totals this invocation — processed: ${totalProcessed}, failed: ${totalFailed}.`);
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
