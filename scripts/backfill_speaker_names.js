/**
 * backfill_speaker_names.js
 *
 * Re-scans every video already ingested into Supabase and tries to identify
 * each speaker from how they introduce THEMSELVES in the transcript text
 * ("I'm Sara", "I am Brennan Cowley", "my name is Lona") — then corrects the
 * `speaker_name` column wherever that differs from what's currently stored.
 *
 * Detection logic lives in scripts/lib/speaker_names.js, shared with every
 * live transcription entry point. It fixes two real bugs found in production
 * data:
 *   1. Third-person intros like "this is Sara" name whoever is being
 *      INTRODUCED, not whoever is talking — a host saying "...and this is
 *      Sara, our..." while introducing a guest got the host's lines
 *      permanently labeled "Sara". Never matched.
 *   2. First-match-wins meant a single false positive permanently locked in
 *      a wrong name and a real self-intro later in the same conversation was
 *      never checked — e.g. "I'm Head of People at..." captured "Head", and
 *      a transcription disfluency capitalized as a stray word captured
 *      "Sexism" as a name, in both cases overriding a correct "I'm Sara
 *      Sandnes" found elsewhere in the same video. Fixed by scoring every
 *      candidate across the whole conversation — weighting "my name is"
 *      over a bare "I'm X", multi-word (full name) matches heavily, and
 *      rejecting known non-name words (job titles, discourse fillers) —
 *      instead of stopping at the first hit.
 *
 * Only `chunk_type = 'segment'` text is scanned (sliding-window chunks blend
 * multiple speakers' words together and would produce false matches), but a
 * confirmed name is applied to ALL chunk types for that (video_id,
 * speaker_label) pair, since search results read from every chunk type.
 *
 * Safety:
 *   - Defaults to DRY RUN — prints every proposed change, writes nothing.
 *   - Pass --apply to actually write to Supabase.
 *   - If two different speakers in the SAME video resolve to the same name,
 *     both are skipped and flagged for manual review (almost always means a
 *     name was mentioned in passing, not actually self-introduced).
 *   - Never touches a speaker whose current name looks human-assigned and no
 *     self-intro is found — it only fills gaps / fixes ones it can prove
 *     wrong from the transcript text itself.
 *
 * Run:
 *   node scripts/backfill_speaker_names.js            # dry run, all videos
 *   node scripts/backfill_speaker_names.js --apply     # write the fixes
 *   node scripts/backfill_speaker_names.js --apply --video-id "<id>"   # single video
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { detectNamesFromUtterances } = require('./lib/speaker_names');

const APPLY = process.argv.includes('--apply');
const videoIdArgIdx = process.argv.indexOf('--video-id');
const ONLY_VIDEO_ID = videoIdArgIdx !== -1 ? process.argv[videoIdArgIdx + 1] : null;

function buildSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function fetchAllRows(supabase, table, select, filterFn) {
  // Supabase caps at 1000 rows per request — page through.
  const all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function main() {
  const supabase = buildSupabase();

  console.log(APPLY ? '🔴  LIVE MODE — changes will be written to Supabase.\n' : '🟡  DRY RUN — no changes will be written. Pass --apply to write.\n');

  console.log('Loading videos...');
  const videos = await fetchAllRows(supabase, 'videos', 'id, title');
  const targetVideos = ONLY_VIDEO_ID ? videos.filter(v => v.id === ONLY_VIDEO_ID) : videos;
  console.log(`Checking ${targetVideos.length} video(s)...\n`);

  let totalUpdated = 0, totalFlagged = 0, totalUnchanged = 0;

  for (const video of targetVideos) {
    const segments = await fetchAllRows(
      supabase,
      'transcript_chunks',
      'id, speaker_label, speaker_name, text, start_ms',
      q => q.eq('video_id', video.id).eq('chunk_type', 'segment').order('start_ms', { ascending: true })
    );
    if (!segments.length) continue;

    // Group segment text by current speaker_label (for current-name lookup
    // and evidence display only — detection itself runs over the full
    // chronological order below, since the address-fallback signal and the
    // majority-vote scoring both depend on knowing utterance order across
    // ALL speakers, not just one speaker's lines in isolation).
    const bySpeaker = {};
    for (const s of segments) {
      const label = s.speaker_label || 'Unknown';
      if (!bySpeaker[label]) bySpeaker[label] = { texts: [], currentName: s.speaker_name };
      bySpeaker[label].texts.push(s.text);
    }

    // `segments` was already fetched ordered by start_ms ascending.
    const detected = detectNamesFromUtterances(
      segments.map(s => ({ speaker: s.speaker_label || 'Unknown', text: s.text }))
    );

    // Conflict check: same detected name used for >1 speaker_label in this video
    const nameCounts = {};
    for (const name of Object.values(detected)) nameCounts[name] = (nameCounts[name] || 0) + 1;
    const conflictedNames = new Set(Object.entries(nameCounts).filter(([, c]) => c > 1).map(([n]) => n));

    let videoHeaderPrinted = false;
    const printHeader = () => {
      if (videoHeaderPrinted) return;
      videoHeaderPrinted = true;
      console.log('='.repeat(70));
      console.log(`${video.title || video.id}`);
      console.log(`  (video_id: ${video.id})`);
      console.log('='.repeat(70));
    };

    for (const [label, info] of Object.entries(bySpeaker)) {
      const detectedName = detected[label];
      const currentName = info.currentName || label;

      if (!detectedName) {
        continue; // nothing to compare — leave as-is, not flagged (no evidence either way)
      }

      if (conflictedNames.has(detectedName)) {
        printHeader();
        console.log(`  ⚠️  SKIPPED (ambiguous): "${label}" detected as "${detectedName}", but another speaker in this video also matched "${detectedName}". Likely a name mentioned about someone else, not a self-intro. Needs manual review.`);
        totalFlagged++;
        continue;
      }

      if (detectedName === currentName) {
        totalUnchanged++;
        continue;
      }

      printHeader();
      console.log(`  ${APPLY ? '✏️  UPDATING' : '🔍 WOULD UPDATE'}: "${label}" — current: "${currentName}"  →  detected: "${detectedName}"`);
      // Evidence is just for the human reading dry-run output — find any
      // line containing the detected name to show why it won.
      const sampleQuote = info.texts.find(t => t.includes(detectedName)) || info.texts[0];
      console.log(`      evidence: "${sampleQuote.slice(0, 120)}${sampleQuote.length > 120 ? '...' : ''}"`);

      if (APPLY) {
        const { error } = await supabase
          .from('transcript_chunks')
          .update({ speaker_name: detectedName })
          .eq('video_id', video.id)
          .eq('speaker_label', label);
        if (error) {
          console.log(`      ❌ write failed: ${error.message}`);
        } else {
          totalUpdated++;
        }
      } else {
        totalUpdated++; // counted as "would update" in dry run
      }
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log(APPLY ? 'Backfill complete.' : 'Dry run complete — nothing was written.');
  console.log(`  ${APPLY ? 'Updated' : 'Would update'}: ${totalUpdated}`);
  console.log(`  Flagged for manual review (ambiguous): ${totalFlagged}`);
  console.log(`  Already correct / no change needed: ${totalUnchanged}`);
  console.log('═'.repeat(50));
  if (!APPLY && totalUpdated > 0) {
    console.log('\nRe-run with --apply to write these changes.');
  }
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
