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
  WHISPER_API_KEY: process.env.WHISPER_API_KEY || 'lGGxKRx4IXnDNIVamkBskbBAyo39LtG6',
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
    const transcript = await transcribeWithWhisper(audioPath);
    const transcriptName = videoName.replace('.mp4', '.json');
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
      // Compressed mono MP3 at 16kHz/32kbps — well under Whisper's 25MB limit (~14MB/hour)
      const command = `ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -ac 1 -ar 16000 -b:a 32k "${audioPath}" -y`;
      execSync(command, { stdio: 'pipe', timeout: 600000 });
      resolve();
    } catch (error) { reject(new Error(`FFmpeg error: ${error.message}`)); }
  });
}

async function transcribeWithWhisper(audioPath) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(audioPath));
  formData.append('model', 'whisper-1');
  formData.append('timestamp_granularities', 'word');
  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
    headers: { ...formData.getHeaders(), 'Authorization': `Bearer ${CONFIG.WHISPER_API_KEY}` },
    timeout: 600000
  });
  return response.data;
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

app.get('/api/debug', verifyGoogleToken, async (req, res) => {
  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token: req.googleAuth.accessToken });
    const response = await drive.files.list({
      auth: authClient, q: `'${CONFIG.DRIVE_FOLDER_ID}' in parents and trashed=false`,
      spaces: 'drive', pageSize: 50, fields: 'files(id,name,mimeType)',
      supportsAllDrives: true, includeItemsFromAllDrives: true
    });
    res.json({ folderId: CONFIG.DRIVE_FOLDER_ID, files: response.data.files });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

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
