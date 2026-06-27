/**
 * speaker_names.js
 *
 * Shared self-identification name detector used by every transcription
 * entry point (process_new_videos.js, organize_and_transcribe.js,
 * transcribe_videos.js) and by the retroactive backfill_speaker_names.js.
 * Centralized here so a fix only has to be made once instead of kept in
 * sync by hand across four copy-pasted versions.
 *
 * Deliberately conservative. An earlier version of this file tried to be
 * clever — scoring weak signals like a bare "I'm X" and a "name, comma"
 * vocative address — and that backfired: it kept recognizing random
 * capitalized words as names and mislabeling speakers, which is worse than
 * just showing "Speaker 1" / "Speaker 2". Per explicit user direction: only
 * assign a name when there's a DISTINCT, unambiguous signal —
 *
 *   1. An explicit self-identification phrase: "my name is X" / "my name's
 *      X". This is checked regardless of word count, since saying "my name
 *      is ___" is inherently a deliberate self-ID, not a disfluency.
 *
 *   2. A genuine full name (two consecutive capitalized words, e.g. "Sara
 *      Sandnes" or "Sondre Rasch") following "I'm" or "I am". A SINGLE
 *      capitalized word after "I'm"/"I am" is never trusted on its own —
 *      that's exactly what produced "Head" (from "I'm Head of People...")
 *      and "Sexism" (an ASR-capitalized stray word) in production data. Two
 *      consecutive capitalized words appearing together is a much stronger
 *      signal: stray capitalization or a job title essentially never
 *      produces two capitalized words in a row.
 *
 * No third-person ("this is X") matching, ever — that names whoever is
 * being introduced, not whoever is talking, and mislabeled a host with a
 * guest's name in production data. No vocative/address fallback either
 * (removed — it was a guess, not a distinct name).
 *
 * If nothing matches for a speaker, this returns no entry for them — the
 * caller keeps the speaker's existing generic label ("Speaker 1", etc.)
 * rather than ever guessing.
 */

// A real full name: two consecutive capitalized words.
const FULL_NAME = "([A-Z][a-zA-Zàáéíóúñ'-]+\\s+[A-Z][a-zA-Zàáéíóúñ'-]+)";
// Anything after "my name is" — explicit enough to trust even single-word.
const ANY_NAME = "([A-Z][a-zA-Zàáéíóúñ'-]+(?:\\s+[A-Z][a-zA-Zàáéíóúñ'-]+)?)";

const PATTERNS = [
  // Most reliable: explicit self-identification.
  { re: new RegExp(`\\bmy name'?s\\s+${ANY_NAME}\\b`, 'i') },
  { re: new RegExp(`\\bmy name is\\s+${ANY_NAME}\\b`, 'i') },
  // Only trust "I'm"/"I am" when followed by a genuine two-word full name.
  { re: new RegExp(`\\bI am\\s+${FULL_NAME}\\b`) },
  { re: new RegExp(`\\bI'?m\\s+${FULL_NAME}\\b`) },
];

// Safety net even for the explicit "my name is" pattern, in case of an odd
// phrase like "my name is the one everyone forgets" — extend as needed.
const NON_NAME_WORDS = new Set([
  'head', 'the', 'a', 'an', 'also', 'actually', 'basically', 'honestly',
  'sorry', 'yeah', 'yes', 'no', 'okay', 'ok', 'so', 'well', 'and', 'but',
  'just', 'really', 'speaking', 'here', 'now', 'currently', 'still',
  'always', 'definitely', 'probably', 'literally', 'right', 'sure', 'um',
  'uh', 'like', 'totally', 'absolutely', 'obviously',
  'director', 'manager', 'founder', 'cofounder', 'president', 'chief',
  'lead', 'senior', 'engineer', 'designer', 'product', 'marketing',
  'sales', 'operations', 'ceo', 'cto', 'coo', 'cfo', 'cmo', 'vp', 'svp',
  'evp', 'intern', 'consultant', 'people',
  'excited', 'happy', 'proud', 'passionate', 'responsible', 'working',
  'part', 'sexism', 'racism', 'ageism', 'bias', 'diversity', 'equity',
  'inclusion', 'hiring', 'culture', 'leadership',
]);

function isLikelyName(candidate) {
  const words = candidate.trim().split(/\s+/);
  if (words.length > 1) return true; // a genuine two-word name is trusted outright
  return !NON_NAME_WORDS.has(words[0].toLowerCase());
}

/**
 * @param {{speaker: string, text: string}[]} utterances — chronological order
 * @returns {{[speaker: string]: string}} name per speaker, only where a
 *   distinct self-ID was actually found. Speakers with no match are simply
 *   absent from the result — never guessed.
 */
function detectNamesFromUtterances(utterances) {
  const found = {};
  const list = utterances || [];

  for (const u of list) {
    if (!u?.text || found[u.speaker]) continue; // first confident match wins
    for (const { re } of PATTERNS) {
      const m = u.text.match(re);
      if (!m?.[1]) continue;
      const candidate = m[1].trim();
      if (!isLikelyName(candidate)) continue;
      found[u.speaker] = candidate;
      break;
    }
  }

  return found;
}

module.exports = { detectNamesFromUtterances, isLikelyName, NON_NAME_WORDS };
