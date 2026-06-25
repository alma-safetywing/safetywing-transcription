/**
 * match_legacy_videos.js
 *
 * The 52 Supabase video rows with no video_drive_id were ingested from old
 * transcript-only JSON files (via ingest_transcripts.js) and never recorded
 * which source video they came from. There's no ID to look up directly, so
 * this script recovers the link by matching transcript duration against the
 * duration of every video file found (recursively) under a given Drive
 * folder -- the original raw-footage folder, presumably containing the
 * Day 1 / Day 3 source clips.
 *
 * Read-only by default: prints a match report, does not touch Supabase.
 * Pass --apply to write video_drive_id back to Supabase for confident
 * matches only (exactly one candidate within a tight duration tolerance,
 * and that candidate isn't also the top match for a different orphan).
 *
 * After running with --apply, re-run export_videos_for_days.js to actually
 * copy the now-linked videos into Videos/SF Content Week 2026/<Day X>/.
 *
 * Run:
 *   node scripts/match_legacy_videos.js              # report only
 *   node scripts/match_legacy_videos.js --apply       # also writes matches
 */

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const SOURCE_FOLDER_ID = '1PYaVpIoaaszLaM-T-sE73SI4GI7w_Q45';
const APPLY = process.argv.includes('--apply');
const TIGHT_TOLERANCE_MS = 1500;  // confident auto-match
const LOOSE_TOLERANCE_MS = 8000;  // still shown as a candidate, but flagged ambiguous

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

async function walkVideos(drive, folderId, pathSoFar, out) {
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, videoMediaMetadata)',
      pageSize: 200,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files) {
      const childPath = pathSoFar.concat(f.name);
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        await walkVideos(drive, f.id, childPath, out);
      } else if (f.mimeType && f.mimeType.startsWith('video/')) {
        const durationMs = f.videoMediaMetadata?.durationMillis
          ? parseInt(f.videoMediaMetadata.durationMillis, 10)
          : null;
        out.push({ id: f.id, name: f.name, path: childPath.join('/'), durationMs });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
}

async function getOrphanedVideos(supabase) {
  const all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('videos')
      .select('id, file_name, title, total_duration_ms, speaker_count')
      .is('video_drive_id', null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`videos select: ${error.message}`);
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function main() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');

  const drive = buildDrive();
  const supabase = buildSupabase();

  console.log(`Scanning source folder ${SOURCE_FOLDER_ID} for video files (recursive)...`);
  let driveVideos = [];
  try {
    await walkVideos(drive, SOURCE_FOLDER_ID, [], driveVideos);
  } catch (err) {
    console.error(`\nCould not read the source folder: ${err.message}`);
    console.error('If this is a 403/404, the service account likely needs to be added as a');
    console.error('viewer on that folder (link-sharing alone may not be enough).');
    const clientEmail = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email;
    if (clientEmail) console.error(`Service account email: ${clientEmail}`);
    process.exit(1);
  }
  console.log(`Found ${driveVideos.length} video file(s) total.`);
  const withDuration = driveVideos.filter(v => v.durationMs != null);
  console.log(`${withDuration.length} of those have duration metadata available.\n`);

  console.log('Fetching orphaned Supabase rows (no video_drive_id)...');
  const orphans = await getOrphanedVideos(supabase);
  console.log(`Found ${orphans.length} orphaned transcript row(s).\n`);

  const results = orphans.map(o => {
    const candidates = withDuration
      .filter(() => o.total_duration_ms != null)
      .map(v => ({ ...v, diff: Math.abs(v.durationMs - o.total_duration_ms) }))
      .filter(v => v.diff <= LOOSE_TOLERANCE_MS)
      .sort((a, b) => a.diff - b.diff);
    return { orphan: o, candidates };
  });

  // A drive video can only be the confident match for one orphan. If two
  // orphans both rank it #1, neither is confident -- needs a human look.
  const topClaimCount = new Map();
  for (const r of results) {
    if (r.candidates.length) {
      const topId = r.candidates[0].id;
      topClaimCount.set(topId, (topClaimCount.get(topId) || 0) + 1);
    }
  }

  console.log('='.repeat(70));
  console.log('MATCH REPORT');
  console.log('='.repeat(70));

  let confident = 0, ambiguous = 0, noMatch = 0, saved = 0;

  for (const r of results) {
    const label = r.orphan.title || r.orphan.file_name || r.orphan.id;
    const dur = r.orphan.total_duration_ms;
    console.log(`\n[${label}]  transcript duration: ${dur != null ? (dur / 1000).toFixed(1) + 's' : 'unknown'}`);

    if (!r.candidates.length) {
      console.log('  -> no candidate video found within tolerance.');
      noMatch++;
      continue;
    }

    const top = r.candidates[0];
    const isUniqueClaim = (topClaimCount.get(top.id) || 0) === 1;
    const isConfident = top.diff <= TIGHT_TOLERANCE_MS && isUniqueClaim;

    for (const c of r.candidates.slice(0, 3)) {
      const mark = c === top && isConfident ? '✅' : '❓';
      console.log(`  ${mark} ${c.path}  (video ${(c.durationMs / 1000).toFixed(1)}s, diff ${(c.diff / 1000).toFixed(1)}s)`);
    }
    if (r.candidates.length > 3) console.log(`  ...and ${r.candidates.length - 3} more candidate(s) within tolerance`);

    if (isConfident) {
      confident++;
      if (APPLY) {
        const { error } = await supabase.from('videos').update({ video_drive_id: top.id }).eq('id', r.orphan.id);
        if (error) console.log(`  ⚠️  failed to save match: ${error.message}`);
        else { console.log('  💾 saved video_drive_id to Supabase.'); saved++; }
      }
    } else {
      ambiguous++;
      console.log('  -> ambiguous (contested or no candidate within tight tolerance), needs manual review.');
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(`SUMMARY: ${confident} confident match(es)${APPLY ? ` (${saved} saved)` : ' -- re-run with --apply to save these'}, ${ambiguous} ambiguous, ${noMatch} no candidate found.`);
  console.log('='.repeat(70));
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
