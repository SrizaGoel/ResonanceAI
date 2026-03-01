# ResonanceAI 

ResonanceAI is an intelligent, real-time meeting analysis platform that transforms live conversations into structured behavioral insights.
It combines peer-to-peer video conferencing with AI-driven engagement tracking, transcription, sentiment analysis, and productivity analytics — enabling organizations to measure communication effectiveness in real time.

## Live Demo

https://resonance-ai-five.vercel.app/

## Core Capibilities

ResonanceAI enhances digital meetings by providing:

- Real-time WebRTC Mesh Video & Audio
- Visual Engagement Tracking (Face Attention Detection)
- Live AI Speech Transcription
- Meeting Intelligence Dashboard
- Confidential Mode (Privacy-first analytics)
  
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
- **Deployment:** Frontend deployed on Vercel, Backend deployed on Hugging Face Spaces (Docker-based container)

## Running Locally

### Prerequisites
- Node.js 18+
- Python 3.10+
- FFmpeg installed locally and added to PATH

### 1. Start the Backend
```bash
cd backend
python -m venv .venv
`.\.venv\Scripts\activate` on Windows
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

### 2. Start the Frontend
```bash
cd frontend
npm install
npm run dev
```
## Project Vision

ResonanceAI transforms meetings into measurable intelligence.
Instead of simply hosting conversations, it analyzes behavioral dynamics, participation balance, and communication quality — enabling data-driven collaboration in modern digital workplaces.

## Team Members
- Sriza Goel : https://github.com/SrizaGoel
- Ranjeet Kaur : https://github.com/RanjeetKaur14
