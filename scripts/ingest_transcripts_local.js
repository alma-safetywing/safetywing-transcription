/**
 * ingest_transcripts_local.js
 *
 * Reads transcript JSONs from scripts/transcripts/ (local disk),
 * chunks them, generates embeddings, and upserts into Supabase.
 * Safe to re-run — skips already-ingested videos.
 *
 * Run after organize_and_transcribe.js:
 *   node scripts/ingest_transcripts_local.js
 */

require('dotenv').config();
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const CHUNK_TARGETS_MS = [30_000, 60_000, 90_000];
const CHUNK_LABEL      = { 30000: '30s', 60000: '60s', 90000: '90s' };
const EMBED_BATCH_SIZE = 20;
const EMBED_MODEL      = 'text-embedding-3-small';
const TRANSCRIPTS_DIR  = path.join(__dirname, 'transcripts');

// ─── Clients ──────────────────────────────────────────────────────────────────

function buildClients() {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');

  const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return { openai, supabase };
}

// ─── Find all local transcript JSONs ─────────────────────────────────────────

function findAllTranscripts(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAllTranscripts(full));
    } else if (entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

function buildChunks(segments) {
  const chunks = [];

  // Natural segments
  for (const seg of segments) {
    if (!seg.text?.trim()) continue;
    chunks.push({
      speaker_label: seg.speaker || null,
      text: seg.text.trim(),
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      chunk_type: 'segment',
    });
  }

  // Sliding windows
  for (const windowMs of CHUNK_TARGETS_MS) {
    const stepMs = windowMs / 2;
    let windowStart = segments[0]?.start_ms ?? 0;
    const totalDuration = segments[segments.length - 1]?.end_ms ?? 0;

    while (windowStart < totalDuration) {
      const windowEnd = windowStart + windowMs;
      const included = segments.filter(
        s => s.start_ms >= windowStart && s.start_ms < windowEnd && s.text?.trim()
      );
      if (included.length > 0) {
        const chunkStart = included[0].start_ms;
        const chunkEnd   = included[included.length - 1].end_ms;
        const text       = included.map(s => s.text.trim()).join(' ');
        const duration   = chunkEnd - chunkStart;
        if (duration >= windowMs * 0.4 && duration <= windowMs * 1.6) {
          chunks.push({
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
  const dur = {};
  for (const s of segments) {
    const spk = s.speaker || 'Unknown';
    dur[spk] = (dur[spk] || 0) + (s.end_ms - s.start_ms);
  }
  return Object.entries(dur).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// ─── Embeddings ───────────────────────────────────────────────────────────────

async function addEmbeddings(openai, chunks) {
  const results = [...chunks];
  for (let i = 0; i < results.length; i += EMBED_BATCH_SIZE) {
    const batch = results.slice(i, i + EMBED_BATCH_SIZE);
    const res = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: batch.map(c => c.text),
    });
    const embeddings = res.data.sort((a, b) => a.index - b.index).map(e => e.embedding);
    for (let j = 0; j < batch.length; j++) results[i + j].embedding = embeddings[j];
    if (i + EMBED_BATCH_SIZE < results.length) await sleep(300);
  }
  return results;
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function isAlreadyIngested(supabase, videoId) {
  const { data } = await supabase
    .from('transcript_chunks')
    .select('id')
    .eq('video_id', videoId)
    .limit(1);
  return data && data.length > 0;
}

async function upsertVideo(supabase, videoId, fileName, segments, title, videoDriveId) {
  const totalDuration = segments[segments.length - 1]?.end_ms ?? 0;
  const speakerCount  = new Set(segments.map(s => s.speaker).filter(Boolean)).size;
  const { error } = await supabase.from('videos').upsert({
    id: videoId,
    file_name: fileName,
    drive_file_id: null,       // no Drive JSON file — stored locally
    video_drive_id: videoDriveId,
    total_duration_ms: totalDuration,
    speaker_count: speakerCount,
    title,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`videos upsert: ${error.message}`);
}

async function upsertChunks(supabase, videoId, chunks) {
  await supabase.from('transcript_chunks').delete().eq('video_id', videoId);
  for (let i = 0; i < chunks.length; i += 50) {
    const batch = chunks.slice(i, i + 50).map(c => ({
      video_id:      videoId,
      speaker_label: c.speaker_label,
      speaker_name:  null,
      text:          c.text,
      start_ms:      c.start_ms,
      end_ms:        c.end_ms,
      chunk_type:    c.chunk_type,
      embedding:     c.embedding,
    }));
    const { error } = await supabase.from('transcript_chunks').insert(batch);
    if (error) throw new Error(`chunks insert: ${error.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { openai, supabase } = buildClients();

  console.log(`\nScanning ${TRANSCRIPTS_DIR} for transcripts...`);
  const files = findAllTranscripts(TRANSCRIPTS_DIR);
  console.log(`Found ${files.length} transcript files.\n`);

  if (files.length === 0) {
    console.log('No transcripts found. Run organize_and_transcribe.js first.');
    return;
  }

  let ingested = 0, skipped = 0, failed = 0;

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const slugId    = path.basename(fileName, '.json');

    // Prefer the source video's Drive file ID as the dedup key (matches process_new_videos.js
    // and the Supabase video_drive_id column) — stable and unique, unlike a title-derived slug.
    let videoId = slugId;
    try {
      const peek = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (peek.video_drive_id) videoId = peek.video_drive_id;
    } catch {}

    process.stdout.write(`[${videoId.substring(0, 50)}] `);

    if (await isAlreadyIngested(supabase, videoId)) {
      console.log('already ingested, skipping.');
      skipped++;
      continue;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const segments    = Array.isArray(raw) ? raw : (raw.transcript || []);
      const title       = Array.isArray(raw) ? null : (raw.title || null);
      const videoDriveId = Array.isArray(raw) ? null : (raw.video_drive_id || null);

      if (!segments.length) { console.log('empty, skipping.'); skipped++; continue; }

      process.stdout.write('chunking... ');
      const rawChunks = buildChunks(segments);

      process.stdout.write(`embedding ${rawChunks.length} chunks... `);
      const chunks = await addEmbeddings(openai, rawChunks);

      process.stdout.write('saving... ');
      await upsertVideo(supabase, videoId, fileName, segments, title, videoDriveId);
      await upsertChunks(supabase, videoId, chunks);

      console.log(`✅  (${chunks.length} chunks)`);
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
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
