# ResonanceAI 

An intelligent, real-time meeting analysis platform featuring facial engagement tracking, sentiment analysis, dominance scoring, and speaker transcription.

## Features
- **Real-time WebRTC Mesh Video/Audio:** Peer-to-peer low latency communication.
- **Visual Engagement Tracking:** Uses Google MediaPipe to track if participants are actively looking at the screen, visualizing this on a timeline.
- **Live AI Transcriptions:** OpenAI Whisper processes audio chunks and generates transcripts.
- **Meeting Intelligence Dashboard:**
  - Talk Time & Dominance Distribution
  - Real-time Sentiment & Mood Trending (DistilBERT)
  - Silent Participant Detection
  - Speaker Confidence Scoring
- **Confidential Mode:** Ensures no data is persisted or downloaded after the meeting.

## Tech Stack
- **Frontend:** React 19, Vite, TypeScript, WebRTC, MediaPipe (FaceLandmarker)
- **Backend:** Python 3.10+, FastAPI, Whisper, PyTorch, Transformers (DistilBERT)
- **Deployment:** Docker (Backend)

## Running Locally

### Prerequisites
- Node.js 18+
- Python 3.10+
- FFmpeg installed locally and added to PATH

### 1. Start the Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Or `.\.venv\Scripts\activate` on Windows
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

### 2. Start the Frontend
```bash
cd frontend
npm install
npm run dev
```

## Deployment
The backend requires `ffmpeg` to process audio for Whisper. Because most serverless platforms do not include FFmpeg by default, the backend must be deployed using the provided `Dockerfile` (e.g., on Render, Railway, or a VPS). The frontend can be deployed easily on Vercel or Netlify.
