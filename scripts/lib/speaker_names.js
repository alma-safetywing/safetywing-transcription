/**
 * speaker_names.js
 *
 * Shared self-identification name detector used by every transcription
 * entry point (process_new_videos.js, organize_and_transcribe.js,
 * transcribe_videos.js) and by the retroactive backfill_speaker_names.js.
 * Centralized here so a fix only has to be made once instead of kept in
 * sync by hand across four copy-pasted versions (which is how this drifted
 * in the first place: organize_and_transcribe.js had already dropped the
 * dangerous third-person pattern below, but process_new_videos.js and
 * transcribe_videos.js — the scripts actually wrapped by every current
 * collection pipeline — still had the old, buggier version).
 *
 * Real bugs this exists to prevent, all observed in production data:
 *
 *   1. Third-person intros ("this is Sara", "I'd like you to meet Brennan")
 *      name whoever is being INTRODUCED, not whoever is talking. A host
 *      saying "...and this is Sara, our..." while introducing a guest got
 *      the HOST permanently labeled "Sara". Fix: never match third-person
 *      phrasing as a name for the CURRENT speaker. (A much weaker, safe
 *      version of "addressing someone by name" is reintroduced below, but
 *      it only ever votes for whoever speaks NEXT — never the speaker who
 *      said it — so it can't repeat this bug.)
 *
 *   2. First-match-wins meant a single false positive permanently locked in
 *      a wrong name and any real self-intro later in the same conversation
 *      was never even checked. Two concrete examples:
 *        - "I'm Head of People at Tubetical" → captured "Head" as the name,
 *          because the regex just grabs the capitalized word after "I'm"
 *          with no idea it's a job title.
 *        - An ASR disfluency/restart capitalized a stray word as if it were
 *          a sentence start → captured "Sexism" as a name, even though the
 *          same speaker properly said "I'm Sara Sandnes" elsewhere in the
 *          same conversation.
 *      Fix: scan every utterance, score every candidate, and pick the
 *      best-supported one instead of the first one found.
 *
 * Scoring: "my name is/my name's" is a far more deliberate self-ID than a
 * bare "I'm X" (which is a common disfluency starter — "I'm- sorry, I..."),
 * so it's weighted higher. Multi-word matches ("Sara Sandnes") are almost
 * always real full names — a stray capitalized word is essentially never
 * followed by a second capitalized word — so they get a large bonus. Known
 * non-name words (job titles, discourse fillers, this dataset's recurring
 * topic words) are rejected outright regardless of pattern.
 */

const NAME = '([A-Z][a-záéíóúñ]+(?:\\s+[A-Z][a-záéíóúñ]+)?)';

const SELF_INTRO_PATTERNS = [
  { re: new RegExp(`\\bmy name'?s\\s+${NAME}\\b`, 'i'), weight: 4 },
  { re: new RegExp(`\\bmy name is\\s+${NAME}\\b`, 'i'), weight: 4 },
  { re: new RegExp(`\\bI am\\s+${NAME}\\b`), weight: 2 },
  { re: new RegExp(`\\bI'?m\\s+${NAME}\\b`), weight: 1 },
];

// Direct address at the START of an utterance, e.g. "Sara, can you tell us
// about...". Weak signal (weight 1) — only ever votes for whoever speaks
// NEXT, never the speaker who said it.
const ADDRESS_PATTERN = new RegExp(`^${NAME},\\s`);

// Words that match the NAME regex (capitalized) but routinely aren't names.
// Grown from real mislabels seen in this dataset — extend as new ones turn up.
const NON_NAME_WORDS = new Set([
  // discourse fillers / sentence-initial ASR capitalization artifacts
  'head', 'the', 'a', 'an', 'also', 'actually', 'basically', 'honestly',
  'sorry', 'yeah', 'yes', 'no', 'okay', 'ok', 'so', 'well', 'and', 'but',
  'just', 'really', 'speaking', 'here', 'now', 'currently', 'still',
  'always', 'definitely', 'probably', 'literally', 'right', 'sure', 'um',
  'uh', 'like', 'totally', 'absolutely', 'obviously',
  // job titles / role words that follow "I'm" but aren't a name
  'director', 'manager', 'founder', 'cofounder', 'president', 'chief',
  'lead', 'senior', 'engineer', 'designer', 'product', 'marketing',
  'sales', 'operations', 'ceo', 'cto', 'coo', 'cfo', 'cmo', 'vp', 'svp',
  'evp', 'intern', 'consultant', 'people',
  // states/topics that show up capitalized mid-sentence in this dataset
  'excited', 'happy', 'proud', 'passionate', 'responsible', 'working',
  'part', 'sexism', 'racism', 'ageism', 'bias', 'diversity', 'equity',
  'inclusion', 'hiring', 'culture', 'leadership',
]);

function isLikelyName(candidate) {
  const words = candidate.trim().split(/\s+/);
  if (words.length > 1) return true; // multi-word matches are almost always real names
  return !NON_NAME_WORDS.has(words[0].toLowerCase());
}

/**
 * @param {{speaker: string, text: string}[]} utterances — chronological order
 * @returns {{[speaker: string]: string}} best-guess name per speaker label
 */
function detectNamesFromUtterances(utterances) {
  const scores = {}; // speaker -> { candidateName -> score }
  const list = utterances || [];

  const vote = (speaker, name, weight) => {
    scores[speaker] = scores[speaker] || {};
    scores[speaker][name] = (scores[speaker][name] || 0) + weight;
  };

  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    if (!u?.text) continue;

    for (const { re, weight } of SELF_INTRO_PATTERNS) {
      const m = u.text.match(re);
      if (!m?.[1]) continue;
      const candidate = m[1].trim();
      if (!isLikelyName(candidate)) continue;
      const multiWordBonus = candidate.includes(' ') ? 3 : 0;
      vote(u.speaker, candidate, weight + multiWordBonus);
    }

    const addr = u.text.match(ADDRESS_PATTERN);
    const next = list[i + 1];
    if (addr?.[1] && next && next.speaker !== u.speaker && isLikelyName(addr[1])) {
      vote(next.speaker, addr[1].trim(), 1);
    }
  }

  const found = {};
  for (const [speaker, candidates] of Object.entries(scores)) {
    const ranked = Object.entries(candidates).sort((a, b) => b[1] - a[1]);
    if (ranked.length) found[speaker] = ranked[0][0];
  }
  return found;
}

module.exports = { detectNamesFromUtterances, isLikelyName, NON_NAME_WORDS };
