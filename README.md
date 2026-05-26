# SafetyWing Content Transcription Engine - Setup Guide

## Overview

This is a full-stack solution for transcribing SF Content Week videos:

- **Backend (Node.js)**: Downloads videos from Drive, extracts audio, transcribes with Whisper, saves transcripts
- **Frontend (HTML)**: iPad-friendly interface to manage the process

**Key feature**: All processing happens server-side — nothing downloads to your iPad.

-----

## Prerequisites

### Option A: Local Testing (Mac/Linux/Windows)

1. **Node.js 18+** — Download from <https://nodejs.org/>
1. **FFmpeg** — Required for audio extraction
- **Mac**: `brew install ffmpeg`
- **Linux**: `sudo apt-get install ffmpeg`
- **Windows**: Download from <https://ffmpeg.org/download.html>
1. **Google Drive credentials**
1. **Whisper API key** (you have this)

### Option B: Cloud Deployment (Recommended for production)

We’ll use one of these (see **Deployment** section below):

- Heroku, Render, Railway, or AWS

-----

## Local Setup (Testing)

### Step 1: Install Dependencies

```bash
# Navigate to project directory
cd /path/to/transcription-project

# Install Node.js dependencies
npm install

# Or if you use yarn:
yarn install
```

### Step 2: Create `.env` File

```bash
# Copy the example
cp .env.example .env

# Edit .env with your credentials
# Replace with your actual API key (don't share this!)
WHISPER_API_KEY=lGGxKRx4IXnDNIVamkBskbBAyo39LtG6
DRIVE_FOLDER_ID=1PYaVpIoaaszLaM-T-sE73SI4GI7w_Q45
PORT=3000
```

### Step 3: Verify FFmpeg

```bash
ffmpeg -version
```

If this fails, FFmpeg is not installed properly.

### Step 4: Start the Server

```bash
npm start
# Server should be running at http://localhost:3000
```

You should see:

```
🎬 SafetyWing Transcription Server running on port 3000
API endpoints:
  GET  /api/health - Health check
  GET  /api/videos - List videos from Camera 1
  POST /api/transcribe - Transcribe a video
```

### Step 5: Get Google Drive Access Token

1. Go to: <https://developers.google.com/drive/api/quickstart/js>
1. Click “Enable the Google Drive API”
1. Create OAuth 2.0 credentials (Desktop application)
1. In your browser console, authenticate and grab the access token

**For testing**, you can use Google’s OAuth Playground:

1. Visit: <https://developers.google.com/oauthplayground>
1. Select “Drive API v3” → “<https://www.googleapis.com/auth/drive>”
1. Authorize and copy the access token

### Step 6: Open Frontend

1. Open `frontend.html` in Safari (on iPad or computer)
1. Paste your server URL: `http://localhost:3000`
1. Paste your Google Drive access token
1. Click “Load Videos”

-----

## Cloud Deployment

### Option 1: Render (Easiest)

1. **Push code to GitHub**:
   
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/yourusername/safetywing-transcription.git
   git branch -M main
   git push -u origin main
   ```
1. **Create Render account** at <https://render.com>
1. **Deploy**:
- Click “New +” → “Web Service”
- Connect your GitHub repo
- Set build command: `npm install`
- Set start command: `npm start`
- Add environment variables:
  - `WHISPER_API_KEY=lGGxKRx4IXnDNIVamkBskbBAyo39LtG6`
  - `DRIVE_FOLDER_ID=1PYaVpIoaaszLaM-T-sE73SI4GI7w_Q45`
  - `PORT=3000`
- Click “Create Web Service”
1. **Your deployed URL** will be like: `https://safetywing-transcription.onrender.com`

### Option 2: Railway

1. **Push to GitHub** (same as above)
1. **Create Railway account** at <https://railway.app>
1. **Deploy**:
- Click “New Project” → “Deploy from GitHub”
- Select your repo
- Railway auto-detects Node.js
- Add environment variables (same as Render)
1. **Your URL** will be auto-generated

### Option 3: AWS EC2 (Advanced)

For larger deployments, you might want AWS. This requires more setup but is very powerful:

1. Launch an EC2 instance (t2.medium recommended)
1. Install Node.js and FFmpeg
1. Deploy code using GitHub or direct upload
1. Use PM2 or systemd to keep process running
1. Configure security groups for HTTPS

-----

## Frontend Usage (iPad)

### First Time Setup

1. **Open frontend.html** in Safari
1. **Enter server URL**:
- Local: `http://localhost:3000`
- Cloud: `https://yourdomain.onrender.com`
1. **Get Google Drive access token** (see step 5 above)
1. **Paste token** and click “Save Configuration”
1. Click **“Load Videos”** — should show all Camera 1 videos

### Transcribing Videos

- **Single video**: Click “Transcribe” button next to video
- **All videos**: Click “Transcribe All”
- **Progress**: Watch the progress bar and logs in real-time
- **Results**: Transcripts automatically save to Drive in “Transcripts” folder

-----

## How It Works

### Workflow

```
iPad (Frontend)
  ↓
  └→ Server (Backend)
      ├→ 1. Download video from Drive
      ├→ 2. Extract audio (FFmpeg)
      ├→ 3. Send to Whisper API
      ├→ 4. Save transcript to Drive
      └→ Return status to iPad
```

### What Gets Saved

Each transcript is a JSON file with **word-level timestamps**:

```json
{
  "text": "Sondre talks about flexible work...",
  "words": [
    { "word": "Sondre", "start": 0.5, "end": 1.2 },
    { "word": "talks", "start": 1.2, "end": 1.8 },
    { "word": "about", "start": 1.8, "end": 2.1 },
    ...
  ]
}
```

This is exactly what you need for the search engine’s next phase!

-----

## Troubleshooting

### “FFmpeg not found”

- Ensure FFmpeg is installed: `ffmpeg -version`
- On Mac: `brew install ffmpeg`
- On Linux: `sudo apt-get install ffmpeg`

### “Connection refused” (local)

- Make sure server is running: `npm start`
- Check it’s on port 3000: <http://localhost:3000/api/health>

### “Invalid token”

- Refresh your Google Drive access token
- Go to <https://developers.google.com/oauthplayground> and get a fresh one

### “Whisper API error”

- Check your API key in `.env`
- Verify you have API credits at <https://platform.openai.com>

### “Videos not loading”

- Confirm Google Drive token has Drive access
- Check Proxies/Cam 1 folder exists in Drive

-----

## Next Steps (After Transcription)

Once you have all transcripts, we’ll build:

1. **Database indexing** — Store transcripts in PostgreSQL
1. **Search API** — Keyword + semantic search
1. **Clip extraction** — Auto-cut videos based on timestamps

This is Phase 2 of your content engine!

-----

## Files Included

```
transcription-project/
├── server.js              # Node.js backend
├── package.json           # Dependencies
├── .env.example           # Environment template
├── frontend.html          # iPad web interface
└── README.md             # This file
```

-----

## Support

For issues:

1. Check logs in the browser console (Cmd+Option+J)
1. Check server logs in terminal
1. Verify configuration (server URL, tokens)
1. Test with `curl http://localhost:3000/api/health`

-----

**Ready to transcribe?** Start with local setup, then move to cloud for production! 🚀