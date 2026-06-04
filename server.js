const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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

const drive = google.drive('v3');

async function verifyGoogleToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No authorization token' });
  try { req.googleAuth = { accessToken: token }; next(); }
  catch (error) { res.status(401).json({ error: 'Invalid token' }); }
}

app.get('/api/videos', verifyGoogleToken, async (req, res) => {
  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token: req.googleAuth.accessToken });
    let proxiesFolderId = await getFolderIdByName(authClient, CONFIG.DRIVE_FOLDER_ID, 'Proxies');
    if (!proxiesFolderId) return res.status(404).json({ error: 'Proxies folder not found inside folder ID: ' + CONFIG.DRIVE_FOLDER_ID });
    const dayFolders = await listSubfolders(authClient, proxiesFolderId);
    const allVideos = [];
    for (const dayFolder of dayFolders) {
      const cam1Id = await getFolderIdByName(authClient, dayFolder.id, 'Cam 1');
      if (!cam1Id) continue;
      const videos = await listMp4Files(authClient, cam1Id);
      videos.forEach(v => v.day = dayFolder.name);
      allVideos.push(...videos);
    }
    res.json({ videos: allVideos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function getFolderIdByName(authClient, parentFolderId, folderName) {
  const response = await drive.files.list({
    auth: authClient,
    q: `'${parentFolderId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: 'drive', pageSize: 1, fields: 'files(id,name)',
    supportsAllDrives: true, includeItemsFromAllDrives: true
  });
  return response.data.files?.[0]?.id;
}

async function listSubfolders(authClient, parentFolderId) {
  const response = await drive.files.list({
    auth: authClient,
    q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: 'drive', pageSize: 100, fields: 'files(id,name)', orderBy: 'name',
    supportsAllDrives: true, includeItemsFromAllDrives: true
  });
  return response.data.files || [];
}

async function listMp4Files(authClient, folderId) {
  const response = await drive.files.list({
    auth: authClient,
    q: `'${folderId}' in parents and mimeType='video/mp4' and trashed=false`,
    spaces: 'drive', pageSize: 1000, fields: 'files(id,name,size,mimeType)', orderBy: 'name',
    supportsAllDrives: true, includeItemsFromAllDrives: true
  });
  return response.data.files || [];
}

app.post('/api/transcribe', verifyGoogleToken, async (req, res) => {
  const { videoId, videoName } = req.body;
  if (!videoId || !videoName) return res.status(400).json({ error: 'videoId and videoName required' });
  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token: req.googleAuth.accessToken });
    const videoPath = path.join(CONFIG.TEMP_DIR, `${Date.now()}_${videoName}`);
    await downloadFile(authClient, videoId, videoPath);
    const audioPath = videoPath.replace(/\.[^.]+$/, '.mp3');
    await extractAudio(videoPath, audioPath);
    const transcript = await transcribeWithAssemblyAI(audioPath);
    const safeTitle = transcript.title
      ? transcript.title.replace(/[^a-z0-9\s\-]/gi, '').trim().substring(0, 80)
      : null;
    const transcriptName = safeTitle ? `${safeTitle}.json` : videoName.replace('.mp4', '.json');
    await saveTranscriptToDrive(authClient, transcript, transcriptName);
    try { fs.unlinkSync(videoPath); fs.unlinkSync(audioPath); } catch (e) {}
    res.json({ success: true, transcriptName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function downloadFile(authClient, fileId, filePath) {
  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(filePath);
    drive.files.get({ auth: authClient, fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' }, (err, response) => {
      if (err) { dest.destroy(); return reject(err); }
      response.data.on('error', reject).pipe(dest).on('finish', resolve).on('error', reject);
    });
  });
}

async function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    try {
      const command = `ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -ac 1 -ar 16000 -b:a 32k "${audioPath}" -y`;
      execSync(command, { stdio: 'pipe', timeout: 600000 });
      resolve();
    } catch (error) { reject(new Error(`FFmpeg error: ${error.message}`)); }
  });
}

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
    /\bI'?m\s+([A-Z][a-z]+)\b/,
    /\bmy name is\s+([A-Z][a-z]+)\b/i,
    /\bI am\s+([A-Z][a-z]+)\b/,
    /\bthis is\s+([A-Z][a-z]+)\b/i,
    /\bcall me\s+([A-Z][a-z]+)\b/i,
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
  console.log('Speaker names detected:', mergedNames);

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

async function saveTranscriptToDrive(authClient, transcript, fileName) {
  try {
    let transcriptsFolderId = await getMyDriveFolderByName(authClient, 'SafetyWing Transcripts');
    if (!transcriptsFolderId) {
      const r = await drive.files.create({
        auth: authClient,
        resource: { name: 'SafetyWing Transcripts', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
        fields: 'id'
      });
      transcriptsFolderId = r.data.id;
    }
    const uploadResponse = await drive.files.create({
      auth: authClient,
      resource: { name: fileName, mimeType: 'application/json', parents: [transcriptsFolderId] },
      media: { mimeType: 'application/json', body: JSON.stringify(transcript, null, 2) },
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
    spaces: 'drive', pageSize: 1, fields: 'files(id,name)'
  });
  return response.data.files?.[0]?.id;
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message });
});

app.listen(CONFIG.PORT, () => {
  console.log(`SafetyWing Transcription Server running on port ${CONFIG.PORT}`);
});

module.exports = app;
app.get('/api/videos', verifyGoogleToken, async (req, res) => {
  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token: req.googleAuth.accessToken });
    let proxiesFolderId = await getFolderIdByName(authClient, CONFIG.DRIVE_FOLDER_ID, 'Proxies');
    if (!proxiesFolderId) return res.status(404).json({ error: 'Proxies folder not found inside folder ID: ' + CONFIG.DRIVE_FOLDER_ID });
    const dayFolders = await listSubfolders(authClient, proxiesFolderId);
    const allVideos = [];
    for (const dayFolder of dayFolders) {
      const cam1Id = await getFolderIdByName(authClient, dayFolder.id, 'Cam 1');
      if (!cam1Id) continue;
      const videos = await listMp4Files(authClient, cam1Id);
      videos.forEach(v => v.day = dayFolder.name);
      allVideos.push(...videos);
    }
    res.json({ videos: allVideos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function getFolderIdByName(authClient, parentFolderId, folderName) {
  const response = await drive.files.list({
    auth: authClient,
    q: `'${parentFolderId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: 'drive', pageSize: 1, fields: 'files(id,name)',
    supportsAllDrives: true, includeItemsFromAllDrives: true
  });
  return response.data.files?.[0]?.id;
}

async function listSubfolders(authClient, parentFolderId) {
  const response = await drive.files.list({
    auth: authClient,
    q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: 'drive', pageSize: 100, fields: 'files(id,name)', orderBy: 'name',
    supportsAllDrives: true, includeItemsFromAllDrives: true
  });
  return response.data.files || [];
}

async function listMp4Files(authClient, folderId) {
  const response = await drive.files.list({
    auth: authClient,
    q: `'${folderId}' in parents and mimeType='video/mp4' and trashed=false`,
    spaces: 'drive', pageSize: 1000, fields: 'files(id,name,size,mimeType)', orderBy: 'name',
    supportsAllDrives: true, includeItemsFromAllDrives: true
  });
  return response.data.files || [];
}

app.post('/api/transcribe', verifyGoogleToken, async (req, res) => {
  const { videoId, videoName } = req.body;
  if (!videoId || !videoName) return res.status(400).json({ error: 'videoId and videoName required' });
  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token: req.googleAuth.accessToken });
    const videoPath = path.join(CONFIG.TEMP_DIR, `${Date.now()}_${videoName}`);
    await downloadFile(authClient, videoId, videoPath);
    const audioPath = videoPath.replace(/\.[^.]+$/, '.mp3');
    await extractAudio(videoPath, audioPath);
    const transcript = await transcribeWithAssemblyAI(audioPath);
    // Use descriptive title as filename if available
    const safeTitle = transcript.title
      ? transcript.title.replace(/[^a-z0-9\s\-]/gi, '').trim().substring(0, 80)
      : null;
    const transcriptName = safeTitle ? `${safeTitle}.json` : videoName.replace('.mp4', '.json');
    await saveTranscriptToDrive(authClient, transcript, transcriptName);
    try { fs.unlinkSync(videoPath); fs.unlinkSync(audioPath); } catch (e) {}
    res.json({ success: true, transcriptName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function downloadFile(authClient, fileId, filePath) {
  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(filePath);
    drive.files.get({ auth: authClient, fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' }, (err, response) => {
      if (err) { dest.destroy(); return reject(err); }
      response.data.on('error', reject).pipe(dest).on('finish', resolve).on('error', reject);
    });
  });
}

async function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    try {
      const command = `ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -ac 1 -ar 16000 -b:a 32k "${audioPath}" -y`;
      execSync(command, { stdio: 'pipe', timeout: 600000 });
      resolve();
    } catch (error) { reject(new Error(`FFmpeg error: ${error.message}`)); }
  });
}

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
      const enrichment = await enrichWithLeMUR(transcriptId, headers);
      return buildOutput(poll.data, enrichment);
    }
    if (status === 'error') throw new Error(`AssemblyAI error: ${poll.data.error}`);
  }
  throw new Error('Transcription timed out after 20 minutes');
}

async function enrichWithLeMUR(transcriptId, headers) {
  try {
    console.log('Running LeMUR enrichment...');
    const [titleRes, namesRes] = await Promise.all([
      axios.post('https://api.assemblyai.com/lemur/v3/task', {
        transcript_ids: [transcriptId],
        prompt: 'Generate a short descriptive title for this conversation capturing who is speaking and the main topic (e.g. "Sarah on why she founded SafetyWing"). Respond with ONLY the title, nothing else.',
        final_model: 'default'
      }, { headers, timeout: 60000 }),
      axios.post('https://api.assemblyai.com/lemur/v3/task', {
        transcript_ids: [transcriptId],
        prompt: 'List every speaker who introduces themselves by name. Speaker labels are single letters: A, B, C etc. Return ONLY a JSON object mapping each letter to the name, e.g. {"A": "Sarah", "B": "John"}. If nobody introduces themselves, return ONLY {}. No explanation.',
        final_model: 'default'
      }, { headers, timeout: 60000 })
    ]);

    const title = titleRes.data.response?.trim() || '';
    let speakerNames = {};
    try {
      const raw = namesRes.data.response?.trim() || '{}';
      const match = raw.match(/\{[^{}]*\}/);
      if (match) speakerNames = JSON.parse(match[0]);
    } catch (e) { console.log('Speaker name parse error:', e.message); }

    console.log(`LeMUR title: "${title}", names:`, speakerNames);
    return { title, speakerNames };
  } catch (e) {
    console.log('LeMUR skipped:', e.response?.data || e.message);
    return { title: '', speakerNames: {} };
  }
}

// Regex fallback: scan utterances for self-introductions like "I'm Sarah", "My name is John"
function detectNamesFromText(utterances) {
  const found = {};
  const patterns = [
    /\bI'?m\s+([A-Z][a-z]+)\b/,
    /\bmy name is\s+([A-Z][a-z]+)\b/i,
    /\bI am\s+([A-Z][a-z]+)\b/,
    /\bthis is\s+([A-Z][a-z]+)\b/i,
    /\bcall me\s+([A-Z][a-z]+)\b/i,
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
  // Merge LeMUR names with regex-detected names (LeMUR takes priority)
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

async function saveTranscriptToDrive(authClient, transcript, fileName) {
  try {
    let transcriptsFolderId = await getMyDriveFolderByName(authClient, 'SafetyWing Transcripts');
    if (!transcriptsFolderId) {
      const r = await drive.files.create({
        auth: authClient,
        resource: { name: 'SafetyWing Transcripts', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
        fields: 'id'
      });
      transcriptsFolderId = r.data.id;
    }
    const uploadResponse = await drive.files.create({
      auth: authClient,
      resource: { name: fileName, mimeType: 'application/json', parents: [transcriptsFolderId] },
      media: { mimeType: 'application/json', body: JSON.stringify(transcript, null, 2) },
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
    spaces: 'drive', pageSize: 1, fields: 'files(id,name)'
  });
  return response.data.files?.[0]?.id;
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message });
});

app.listen(CONFIG.PORT, () => {
  console.log(`SafetyWing Transcription Server running on port ${CONFIG.PORT}`);
});

module.exports = app;
