/**
 * ingest_transcripts.js
 *
 * Reads all transcript JSONs from Google Drive, chunks them into
 * 30s / 60s / 90s windows, generates OpenAI embeddings, and upserts
 * everything into Supabase. Safe to run multiple times — skips videos
 * that are already fully ingested.
 *
 * SETUP:
 *   1. Add to your .env:
 *        GOOGLE_SERVICE_ACCOUNT_JSON=<service account key JSON, single line>
 *        TRANSCRIPT_FOLDER_ID=<Drive folder ID containing transcript JSONs>
 *        OPENAI_API_KEY=<your OpenAI key>
 *        SUPABASE_URL=<https://xxxx.supabase.co>
 *        SUPABASE_SERVICE_KEY=<service_role key — NOT the anon key>
 *
 *   2. Install deps:
 *        npm install googleapis openai @supabase/supabase-js dotenv
 *
 *   3. Run the schema.sql in Supabase first (Dashboard → SQL Editor).
 *
 *   4. Fill in speaker_mappings.json (run identify_speakers.js first).
 *
 *   5. Run:
 *        node scripts/ingest_transcripts.js
 *
 *   Re-run any time new transcripts are added — already-ingested videos
 *   are skipped automatically.
 */

require('dotenv').config();
const { google } = require('googleapis');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const CHUNK_TARGETS_MS = [30_000, 60_000, 90_000]; // sliding window lengths
const CHUNK_LABEL      = { 30000: '30s', 60000: '60s', 90000: '90s' };
const EMBED_BATCH_SIZE = 20;   // OpenAI embeddings per request
const EMBED_MODEL      = 'text-embedding-3-small'; // 1536 dims, cheap + fast

// ─── Clients ─────────────────────────────────────────────────────────────────

function buildClients() {
  // Google Drive
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ['https://www.googleapis.com/auth/drive'], // full scope needed for rename
  });
  const drive = google.drive({ version: 'v3', auth });

  // OpenAI
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Supabase (service role — can write to all tables)
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  return { drive, openai, supabase };
}

// ─── Speaker mappings ────────────────────────────────────────────────────────

function loadSpeakerMappings() {
  const p = path.join(process.cwd(), 'speaker_mappings.json');
  if (!fs.existsSync(p)) {
    console.warn('⚠️  speaker_mappings.json not found — speaker names will be null.');
    return {};
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function resolveSpeakerName(mappings, videoId, speakerLabel) {
  const videoMap = mappings[videoId] || {};
  const name = videoMap[speakerLabel];
  if (!name || name === 'FILL_IN_NAME') return null;
  return name;
}

// ─── Google Drive helpers ────────────────────────────────────────────────────

/**
 * Recursively list all .json files in a Drive folder and its subfolders.
 * This handles structures like Day 1/, Day 2/, etc.
 */
async function listTranscriptFiles(drive, folderId, _folderName) {
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 200,
      pageToken: pageToken || undefined,
    });

    for (const file of res.data.files) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        // Recurse into subfolder
        console.log(`  📁 Scanning subfolder: ${file.name}`);
        const sub = await listTranscriptFiles(drive, file.id, file.name);
        files.push(...sub);
      } else if (file.name.endsWith('.json')) {
        files.push(file);
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function downloadJson(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'text' }
  );
  return JSON.parse(res.data);
}

// ─── Title generation ─────────────────────────────────────────────────────────

async function generateTitle(openai, segments) {
  try {
    const sample = segments.slice(0, 20)
      .map(s => `${s.speaker || 'Speaker'}: ${s.text}`)
      .join('\n');

    const OpenAI = require('openai');
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Generate a short descriptive title for this conversation that captures who is speaking and the main topic (e.g. "Sondre on why he founded SafetyWing" or "Team discussing remote work benefits"). Respond with ONLY the title, no quotes, no punctuation at end.\n\n${sample}`
      }],
      max_tokens: 30,
    });
    return res.choices[0].message.content.trim();
  } catch (e) {
    console.log(`  ⚠️  Title generation failed: ${e.message}`);
    return null;
  }
}

// Rename a file in Drive (requires Editor access on the folder)
async function renameDriveFile(drive, fileId, newName) {
  try {
    await drive.files.update({
      fileId,
      resource: { name: newName },
      supportsAllDrives: true,
    });
    return true;
  } catch (e) {
    console.log(`  ⚠️  Could not rename Drive file: ${e.message}`);
    return false;
  }
}

// ─── Chunking ─────────────────────────────────────────────────────────────────
//
// Strategy:
//   1. 'segment' — each original speaker turn, as-is.
//   2. '30s' / '60s' / '90s' — sliding windows across all segments.
//      Each window starts at a segment boundary and accumulates segments
//      until the window duration is met. Windows slide forward by half
//      the target length (50% overlap) to ensure no good clip is missed.

function buildChunks(segments, targetMs) {
  const chunks = [];

  // 1. Natural segments
  for (const seg of segments) {
    if (!seg.text || !seg.text.trim()) continue;
    chunks.push({
      speaker_label: seg.speaker || null,
      text: seg.text.trim(),
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      chunk_type: 'segment',
    });
  }

  // 2. Sliding windows
  for (const windowMs of CHUNK_TARGETS_MS) {
    const stepMs = windowMs / 2; // 50% overlap
    let windowStart = segments[0]?.start_ms ?? 0;
    const totalDuration = segments[segments.length - 1]?.end_ms ?? 0;

    while (windowStart < totalDuration) {
      const windowEnd = windowStart + windowMs;

      // Collect all segments that overlap this window
      const included = segments.filter(
        s => s.start_ms >= windowStart && s.start_ms < windowEnd && s.text?.trim()
      );

      if (included.length > 0) {
        const chunkStart = included[0].start_ms;
        const chunkEnd   = included[included.length - 1].end_ms;
        const text       = included.map(s => s.text.trim()).join(' ');

        // Only keep chunks within ±50% of target length
        const duration = chunkEnd - chunkStart;
        if (duration >= windowMs * 0.4 && duration <= windowMs * 1.6) {
          chunks.push({
            // Use majority speaker (most ms of speech)
            speaker_label: majoritySpeaker(included),
            text,
            start_ms: chunkStart,
            end_ms: chunkEnd,
            chunk_type: CHUNK_LABEL[windowMs],
          });
        }
      }

      windowStart += stepMs;
    }
  }

  return chunks;
}

function majoritySpeaker(segments) {
  const durations = {};
  for (const s of segments) {
    const spk = s.speaker || 'Unknown';
    durations[spk] = (durations[spk] || 0) + (s.end_ms - s.start_ms);
  }
  return Object.entries(durations).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// ─── Embeddings ───────────────────────────────────────────────────────────────

async function embedBatch(openai, texts) {
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: texts,
  });
  // Return in same order as input
  return res.data.sort((a, b) => a.index - b.index).map(e => e.embedding);
}

async function addEmbeddings(openai, chunks) {
  const results = [...chunks];
  for (let i = 0; i < results.length; i += EMBED_BATCH_SIZE) {
    const batch = results.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(c => c.text);
    const embeddings = await embedBatch(openai, texts);
    for (let j = 0; j < batch.length; j++) {
      results[i + j].embedding = embeddings[j];
    }
    // Polite pause to avoid rate limits
    if (i + EMBED_BATCH_SIZE < results.length) {
      await sleep(300);
    }
  }
  return results;
}

// ─── Supabase upsert ──────────────────────────────────────────────────────────

async function upsertVideo(supabase, videoId, fileName, driveFileId, segments, title = null) {
  const totalDuration = segments[segments.length - 1]?.end_ms ?? 0;
  const speakerCount  = new Set(segments.map(s => s.speaker).filter(Boolean)).size;

  const { error } = await supabase.from('videos').upsert({
    id: videoId,
    file_name: fileName,
    drive_file_id: driveFileId,
    total_duration_ms: totalDuration,
    speaker_count: speakerCount,
    title: title,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`videos upsert failed: ${error.message}`);
}

async function upsertChunks(supabase, videoId, chunks) {
  // Delete existing chunks for this video so we don't accumulate duplicates on re-run
  await supabase.from('transcript_chunks').delete().eq('video_id', videoId);

  // Insert in batches of 50
  for (let i = 0; i < chunks.length; i += 50) {
    const batch = chunks.slice(i, i + 50).map(c => ({
      video_id:      videoId,
      speaker_label: c.speaker_label,
      speaker_name:  c.speaker_name,
      text:          c.text,
      start_ms:      c.start_ms,
      end_ms:        c.end_ms,
      chunk_type:    c.chunk_type,
      embedding:     c.embedding,
    }));

    const { error } = await supabase.from('transcript_chunks').insert(batch);
    if (error) throw new Error(`chunks insert failed: ${error.message}`);
  }
}

async function isAlreadyIngested(supabase, videoId) {
  const { data } = await supabase
    .from('transcript_chunks')
    .select('id')
    .eq('video_id', videoId)
    .limit(1);
  return data && data.length > 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const folderId = process.env.TRANSCRIPT_FOLDER_ID;
  if (!folderId) throw new Error('Missing TRANSCRIPT_FOLDER_ID env var');

  const { drive, openai, supabase } = buildClients();
  const mappings = loadSpeakerMappings();

  console.log('Fetching transcript file list from Drive...');
  const files = await listTranscriptFiles(drive, folderId);
  console.log(`Found ${files.length} transcript files.\n`);

  let ingested = 0, skipped = 0, failed = 0;

  for (const file of files) {
    const videoId = path.basename(file.name, '.json');

    process.stdout.write(`[${videoId}] Checking... `);

    // Skip if already ingested
    if (await isAlreadyIngested(supabase, videoId)) {
      console.log('already ingested, skipping.');
      skipped++;
      continue;
    }

    try {
      // 1. Download transcript
      process.stdout.write('downloading... ');
      const raw = await downloadJson(drive, file.id);
      // Handle both formats:
      //   Old: [{speaker, text, start_ms, end_ms}, ...]   (plain array)
      //   New: {title, speakers, transcript: [...]}        (object with metadata)
      const segments = Array.isArray(raw) ? raw : (raw.transcript || []);
      if (!Array.isArray(segments) || segments.length === 0) {
        console.log('empty, skipping.');
        skipped++;
        continue;
      }

      // 2. Generate title (use existing if present, otherwise ask GPT)
      process.stdout.write('titling... ');
      let title = Array.isArray(raw) ? null : (raw.title || null);
      if (!title) {
        title = await generateTitle(openai, segments);
      }
      if (title) {
        // Rename the Drive file to the descriptive title
        const newFileName = title.replace(/[^a-z0-9\s\-]/gi, '').trim().substring(0, 80) + '.json';
        const renamed = await renameDriveFile(drive, file.id, newFileName);
        if (renamed) process.stdout.write(`renamed → "${newFileName}"... `);
      }

      // 3. Build chunks
      process.stdout.write('chunking... ');
      const rawChunks = buildChunks(segments, CHUNK_TARGETS_MS);

      // 4. Attach speaker names from mappings
      const chunks = rawChunks.map(c => ({
        ...c,
        speaker_name: resolveSpeakerName(mappings, videoId, c.speaker_label),
      }));

      // 5. Generate embeddings
      process.stdout.write(`embedding ${chunks.length} chunks... `);
      const chunksWithEmbeddings = await addEmbeddings(openai, chunks);

      // 6. Upsert to Supabase
      process.stdout.write('saving... ');
      await upsertVideo(supabase, videoId, file.name, file.id, segments, title);
      await upsertChunks(supabase, videoId, chunksWithEmbeddings);

      console.log(`✅  done (${chunks.length} chunks)`);
      ingested++;

    } catch (err) {
      console.log(`❌  FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log(`Ingestion complete.`);
  console.log(`  ✅ Ingested : ${ingested}`);
  console.log(`  ⏭  Skipped  : ${skipped}`);
  console.log(`  ❌ Failed   : ${failed}`);
  console.log('═'.repeat(50));

  if (failed > 0) {
    console.log('\nFailed videos can be retried — they were not marked as ingested.');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
