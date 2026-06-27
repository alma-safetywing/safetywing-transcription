const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── Optional shared-password gate ───────────────────────────────────────────
// /api/search and the UI itself have no per-user login (verifyGoogleToken only
// guards the Drive-listing/transcribe routes), so once this is reachable from
// outside your own laptop, anyone with the URL could read every transcript.
// Set SITE_PASSWORD on the deployment (e.g. in Render's env vars) to require
// HTTP Basic Auth (any username, this password) for every request. Leave it
// unset locally and nothing changes from before.
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
if (SITE_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [, encoded] = header.split(' ');
    const decoded = encoded ? Buffer.from(encoded, 'base64').toString() : '';
    const [, suppliedPassword] = decoded.split(':');
    if (suppliedPassword === SITE_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="SafetyWing Transcripts"');
    res.status(401).send('Authentication required.');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || '76ee7730d1d54c17a49c924f1137122e',
  OPENAI_API_KEY: process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY || '',
  DRIVE_FOLDER_ID: '1PYaVpIoaaszLaM-T-sE73SI4GI7w_Q45',
  PORT: process.env.PORT || 3000,
  TEMP_DIR: path.join(__dirname, 'temp')
};

if (!fs.existsSync(CONFIG.TEMP_DIR)) {
  fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true });
}

// ─── Google Drive client ──────────────────────────────────────────────────────
const drive = google.drive('v3');

// ─── Supabase client ──────────────────────────────────────────────────────────
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  console.log('✓ Supabase client initialized');
}

// ─── Service account auth (preferred — no token expiry) ───────────────────────
// Set GOOGLE_SERVICE_ACCOUNT_JSON in Render env vars to enable this.
// When set, the frontend no longer needs to paste a Google token.
// Falls back to per-request OAuth tokens if the env var is not set.
let serviceAccountAuth = null;
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    serviceAccountAuth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    console.log('✓ Service account auth initialized');
  } catch (e) {
    console.error('✗ Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
  }
}

// Returns the right auth client for the current request:
//   - service account (if configured), or
//   - OAuth2 client built from the token the frontend passed
async function getAuthClient(req) {
  if (serviceAccountAuth) {
    return await serviceAccountAuth.getClient();
  }
  const client = new google.auth.OAuth2();
  client.setCredentials({ access_token: req.googleAuth.accessToken });
  return client;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
// When service account is configured, no token is required from the frontend.
async function verifyGoogleToken(req, res, next) {
  if (serviceAccountAuth) {
    req.useServiceAccount = true;
    return next();
  }
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No authorization token' });
  }
  req.googleAuth = { accessToken: token };
  next();
}

// ─── List videos endpoint ─────────────────────────────────────────────────────
app.get('/api/videos', verifyGoogleToken, async (req, res) => {
  try {
    const authClient = await getAuthClient(req);

    let proxiesFolderId = await getFolderIdByName(authClient, CONFIG.DRIVE_FOLDER_ID, 'Proxies');
    if (!proxiesFolderId) {
      return res.status(404).json({ error: 'Proxies folder not found inside folder ID: ' + CONFIG.DRIVE_FOLDER_ID });
    }

    const dayFolders = await listSubfolders(authClient, proxiesFolderId);
    console.log(`Found ${dayFolders.length} day folders:`, dayFolders.map(f => f.name));

    const allVideos = [];
    for (const dayFolder of dayFolders) {
      const cam1Id = await getCam1FolderId(authClient, dayFolder.id);
      if (!cam1Id) {
        console.log(`No Cam 1 folder in ${dayFolder.name}, skipping`);
        continue;
      }
      const videos = await listMp4Files(authClient, cam1Id);
      videos.forEach(v => v.day = dayFolder.name);
      allVideos.push(...videos);
    }

    res.json({ videos: allVideos });
  } catch (error) {
    console.error('Error listing videos:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Drive helpers ────────────────────────────────────────────────────────────
async function getFolderIdByName(authClient, parentFolderId, folderName) {
  try {
    const response = await drive.files.list({
      auth: authClient,
      q: `'${parentFolderId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      spaces: 'drive',
      pageSize: 1,
      fields: 'files(id,name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    return response.data.files?.[0]?.id;
  } catch (error) {
    console.error('Error getting folder ID:', error);
    throw error;
  }
}

// Uses 'contains' so "Cam 1🏳️" and similar emoji variants all match
async function getCam1FolderId(authClient, parentFolderId) {
  const response = await drive.files.list({
    auth: authClient,
    q: `'${parentFolderId}' in parents and name contains 'Cam 1' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: 'drive', pageSize: 1, fields: 'files(id,name)',
    supportsAllDrives: true, includeItemsFromAllDrives: true
  });
  const found = response.data.files?.[0];
  if (found) console.log(`Found camera folder: "${found.name}"`);
  return found?.id;
}

async function listSubfolders(authClient, parentFolderId) {
  try {
    const response = await drive.files.list({
      auth: authClient,
      q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      spaces: 'drive',
      pageSize: 100,
      fields: 'files(id,name)',
      orderBy: 'name',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    return response.data.files || [];
  } catch (error) {
    console.error('Error listing subfolders:', error);
    throw error;
  }
}

async function listMp4Files(authClient, folderId) {
  try {
    const response = await drive.files.list({
      auth: authClient,
      q: `'${folderId}' in parents and mimeType='video/mp4' and trashed=false`,
      spaces: 'drive',
      pageSize: 1000,
      fields: 'files(id,name,size,mimeType)',
      orderBy: 'name',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    return response.data.files || [];
  } catch (error) {
    console.error('Error listing files:', error);
    throw error;
  }
}

// ─── Transcription endpoint ───────────────────────────────────────────────────
app.post('/api/transcribe', verifyGoogleToken, async (req, res) => {
  const { videoId, videoName } = req.body;
  if (!videoId || !videoName) {
    return res.status(400).json({ error: 'videoId and videoName required' });
  }

  try {
    const authClient = await getAuthClient(req);

    console.log(`[${videoName}] Starting download...`);
    const videoPath = path.join(CONFIG.TEMP_DIR, `${Date.now()}_${videoName}`);
    await downloadFile(authClient, videoId, videoPath);
    console.log(`[${videoName}] Download complete`);

    console.log(`[${videoName}] Extracting audio...`);
    const audioPath = videoPath.replace(/\.[^.]+$/, '.mp3');
    await extractAudio(videoPath, audioPath);
    console.log(`[${videoName}] Audio extracted`);

    console.log(`[${videoName}] Sending to AssemblyAI...`);
    const transcript = await transcribeWithAssemblyAI(audioPath);
    console.log(`[${videoName}] Transcription complete`);

    console.log(`[${videoName}] Saving to Drive...`);
    const safeTitle = transcript.title
      ? transcript.title.replace(/[^a-z0-9\s\-]/gi, '').trim().substring(0, 80)
      : null;
    const transcriptName = safeTitle ? `${safeTitle}.json` : videoName.replace('.mp4', '.json');
    await saveTranscriptToDrive(authClient, transcript, transcriptName);
    console.log(`[${videoName}] Saved as "${transcriptName}"!`);

    try {
      fs.unlinkSync(videoPath);
      fs.unlinkSync(audioPath);
    } catch (e) {
      console.log(`Warning: Could not delete temp files: ${e.message}`);
    }

    res.json({ success: true, transcriptName });
  } catch (error) {
    console.error(`Error transcribing ${videoName}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Download file from Drive ─────────────────────────────────────────────────
async function downloadFile(authClient, fileId, filePath) {
  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(filePath);
    drive.files.get(
      { auth: authClient, fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
      (err, response) => {
        if (err) { dest.destroy(); return reject(err); }
        response.data
          .on('error', reject)
          .pipe(dest)
          .on('finish', resolve)
          .on('error', reject);
      }
    );
  });
}

// ─── Extract audio with FFmpeg ────────────────────────────────────────────────
async function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    try {
      const command = `ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -ac 1 -ar 16000 -b:a 32k "${audioPath}" -y`;
      execSync(command, { stdio: 'pipe', timeout: 600000 });
      resolve();
    } catch (error) {
      reject(new Error(`FFmpeg error: ${error.message}`));
    }
  });
}

// ─── AssemblyAI transcription ─────────────────────────────────────────────────
async function transcribeWithAssemblyAI(audioPath) {
  const headers = { 'authorization': CONFIG.ASSEMBLYAI_API_KEY };

  console.log('Uploading audio to AssemblyAI...');
  const audioData = fs.readFileSync(audioPath);
  const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioData, {
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    timeout: 600000, maxBodyLength: Infinity
  });

  console.log('Submitting transcription job with speaker diarization...');
  const submitRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
    audio_url: uploadRes.data.upload_url,
    speaker_labels: true
  }, { headers });

  const transcriptId = submitRes.data.id;
  console.log(`Polling transcript ${transcriptId}...`);

  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, { headers });
    const { status } = poll.data;
    console.log(`Status: ${status}`);
    if (status === 'completed') {
      const title = await generateTitle(poll.data.utterances || []);
      return buildOutput(poll.data, { title, speakerNames: {} });
    }
    if (status === 'error') throw new Error(`AssemblyAI error: ${poll.data.error}`);
  }
  throw new Error('Transcription timed out after 20 minutes');
}

async function generateTitle(utterances) {
  if (!CONFIG.OPENAI_API_KEY) return '';
  try {
    const sample = utterances.slice(0, 20).map(u => `Speaker ${u.speaker}: ${u.text}`).join('\n');
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: `Generate a short descriptive title for this conversation capturing who is speaking and the main topic (e.g. "Sarah on why she founded SafetyWing"). Respond with ONLY the title, no quotes.\n\n${sample}` }],
      max_tokens: 30
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }, timeout: 30000 });
    const title = res.data.choices[0].message.content.trim();
    console.log(`Generated title: "${title}"`);
    return title;
  } catch (e) {
    console.log('Title generation skipped:', e.response?.data?.error?.message || e.message);
    return '';
  }
}

function detectNamesFromText(utterances) {
  const found = {};
  const patterns = [
    /\bI'?m\s+([A-Z][a-záéíóúñ]+)\b/,
    /\bmy name is\s+([A-Z][a-záéíóúñ]+)\b/i,
    /\bI am\s+([A-Z][a-záéíóúñ]+)\b/,
    /\bthis is\s+([A-Z][a-záéíóúñ]+)\b/i,
    /\bcall me\s+([A-Z][a-záéíóúñ]+)\b/i,
  ];
  for (const u of utterances.slice(0, 30)) {
    if (found[u.speaker]) continue;
    for (const p of patterns) {
      const m = u.text.match(p);
      if (m?.[1]) { found[u.speaker] = m[1]; break; }
    }
  }
  return found;
}

function buildOutput(data, { title, speakerNames }) {
  if (!data.utterances || data.utterances.length === 0) {
    return { title, speakers: {}, transcript: [{ speaker: 'Speaker 1', text: data.text }] };
  }
  const regexNames = detectNamesFromText(data.utterances);
  const mergedNames = { ...regexNames, ...speakerNames };
  console.log('Merged speaker names:', mergedNames);

  const labelMap = {};
  let count = 1;
  const transcript = data.utterances.map(u => {
    if (!labelMap[u.speaker]) {
      labelMap[u.speaker] = mergedNames[u.speaker] || `Speaker ${count++}`;
    }
    return { speaker: labelMap[u.speaker], text: u.text, start_ms: u.start, end_ms: u.end };
  });

  return { title, speakers: labelMap, transcript };
}

// ─── Save transcript to Drive ─────────────────────────────────────────────────
// Service account mode: saves to TRANSCRIPT_OUTPUT_FOLDER_ID env var.
// OAuth mode: saves to "SafetyWing Transcripts" folder in the user's My Drive.
async function saveTranscriptToDrive(authClient, transcriptData, fileName) {
  const outputFolderId = process.env.TRANSCRIPT_OUTPUT_FOLDER_ID;

  if (serviceAccountAuth && outputFolderId) {
    // Service account — save directly to the configured output folder
    const uploadResponse = await drive.files.create({
      auth: authClient,
      resource: { name: fileName, mimeType: 'application/json', parents: [outputFolderId] },
      media: { mimeType: 'application/json', body: JSON.stringify(transcriptData, null, 2) },
      fields: 'id'
    });
    return uploadResponse.data.id;
  }

  // OAuth fallback — save to "SafetyWing Transcripts" in user's My Drive
  try {
    let transcriptsFolderId = await getMyDriveFolderByName(authClient, 'SafetyWing Transcripts');
    if (!transcriptsFolderId) {
      console.log('Creating SafetyWing Transcripts folder in My Drive...');
      const createResponse = await drive.files.create({
        auth: authClient,
        resource: { name: 'SafetyWing Transcripts', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
        fields: 'id'
      });
      transcriptsFolderId = createResponse.data.id;
    }
    const uploadResponse = await drive.files.create({
      auth: authClient,
      resource: { name: fileName, mimeType: 'application/json', parents: [transcriptsFolderId] },
      media: { mimeType: 'application/json', body: JSON.stringify(transcriptData, null, 2) },
      fields: 'id'
    });
    return uploadResponse.data.id;
  } catch (error) {
    throw new Error(`Failed to save transcript to Drive: ${error.message}`);
  }
}

async function getMyDriveFolderByName(authClient, folderName) {
  const response = await drive.files.list({
    auth: authClient,
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`,
    spaces: 'drive',
    pageSize: 1,
    fields: 'files(id,name)'
  });
  return response.data.files?.[0]?.id;
}

// ─── Debug endpoint ───────────────────────────────────────────────────────────
app.get('/api/debug', verifyGoogleToken, async (req, res) => {
  try {
    const authClient = await getAuthClient(req);
    const response = await drive.files.list({
      auth: authClient,
      q: `'${CONFIG.DRIVE_FOLDER_ID}' in parents and trashed=false`,
      spaces: 'drive',
      pageSize: 50,
      fields: 'files(id,name,mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    res.json({ folderId: CONFIG.DRIVE_FOLDER_ID, files: response.data.files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Search endpoint ──────────────────────────────────────────────────────────
// POST /api/search
// Body: { query: string, platform: 'tiktok'|'reels'|'linkedin'|'all', speaker?: string }
app.post('/api/search', async (req, res) => {
  const { query, platform = 'all', speaker = null, collection = null } = req.body;
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Search not available — Supabase not configured' });
  }
  if (!CONFIG.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'Search not available — OpenAI key not configured' });
  }

  try {
    // 1. Generate embedding for the query
    const embedRes = await axios.post('https://api.openai.com/v1/embeddings', {
      model: 'text-embedding-3-small',
      input: query.trim()
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` },
      timeout: 15000
    });
    const embedding = embedRes.data.data[0].embedding;

    // 2. Map platform to duration range
    // Minimum of 20s on all platforms — excludes short interviewer-question-only chunks
    // and ensures results include the actual answer, not just the prompt.
    const durations = {
      tiktok:   { min: 20000,  max: 60000  },
      reels:    { min: 20000,  max: 60000  },
      linkedin: { min: 20000,  max: 90000  },
      all:      { min: 20000,  max: null   }
    };
    const { min, max } = durations[platform] || durations.all;

    // 3. Vector search via Supabase RPC
    // We exclude 'segment' type chunks (raw speaker turns) — they can be as short as
    // 2–3 seconds (e.g. just the interviewer's question). Instead we use the sliding
    // window chunks (30s/60s/90s) which naturally span question + answer together.
    // Run two searches and merge: one per useful window size, then deduplicate by video+time.
    const searchParams = {
      query_embedding:   embedding,
      min_duration_ms:   min,
      max_duration_ms:   max,
      filter_speaker:    speaker || null,
      match_count:       25,
      filter_collection: collection || null
    };

    // Fetch results excluding segment-only chunks by fetching more and filtering client-side
    const { data: rawData, error } = await supabase.rpc('search_clips', searchParams);

    if (error) throw new Error(error.message);

    // Filter out pure 'segment' chunks — keep only window chunks (30s/60s/90s)
    // unless NO window chunks exist (fallback to segments so we always return something)
    const windowChunks = (rawData || []).filter(r => r.chunk_type !== 'segment');
    const data = windowChunks.length > 0 ? windowChunks : (rawData || []);

    if (error) throw new Error(error.message);

    // 4. Fetch video titles for results
    const videoIds = [...new Set((data || []).map(r => r.video_id))];
    const { data: videoRows } = await supabase
      .from('videos')
      .select('id, title, file_name, drive_file_id, video_drive_id, collection')
      .in('id', videoIds);
    const videoMap = Object.fromEntries((videoRows || []).map(v => [v.id, v]));

    // 5. Format results
    const mapped = (data || []).map(r => {
      const video = videoMap[r.video_id] || {};
      // Direct video link if we have video_drive_id, otherwise fall back to title search
      const driveLink = video.video_drive_id
        ? `https://drive.google.com/file/d/${video.video_drive_id}/view`
        : null;
      return {
        id:           r.id,
        video_id:     r.video_id,
        video_title:  video.title || video.file_name || r.video_id,
        collection:   video.collection || null,
        video_drive_link: driveLink,
        speaker_name: r.speaker_name || r.speaker_label || 'Unknown',
        text:         r.text,
        start_ms:     r.start_ms,
        end_ms:       r.end_ms,
        duration_ms:  r.duration_ms,
        chunk_type:   r.chunk_type,
        similarity:   Math.round(r.similarity * 100),
        start_fmt:    msToTimestamp(r.start_ms),
        end_fmt:      msToTimestamp(r.end_ms),
      };
    });

    // Deduplicate: same clip can match via different chunk windows
    const seen = new Set();
    const deduped = mapped.filter(r => {
      const key = `${r.video_id}:${r.start_ms}:${r.end_ms}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Filter out Spanish/bilingual chunks (¿ and ¡ are reliable markers)
    const results = deduped.filter(r => !r.text.includes('¿') && !r.text.includes('¡'));

    res.json({ results });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Collections (parent-folder) list endpoint ───────────────────────────────
// GET /api/collections
// Powers the "Folder" filter dropdown in the search UI — returns each distinct
// collection tag (Norway 2026, SF Content Week 2026, Webinars, ...) plus how
// many videos carry it, via the collection_list view (see schema.sql /
// add_collection_column.sql). Rows ingested before the collection column
// existed have collection = null and are excluded here by the view itself.
app.get('/api/collections', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { data, error } = await supabase
    .from('collection_list')
    .select('collection, video_count')
    .order('collection');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ collections: data || [] });
});

function msToTimestamp(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

// Explicit root route — serves the search UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Context endpoint ─────────────────────────────────────────────────────────
// GET /api/context?video_id=...&start_ms=...&end_ms=...
// Returns the individual speaker-turn segments surrounding a matched clip
app.get('/api/context', async (req, res) => {
  const { video_id, start_ms, end_ms } = req.query;
  if (!video_id || start_ms === undefined || end_ms === undefined) {
    return res.status(400).json({ error: 'video_id, start_ms, end_ms required' });
  }
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  const s   = parseInt(start_ms);
  const e   = parseInt(end_ms);
  const pad = 90000; // show up to 90s before/after the clip

  const { data, error } = await supabase
    .from('transcript_chunks')
    .select('id, speaker_name, speaker_label, text, start_ms, end_ms, chunk_type')
    .eq('video_id', video_id)
    .eq('chunk_type', 'segment')
    .gte('start_ms', s - pad)
    .lte('end_ms', e + pad)
    .order('start_ms', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ segments: (data || []).map(seg => ({
    speaker: seg.speaker_name || seg.speaker_label || 'Speaker',
    text:    seg.text,
    start_ms: seg.start_ms,
    end_ms:   seg.end_ms,
  }))});
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    auth: serviceAccountAuth ? 'service-account' : 'oauth-token'
  });
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message });
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = CONFIG.PORT;
const server = app.listen(PORT, () => {
  console.log(`SafetyWing Transcription Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

module.exports = app;
