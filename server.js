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

// Middleware to verify Google token - ACCEPTS TOKEN FROM URL OR HEADER
async function verifyGoogleToken(req, res, next) {
  let token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    token = req.query.token;
  }
  
  if (!token) {
    return res.status(401).json({ error: 'No authorization token. Use ?token=YOUR_TOKEN in URL' });
  }

  req.googleAuth = { accessToken: token };
  next();
}

app.get('/api/videos', verifyGoogleToken, async (req, res) => {
  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token: req.googleAuth.accessToken });

    let proxiesFolderId = await getFolderIdByName(authClient, CONFIG.DRIVE_FOLDER_ID, 'Proxies');
    if (!proxiesFolderId) {
      return res.status(404).json({ error: 'Proxies folder not found' });
    }

    let cam1FolderId = await getFolderIdByName(authClient, proxiesFolderId, 'Cam 1');
    if (!cam1FolderId) {
      return res.status(404).json({ error: 'Cam 1 folder not found' });
    }

    const videos = await listMp4Files(authClient, cam1FolderId);
    res.json({ videos });

  } catch (error) {
    console.error('Error listing videos:', error);
    res.status(500).json({ error: error.message });
  }
});

async function getFolderIdByName(authClient, parentFolderId, folderName) {
  try {
    const response = await drive.files.list({
      auth: authClient,
      q: `'${parentFolderId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      spaces: 'drive',
      pageSize: 1,
      fields: 'files(id,name)'
    });

    return response.data.files?.[0]?.id;
  } catch (error) {
    console.error('Error getting folder ID:', error);
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
      orderBy: 'name'
    });

    return response.data.files || [];
  } catch (error) {
    console.error('Error listing files:', error);
    throw error;
  }
}

app.post('/api/transcribe', verifyGoogleToken, async (req, res) => {
  const { videoId, videoName } = req.body;

  if (!videoId || !videoName) {
    return res.status(400).json({ error: 'videoId and videoName required' });
  }

  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token: req.googleAuth.accessToken });

    console.log(`[${videoName}] Starting download...`);
    const videoPath = path.join(CONFIG.TEMP_DIR, `${Date.now()}_${videoName}`);
    await downloadFile(authClient, videoId, videoPath);
    console.log(`[${videoName}] Download complete`);

    console.log(`[${videoName}] Extracting audio...`);
    const audioPath = videoPath.replace(/\.[^.]+$/, '.wav');
    await extractAudio(videoPath, audioPath);
    console.log(`[${videoName}] Audio extracted`);

    console.log(`[${videoName}] Sending to Whisper...`);
    const transcript = await transcribeWithWhisper(audioPath);
    console.log(`[${videoName}] Transcription complete`);

    console.log(`[${videoName}] Saving to Drive...`);
    const transcriptName = videoName.replace('.mp4', '.json');
    await saveTranscriptToDrive(authClient, transcript, transcriptName);
    console.log(`[${videoName}] Saved!`);

    try {
      fs.unlinkSync(videoPath);
      fs.unlinkSync(audioPath);
    } catch (e) {
      console.log(`Warning: Could not delete temp files`);
    }

    res.json({ success: true, transcriptName });

  } catch (error) {
    console.error(`Error transcribing ${videoName}:`, error);
    res.status(500).json({ error: error.message });
  }
});

async function downloadFile(authClient, fileId, filePath) {
  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(filePath);

    drive.files.get(
      {
        auth: authClient,
        fileId: fileId,
        alt: 'media'
      },
      { responseType: 'stream' },
      (err, response) => {
        if (err) {
          dest.destroy();
          return reject(err);
        }

        response.data
          .on('error', reject)
          .pipe(dest)
          .on('finish', resolve)
          .on('error', reject);
      }
    );
  });
}

async function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    try {
      const command = `ffmpeg -i "${videoPath}" -q:a 0 -map a "${audioPath}" -y`;
      
      execSync(command, { 
        stdio: 'pipe',
        timeout: 600000
      });
      
      resolve();
    } catch (error) {
      reject(new Error(`FFmpeg error: ${error.message}`));
    }
  });
}

async function transcribeWithWhisper(audioPath) {
  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioPath));
    formData.append('model', 'whisper-1');
    formData.append('timestamp_granularities', 'word');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${CONFIG.WHISPER_API_KEY}`
        },
        timeout: 600000
      }
    );

    return response.data;
  } catch (error) {
    throw new Error(`Whisper API error: ${error.response?.data?.error?.message || error.message}`);
  }
}

async function saveTranscriptToDrive(authClient, transcript, fileName) {
  try {
    let transcriptsFolderId = await getFolderIdByName(authClient, CONFIG.DRIVE_FOLDER_ID, 'Transcripts');
    
    if (!transcriptsFolderId) {
      console.log('Creating Transcripts folder...');
      const createResponse = await drive.files.create({
        auth: authClient,
        resource: {
          name: 'Transcripts',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [CONFIG.DRIVE_FOLDER_ID]
        },
        fields: 'id'
      });
      transcriptsFolderId = createResponse.data.id;
    }

    const transcriptContent = JSON.stringify(transcript, null, 2);
    
    const media = {
      mimeType: 'application/json',
      body: transcriptContent
    };

    const uploadResponse = await drive.files.create({
      auth: authClient,
      resource: {
        name: fileName,
        mimeType: 'application/json',
        parents: [transcriptsFolderId]
      },
      media: media,
      fields: 'id'
    });

    return uploadResponse.data.id;
  } catch (error) {
    throw new Error(`Failed to save transcript: ${error.message}`);
  }
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message });
});

const PORT = CONFIG.PORT;
app.listen(PORT, () => {
  console.log(`🎬 SafetyWing Transcription Server running on port ${PORT}`);
  console.log(`API endpoints:`);
  console.log(`  GET  /api/health - Health check`);
  console.log(`  GET  /api/videos - List videos from Camera 1`);
  console.log(`  POST /api/transcribe - Transcribe a video`);
});

module.exports = app;
