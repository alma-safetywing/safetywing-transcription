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
 * Run manually:
 *   node scripts/process_norway_videos.js
 *
 * Same cron-safety guarantees as process_new_videos.js: bounded per run,
 * dedup by Supabase row (source Drive file ID), safe to re-run / schedule.
 */

process.env.PROXIES_FOLDER_ID      = '1E9nAnRKL4XnpdykJD__WC17HvIo0szAO'; // Norway 2026/Videos
process.env.SHARED_DRIVE_FOLDER_ID = '1hNrhmERcmsA_WeDivPoI6G_OlZqUWiH4'; // Norway 2026
process.env.COPY_VIDEO_TO_DRIVE    = 'false';
process.env.RENAME_VIDEO_IN_PLACE  = 'true'; // proxies === output Videos folder, so rename in place instead of copying

const { main } = require('./process_new_videos');

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
