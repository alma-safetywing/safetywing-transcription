/**
 * Shared helper: walks a Drive file's parent chain looking for a "Day X"
 * folder name.
 *
 * Retries transient/rate-limit errors with backoff instead of silently
 * giving up after one failed call. A tight loop that fires hundreds of
 * sequential drive.files.get calls (every video × up to 6 parent levels)
 * can trip Google's per-100-second rate limit on the service account —
 * when that happens, an unguarded single-attempt lookup throws, gets
 * swallowed, and the video gets mislabeled "Unknown" even though it has a
 * perfectly good Day folder. That's what caused 52/71 videos to show up
 * as "Unknown" in diagnose_transcript_gap.js.
 */

function isRetryable(err) {
  const code = err.code || err.response?.status;
  return code === 403 || code === 429 || code === 500 || code === 503;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getWithRetry(drive, fileId, maxRetries = 4) {
  let attempt = 0;
  while (true) {
    try {
      return await drive.files.get({
        fileId,
        fields: 'id, name, parents',
        supportsAllDrives: true,
      });
    } catch (err) {
      attempt++;
      if (!isRetryable(err) || attempt > maxRetries) throw err;
      const delay = 500 * Math.pow(2, attempt - 1); // 500ms, 1s, 2s, 4s
      await sleep(delay);
    }
  }
}

// cache: Map<fileId, dayLabel>. verbose: log the actual error when a lookup
// gives up, instead of silently returning 'Unknown'. onError(fileId, err):
// optional callback so callers can aggregate failure reasons into a summary
// instead of relying on scrollback.
async function findDayLabel(drive, fileId, cache, { verbose = false, onError = null } = {}) {
  if (cache.has(fileId)) return cache.get(fileId);
  try {
    let currentId = fileId;
    for (let depth = 0; depth < 6 && currentId; depth++) {
      const res = await getWithRetry(drive, currentId);
      const m = res.data.name?.match(/day\s*\d+/i);
      if (m) {
        const label = m[0].replace(/\s+/g, ' ').replace(/day\s/i, 'Day ');
        cache.set(fileId, label);
        return label;
      }
      currentId = res.data.parents?.[0];
    }
  } catch (err) {
    if (verbose) {
      const code = err.code || err.response?.status || '';
      console.log(`\n    ⚠️  day-label lookup failed for ${fileId}: ${code} ${err.message}`);
    }
    if (onError) onError(fileId, err);
  }
  cache.set(fileId, 'Unknown');
  return 'Unknown';
}

module.exports = { findDayLabel, sleep };
