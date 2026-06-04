const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { google } = require('googleapis');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const CONFIG = {
  WHISPER_API_KEY: process.env.WHISPER_API_KEY || 'lGGxKRx4IXnDNIVamkBskbBAyo39LtG6',
  DRIVE_FOLDER_ID: '1PYaVpIoaaszLaM-T-sE73SI4GI7w_Q45',
  PORT: process.env.PORT || 3000,
  TEMP_DIR: path.join(__dirname, 'temp'),
  DATABASE_URL: process.env.DATABASE_URL
};

if (!fs.existsSync(CONFIG.TEMP_DIR)) {
  fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true });
}

const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const drive = google.drive('v3');

async function verifyGoogleToken(req, res, next) {
  let token = req.headers.authorization?.split(' ')[1];
  if (!token) token = req.query.token;
  if (!token) return res.status(401).json({ error: 'No authorization token' });
  req.googleAuth = { accessToken: token };
  next();
}

app.get('/api/videos', verifyGoogleToken, async (req, res) => {
  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token: req.googleAuth.accessToken });

    let proxiesFolderId = await getFolderIdByName(authClient, CONFIG.DRIVE_FOLDER_ID, 'Proxies');
    if (!proxiesFolderId) return res.status(404).json({ error: 'Proxies folder not found' });

    let cam1FolderId = await getFolderIdByName(authClient, proxiesFolderId, 'Cam 1');
    if (!cam1FolderId) return res.status(404).json({ error: 'Cam 1 folder not found' });

    const videos = await listMp4Files(authClient, cam1FolderId);
    res.json({ videos });
  } catch (error) {
    console.error('Error listing videos:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/transcribe', verifyGoogleToken, async (req, res) => {
  const { videoId, videoName } = req.body;
  if (!videoId || !videoName) return res.status(400).json({ error: 'videoId and videoName required' });

  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token: req.googleAuth.accessToken });

    console.log(`[${videoName}] Starting...`);
    await pool.query('INSERT INTO videos (video_id, video_name, transcript_status) VALUES ($1, $2, $3) ON CONFLICT (video_id) DO UPDATE SET transcript_status = $3', 
      [videoId, videoName, 'processing']);

    const videoPath = path.join(CONFIG.TEMP_DIR, `${Date.now()}_${videoName}`);
    await downloadFile(authClient, videoId, videoPath);
    console.log(`[${videoName}] Downloaded`);

    const audioPath = videoPath.replace(/\.[^.]+$/, '.wav');
    await extractAudio(videoPath, audioPath);
    console.log(`[${videoName}] Audio extracted`);

    const transcript = await transcribeWithWhisper(audioPath);
    console.log(`[${videoName}] Transcribed`);

    await saveTranscriptToDB(videoId, videoName, transcript);
    console.log(`[${videoName}] Saved to DB`);

    try {
      fs.unlinkSync(videoPath);
      fs.unlinkSync(audioPath);
    } catch (e) {}

    await pool.query('UPDATE videos SET transcript_status = $1 WHERE video_id = $2', ['completed', videoId]);
    res.json({ success: true, transcriptName: videoName.replace('.mp4', '.json') });

  } catch (error) {
    console.error(`Error transcribing ${videoName}:`, error.message);
    await pool.query('UPDATE videos SET transcript_status = $1 WHERE video_id = $2', ['error', videoId]);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/search', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'Search query required' });

  try {
    const results = await pool.query(
      `SELECT t.id, t.video_id, t.video_name, ts.segment_text, ts.start_time, ts.end_time
       FROM transcripts t
       JOIN transcript_segments ts ON t.id = ts.transcript_id
       WHERE ts.segment_text ILIKE $1
       ORDER BY t.video_name, ts.start_time
       LIMIT 100`,
      [`%${query}%`]
    );

    const grouped = {};
    results.rows.forEach(row => {
      if (!grouped[row.video_id]) {
        grouped[row.video_id] = { videoId: row.video_id, videoName: row.video_name, clips: [] };
      }
      grouped[row.video_id].clips.push({
        text: row.segment_text,
        startTime: row.start_time,
        endTime: row.end_time
      });
    });

    res.json({ results: Object.values(grouped) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/extract-clip', verifyGoogleToken, async (req, res) => {
  const { videoId, startTime, endTime } = req.body;
  if (!videoId || startTime === undefined || endTime === undefined) {
    return res.status(400).json({ error: 'videoId, startTime, endTime required' });
  }

  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token: req.googleAuth.accessToken });

    const videoPath = path.join(CONFIG.TEMP_DIR, `${Date.now()}_source.mp4`);
    await downloadFile(authClient, videoId, videoPath);

    const clipPath = path.join(CONFIG.TEMP_DIR, `${Date.now()}_clip.mp4`);
    const duration = parseFloat(endTime) - parseFloat(startTime);
    const command = `ffmpeg -i "${videoPath}" -ss ${startTime} -t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${clipPath}" -y`;
    
    execSync(command, { stdio: 'pipe', timeout: 600000 });

    const clipBuffer = fs.readFileSync(clipPath);
    fs.unlinkSync(videoPath);
    fs.unlinkSync(clipPath);

    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', `attachment; filename="clip_${startTime}_${endTime}.mp4"`);
    res.send(clipBuffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function getFolderIdByName(authClient, parentFolderId, folderName) {
  const response = await drive.files.list({
    auth: authClient,
    q: `'${parentFolderId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: 'drive',
    pageSize: 1,
    fields: 'files(id,name)'
  });
  return response.data.files?.[0]?.id;
}

async function listMp4Files(authClient, folderId) {
  const response = await drive.files.list({
    auth: authClient,
    q: `'${folderId}' in parents and mimeType='video/mp4' and trashed=false`,
    spaces: 'drive',
    pageSize: 1000,
    fields: 'files(id,name,size,mimeType)',
    orderBy: 'name'
  });
  return response.data.files || [];
}

async function downloadFile(authClient, fileId, filePath) {
  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(filePath);
    drive.files.get(
      { auth: authClient, fileId: fileId, alt: 'media' },
      { responseType: 'stream' },
      (err, response) => {
        if (err) { dest.destroy(); return reject(err); }
        response.data.on('error', reject).pipe(dest).on('finish', resolve).on('error', reject);
      }
    );
  });
}

async function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    try {
      const command = `ffmpeg -i "${videoPath}" -q:a 0 -map a "${audioPath}" -y`;
      execSync(command, { stdio: 'pipe', timeout: 600000 });
      resolve();
    } catch (error) {
      reject(new Error(`FFmpeg error: ${error.message}`));
    }
  });
}

async function transcribeWithWhisper(audioPath) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(audioPath));
  formData.append('model', 'whisper-1');
  formData.append('timestamp_granularities', 'word');

  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    formData,
    {
      headers: { ...formData.getHeaders(), 'Authorization': `Bearer ${CONFIG.WHISPER_API_KEY}` },
      timeout: 600000
    }
  );
  return response.data;
}

async function saveTranscriptToDB(videoId, videoName, transcript) {
  const transcriptResult = await pool.query(
    'INSERT INTO transcripts (video_id, video_name, full_text) VALUES ($1, $2, $3) ON CONFLICT (video_id) DO UPDATE SET full_text = $3 RETURNING id',
    [videoId, videoName, transcript.text]
  );

  const transcriptId = transcriptResult.rows[0].id;
  await pool.query('DELETE FROM transcript_segments WHERE transcript_id = $1', [transcriptId]);

  if (transcript.words && Array.isArray(transcript.words)) {
    for (let i = 0; i < transcript.words.length; i++) {
      const word = transcript.words[i];
      await pool.query(
        'INSERT INTO transcript_segments (transcript_id, segment_text, start_time, end_time, word_index) VALUES ($1, $2, $3, $4, $5)',
        [transcriptId, word.word, word.start, word.end, i]
      );
    }
  }
  return transcriptId;
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_videos,
        SUM(CASE WHEN transcript_status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN transcript_status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM videos
    `);
    res.json(stats.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message });
});

const PORT = CONFIG.PORT;
app.listen(PORT, () => {
  console.log(`🎬 SafetyWing Server running on port ${PORT}`);
});

module.exports = app;
