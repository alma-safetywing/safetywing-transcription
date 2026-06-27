/**
 * transcribe_videos.js
 *
 * Scans the cam 1 proxies folder (all Day subfolders), transcribes any
 * video that doesn't already have a transcript JSON using AssemblyAI
 * (with speaker diarization), and saves the result to your Drive
 * transcripts folder so ingest_transcripts.js can pick it up.
 *
 * Requirements:
 *   - ffmpeg installed (brew install ffmpeg)
 *   - .env with GOOGLE_SERVICE_ACCOUNT_JSON, OPENAI_API_KEY,
 *     ASSEMBLYAI_API_KEY, TRANSCRIPT_FOLDER_ID, PROXIES_FOLDER_ID
 *
 * Run:
 *   node scripts/transcribe_videos.js
 *
 * After it finishes:
 *   node scripts/ingest_transcripts.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { execSync, spawn } = require('child_process');
const { Readable } = require('stream');

// ─── Config ───────────────────────────────────────────────────────────────────

const ASSEMBLYAI_API_KEY  = process.env.ASSEMBLYAI_API_KEY  || '76ee7730d1d54c17a49c924f1137122e';
const PROXIES_FOLDER_ID   = process.env.PROXIES_FOLDER_ID   || '1bYXP6wsUrfmefU8KHgRG6musui4W019D';
const TRANSCRIPT_FOLDER_ID = process.env.TRANSCRIPT_FOLDER_ID;
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.mts', '.m4v', '.mxf']);
const AAI_HEADERS = { authorization: ASSEMBLYAI_API_KEY };

// ─── Drive client ─────────────────────────────────────────────────────────────

function buildDrive() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// ─── ffmpeg ───────────────────────────────────────────────────────────────────

function findFfmpeg() {
  // 1. Try system ffmpeg
  for (const bin of ['ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) {
    try { execSync(`"${bin}" -version`, { stdio: 'ignore' }); return bin; } catch {}
  }
  // 2. Fall back to ffmpeg-static (bundled binary, no install needed)
  try {
    const staticFfmpeg = require('ffmpeg-static');
    if (staticFfmpeg && fs.existsSync(staticFfmpeg)) return staticFfmpeg;
  } catch {}
  return null;
}

/**
 * Stream a Drive file directly through ffmpeg — no video saved to disk.
 * Only the tiny extracted audio file is written locally.
 */
async function streamExtractAudio(drive, fileId, audioPath, ffmpegBin) {
  // Get Drive download stream
  const driveRes = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin, [
      '-i', 'pipe:0',
      '-vn', '-acodec', 'libmp3lame', '-ac', '1', '-ar', '16000', '-b:a', '32k',
      '-f', 'mp3', audioPath, '-y',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    driveRes.data.pipe(ff.stdin);
    driveRes.data.on('error', reject);
    ff.stdin.on('error', () => {}); // ignore broken pipe

    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });

    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
    });
    ff.on('error', reject);
  });
}

// ─── AssemblyAI ───────────────────────────────────────────────────────────────

async function uploadToAssemblyAI(audioPath) {
  const audioData = fs.readFileSync(audioPath);
  const res = await axios.post('https://api.assemblyai.com/v2/upload', audioData, {
    headers: { ...AAI_HEADERS, 'content-type': 'application/octet-stream' },
    timeout: 600000,
    maxBodyLength: Infinity,
  });
  return res.data.upload_url;
}

async function submitTranscriptionJob(uploadUrl) {
  const res = await axios.post('https://api.assemblyai.com/v2/transcript', {
    audio_url: uploadUrl,
    speaker_labels: true,
  }, { headers: AAI_HEADERS });
  return res.data.id;
}

async function pollUntilDone(transcriptId) {
  for (let i = 0; i < 240; i++) {
    await sleep(5000);
    const res = await axios.get(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      { headers: AAI_HEADERS }
    );
    const { status } = res.data;
    process.stdout.write(`\r  ⏳ Status: ${status} (${i * 5}s)    `);
    if (status === 'completed') { process.stdout.write('\n'); return res.data; }
    if (status === 'error')     throw new Error(`AssemblyAI error: ${res.data.error}`);
  }
  throw new Error('Transcription timed out after 20 minutes');
}

// ─── Title generation (OpenAI) ────────────────────────────────────────────────

async function generateTitle(utterances) {
  if (!OPENAI_API_KEY || !utterances?.length) return null;
  try {
    const sample = utterances.slice(0, 20)
      .map(u => `Speaker ${u.speaker}: ${u.text}`)
      .join('\n');
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: `Generate a short descriptive title for this conversation capturing who is speaking and the main topic (e.g. "Sara on SafetyWing's mission" or "Team discussing remote work"). Respond with ONLY the title, no quotes, no punctuation at end.\n\n${sample}` }],
      max_tokens: 30,
    }, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      timeout: 30000,
    });
    return res.data.choices[0].message.content.trim();
  } catch (e) {
    console.log(`\n  ⚠️  Title generation skipped: ${e.message}`);
    return null;
  }
}

// ─── Speaker name detection ───────────────────────────────────────────────────

// Name detection lives in scripts/lib/speaker_names.js — shared with every
// other transcription entry point. The old version here had a dangerous
// third-person "this is X" pattern (mislabels whoever is being introduced
// as the current speaker) and first-match-wins (one false positive
// permanently locked out a real self-intro found later in the same
// conversation).
const { detectNamesFromUtterances } = require('./lib/speaker_names');
function detectNamesFromText(utterances) {
  return detectNamesFromUtterances(utterances);
}

function buildOutput(data, title) {
  if (!data.utterances?.length) {
    return { title, speakers: {}, transcript: [{ speaker: 'Speaker 1', text: data.text, start_ms: 0, end_ms: 0 }] };
  }
  const regexNames = detectNamesFromText(data.utterances);
  const labelMap = {};
  let count = 1;
  const transcript = data.utterances.map(u => {
    if (!labelMap[u.speaker]) {
      labelMap[u.speaker] = regexNames[u.speaker] || `Speaker ${count++}`;
    }
    return { speaker: labelMap[u.speaker], text: u.text, start_ms: u.start, end_ms: u.end };
  });
  return { title, speakers: labelMap, transcript };
}

// ─── Drive helpers ────────────────────────────────────────────────────────────

async function listVideoFiles(drive, folderId, folderPath) {
  const results = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageSize: 200,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const file of res.data.files) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        const sub = folderPath ? `${folderPath}/${file.name}` : file.name;
        console.log(`  📁 ${sub}/`);
        results.push(...await listVideoFiles(drive, file.id, sub));
      } else if (VIDEO_EXTS.has(path.extname(file.name).toLowerCase())) {
        results.push({ ...file, folderPath: folderPath || '(root)' });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return results;
}

async function listExistingTranscriptNames(drive, folderId) {
  const names = new Set();
  const stack = [folderId];
  while (stack.length) {
    const id = stack.pop();
    let pageToken = null;
    do {
      const res = await drive.files.list({
        q: `'${id}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 200,
        pageToken: pageToken || undefined,
      });
      for (const f of res.data.files) {
        if (f.mimeType === 'application/vnd.google-apps.folder') stack.push(f.id);
        else if (f.name.endsWith('.json')) {
          names.add(f.name);
          names.add(f.name.replace(/\.json$/, ''));
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }
  return names;
}

async function downloadFile(drive, fileId, destPath) {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(destPath);
    res.data.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
    res.data.on('error', reject);
  });
}

async function saveTranscriptToDrive(drive, folderId, fileName, data) {
  const stream = Readable.from([JSON.stringify(data, null, 2)]);
  await drive.files.create({
    requestBody: { name: fileName, mimeType: 'application/json', parents: [folderId] },
    media: { mimeType: 'application/json', body: stream },
    supportsAllDrives: true,
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!TRANSCRIPT_FOLDER_ID) throw new Error('Missing TRANSCRIPT_FOLDER_ID env var');

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.error('\n❌  ffmpeg not found. Run: npm install ffmpeg-static\n');
    process.exit(1);
  }
  console.log(`✅  ffmpeg: ${ffmpeg}`);
  console.log(`✅  AssemblyAI key: ${ASSEMBLYAI_API_KEY.slice(0, 8)}...`);

  const drive = buildDrive();

  // 1. Existing transcripts
  console.log('\n📋  Checking existing transcripts...');
  const existing = await listExistingTranscriptNames(drive, TRANSCRIPT_FOLDER_ID);
  console.log(`    ${existing.size / 2} already transcribed.\n`);

  // 2. All videos
  console.log('📂  Scanning proxies folder...');
  const videos = await listVideoFiles(drive, PROXIES_FOLDER_ID, '');
  console.log(`\n    Found ${videos.length} video files.`);

  // 3. Filter to untranscribed
  const todo = videos.filter(v => {
    const base = path.basename(v.name, path.extname(v.name));
    return !existing.has(base) && !existing.has(base + '.json');
  });
  console.log(`    Already done: ${videos.length - todo.length}`);
  console.log(`    To transcribe: ${todo.length}\n`);

  if (todo.length === 0) {
    console.log('✅  All videos transcribed! Run: node scripts/ingest_transcripts.js');
    return;
  }

  let transcribed = 0, failed = 0;

  for (let i = 0; i < todo.length; i++) {
    const video = todo[i];
    const baseName = path.basename(video.name, path.extname(video.name));
    const sizeMB = video.size ? `${(parseInt(video.size) / 1024 / 1024).toFixed(1)}MB` : '?MB';
    console.log(`\n[${i + 1}/${todo.length}] ${video.folderPath}/${video.name} (${sizeMB})`);

    const tmpAudio = path.join(os.tmpdir(), baseName + '.mp3');

    try {
      // Stream video → ffmpeg → audio (no video saved to disk)
      process.stdout.write('  🎵 Streaming & extracting audio...');
      await streamExtractAudio(drive, video.id, tmpAudio, ffmpeg);
      const audioSize = (fs.statSync(tmpAudio).size / 1024 / 1024).toFixed(1);
      console.log(` ${audioSize}MB`);

      // Upload to AssemblyAI
      process.stdout.write('  📤 Uploading to AssemblyAI...');
      const uploadUrl = await uploadToAssemblyAI(tmpAudio);
      console.log(' done');
      fs.unlinkSync(tmpAudio);

      // Submit + poll
      const jobId = await submitTranscriptionJob(uploadUrl);
      console.log(`  🎙️  Job ${jobId}`);
      const result = await pollUntilDone(jobId);

      // Generate title
      process.stdout.write('  💡 Generating title...');
      const title = await generateTitle(result.utterances);
      console.log(title ? ` "${title}"` : ' skipped');

      // Build output
      const transcriptData = buildOutput(result, title);

      // Save to Drive (use title as filename if available)
      const safeTitle = title
        ? title.replace(/[^a-z0-9\s\-]/gi, '').trim().substring(0, 80)
        : null;
      const fileName = safeTitle ? `${safeTitle}.json` : `${baseName}.json`;

      process.stdout.write(`  💾 Saving "${fileName}"...`);
      await saveTranscriptToDrive(drive, TRANSCRIPT_FOLDER_ID, fileName, transcriptData);
      console.log(' done');

      console.log(`  ✅ ${transcriptData.transcript.length} utterances | speakers: ${Object.keys(transcriptData.speakers).length}`);
      transcribed++;

    } catch (err) {
      console.log(`\n  ❌ FAILED: ${err.message}`);
      if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio);
      failed++;
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`Done. Transcribed: ${transcribed} | Failed: ${failed}`);
  console.log('═'.repeat(60));
  if (transcribed > 0) console.log('\n👉  Next: node scripts/ingest_transcripts.js');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
