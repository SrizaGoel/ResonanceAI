from fastapi import FastAPI, UploadFile, File, Request, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
from uuid import uuid4
import os
import whisper
import torch
import shutil
from pathlib import Path
from textblob import TextBlob # Keep for lightweight backup
from transformers import pipeline
import math
from datetime import datetime, timedelta

# --- FFmpeg Configuration (Mandatory for Whisper) ---
# Check if we are running locally on Windows vs inside Linux Docker
import platform
if platform.system() == "Windows":
    FFMPEG_PATH = r"C:\ffmpeg-8.0.1-essentials_build\ffmpeg-8.0.1-essentials_build\bin"
    if FFMPEG_PATH not in os.environ.get("PATH", ""):
        os.environ["PATH"] += os.pathsep + FFMPEG_PATH

app = FastAPI(title="ResonanceAI Simplified")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- AI Configuration ---
UPLOAD_DIR = Path("temp_audio")
UPLOAD_DIR.mkdir(exist_ok=True)

print("Loading Whisper Model (tiny)...")
model = whisper.load_model("tiny")
print("Whisper Ready!")

print("Loading Neural Sentiment Model (DistilBERT)...")
# Load a pre-trained model for sentiment analysis
sentiment_analyzer = pipeline(
    "sentiment-analysis", 
    model="distilbert-base-uncased-finetuned-sst-2-english",
    device=-1 # Use CPU for now to ensure compatibility
)
print("Sentiment AI Ready!")

class RoomSettings(BaseModel):
    auto_analyze: bool = True
    confidential: bool = False
    live_analytics: bool = True
    data_persistence: bool = True
    analysis_type: str = "live"

class RoomModel(BaseModel):
    id: str
    host: str
    participants: List[str]
    consent_status: dict = {}
    settings: dict
    created_at: datetime
    is_active: bool
    signals: dict = {} # room_id -> {target_user: [signals]}
    transcripts: List[dict] = [] # List of {user: str, text: str, timestamp: str}
    talk_times: dict = {} # username -> total speaking seconds
    turns: dict = {} # username -> total turn counts
    last_speaker: Optional[str] = None # tracks who spoke last to detect turn switches
    emotion_history: List[dict] = [] # List of {user: str, sentiment: float, timestamp: str} 
    confidence_scores: dict = {} # username -> float (0-100)

meetings = {}
rooms = {}

# --- WebSocket Connection Manager for Real-Time Signaling ---
class ConnectionManager:
    def __init__(self):
        self.active: dict[str, dict[str, WebSocket]] = {}  # room_id -> {username: ws}

    async def connect(self, room_id: str, username: str, ws: WebSocket):
        await ws.accept()
        if room_id not in self.active:
            self.active[room_id] = {}
        self.active[room_id][username] = ws
        print(f"[WS] {username} connected to room {room_id}")

    def disconnect(self, room_id: str, username: str):
        if room_id in self.active:
            self.active[room_id].pop(username, None)
        print(f"[WS] {username} disconnected from room {room_id}")

    async def send_to(self, room_id: str, target: str, data: dict):
        if room_id in self.active and target in self.active[room_id]:
            try:
                await self.active[room_id][target].send_json(data)
            except Exception:
                pass  # client disconnected

manager = ConnectionManager()

@app.websocket("/ws/{room_id}/{username}")
async def websocket_endpoint(ws: WebSocket, room_id: str, username: str):
    await manager.connect(room_id, username, ws)
    try:
        while True:
            data = await ws.receive_json()
            target = data.get("target")
            if target:
                await manager.send_to(room_id, target, data)
    except WebSocketDisconnect:
        manager.disconnect(room_id, username)

@app.get("/")
def home():
    return {"message": "Backend Running"}

import traceback

@app.post("/create-meeting")
async def create_meeting(request: Request):
    print("[*] create-meeting requested")
    try:
        try:
            data = await request.json()
            host = data.get("host", "Host")
            # --- Day 15: Support initial settings ---
            initial_settings = RoomSettings().model_dump()
            if "settings" in data:
                initial_settings.update(data["settings"])
        except:
            host = "Host"
            initial_settings = RoomSettings().model_dump()
            
        meeting_id = str(uuid4())
        print(f"[*] Creating room for {host}: {meeting_id} (Auto: {initial_settings.get('live_analytics')})")
        
        new_room = RoomModel(
            id=meeting_id,
            host=host,
            participants=[host],
            consent_status={host: False},
            settings=initial_settings,
            created_at=datetime.utcnow(),
            is_active=True,
            signals={},
            transcripts=[],
            talk_times={host: 0.0},
            turns={host: 0},
            last_speaker=None
        )
        rooms[meeting_id] = new_room
        meetings[meeting_id] = {"participants": [host], "audio_files": []}
        return {"meeting_id": meeting_id}
    except Exception as e:
        print(f"[!] create-meeting failed: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/rooms/{room_id}")
def get_room(room_id: str):
    if room_id not in rooms:
        return {"error": "Room not found"}
    
    room = rooms[room_id]
    total_meeting_time = max((datetime.utcnow() - room.created_at).total_seconds(), 1.0)
    total_turns = max(sum(room.turns.values()), 1)
    total_talk_time = sum(room.talk_times.values())
    
    # Calculate advanced metrics
    metrics = {}
    silent_users = []
    
    for user in room.participants:
        user_talk = room.talk_times.get(user, 0.0)
        user_turns = room.turns.get(user, 0)
        
        # User's formula: 0.6 * (Talk/TotalMeeting) + 0.4 * (Turns/TotalTurns)
        dominance = (0.6 * (user_talk / total_meeting_time)) + (0.4 * (user_turns / total_turns))
        
        metrics[user] = {
            "talk_time": round(user_talk, 2),
            "turns": user_turns,
            "dominance_score": round(dominance * 100, 2), # normalized to 0-100 for easier charting
            "talk_percentage": round((user_talk / total_talk_time * 100) if total_talk_time > 0 else 0, 1)
        }
        
        # Detect silent participants (e.g., < 5% of total talk time)
        if metrics[user]["talk_percentage"] < 5.0 and total_talk_time > 10:
            silent_users.append(user)

    # Return the vanilla room data PLUS the calculated intelligence
    response = jsonable_encoder(room)
    
    # Process Confidence & Emotion Summaries
    latest_emotions = {}
    for entry in reversed(room.emotion_history):
        if entry["user"] not in latest_emotions:
            latest_emotions[entry["user"]] = entry["sentiment"]
            
    response["intelligence"] = {
        "metrics": metrics,
        "silent_users": silent_users,
        "total_meeting_time": round(total_meeting_time, 2),
        "total_talk_time": round(total_talk_time, 2),
        "total_turns": total_turns,
        "latest_emotions": latest_emotions,
        "confidence_scores": room.confidence_scores,
        "emotion_trend": room.emotion_history[-20:] # Last 20 data points for the graph
    }
    return response

@app.post("/api/rooms/join")
async def join_room(request: Request):
    data = await request.json()
    room_id = data.get("room_id")
    username = data.get("username")
    
    if room_id in rooms:
        if username not in rooms[room_id].participants:
            rooms[room_id].participants.append(username)
            rooms[room_id].consent_status[username] = False
            rooms[room_id].talk_times[username] = 0.0
            rooms[room_id].turns[username] = 0
            meetings[room_id]["participants"].append(username)
        return rooms[room_id]
    return {"error": "Not found"}

@app.post("/api/rooms/{room_id}/consent")
async def update_consent(room_id: str, request: Request):
    data = await request.json()
    username = data.get("username")
    status = data.get("consent", False)
    if room_id in rooms and username in rooms[room_id].participants:
        rooms[room_id].consent_status[username] = status
        return {"status": "success"}
    return {"error": "Not found"}

@app.post("/api/rooms/{room_id}/signal")
async def post_signal(room_id: str, request: Request):
    data = await request.json()
    target = data.get("target")
    sender = data.get("sender")
    signal = data.get("signal")
    
    if room_id not in rooms: return {"error": "Room not found"}
    
    if target not in rooms[room_id].signals:
        rooms[room_id].signals[target] = []
    
    rooms[room_id].signals[target].append({"sender": sender, "signal": signal})
    return {"status": "sent"}

@app.get("/api/rooms/{room_id}/signal/{username}")
async def get_signals(room_id: str, username: str):
    if room_id in rooms and username in rooms[room_id].signals:
        signals = rooms[room_id].signals[username]
        rooms[room_id].signals[username] = [] # Clear after reading
        return {"signals": signals}
    return {"signals": []}

@app.post("/api/rooms/{room_id}/upload")
async def upload_audio(room_id: str, username: str, file: UploadFile = File(...)):
    if room_id not in rooms:
        return {"error": "Room not found"}
        
    room_dir = UPLOAD_DIR / room_id
    room_dir.mkdir(exist_ok=True)
    
    file_path = room_dir / f"{username}_{int(datetime.now().timestamp())}.webm"
    # Save the file
    with open(file_path, "wb") as buffer:
        content = await file.read()
        print(f"[*] Received audio chunk: {len(content)} bytes")
        buffer.write(content)
        
    # Trigger AI Transcription (Sync for now for simplified logic)
    try:
        print(f"[*] Transcribing chunk for {username}...")
        result = model.transcribe(str(file_path))
        text = result["text"].strip()
        print(f"[Whisper] Result for {username}: \"{text}\"")
        
        transcript_entry = {
            "user": username,
            "text": text,
            "timestamp": datetime.now().strftime("%H:%M:%S")
        }
        if transcript_entry["text"]: # Only add if not empty
            rooms[room_id].transcripts.append(transcript_entry)
            
            # --- DAY 7: Talk Time Calculation ---
            # Sum up durations of speech segments
            chunk_talk_time = 0.0
            for segment in result.get("segments", []):
                chunk_talk_time += segment["end"] - segment["start"]
            
            rooms[room_id].talk_times[username] = rooms[room_id].talk_times.get(username, 0.0) + chunk_talk_time
            print(f"[Day 10] Added {chunk_talk_time:.2f}s to {username}. Total: {rooms[room_id].talk_times[username]:.2f}s")
            
            # --- DAY 10: Turn Tracking ---
            if rooms[room_id].last_speaker != username:
                rooms[room_id].turns[username] = rooms[room_id].turns.get(username, 0) + 1
                rooms[room_id].last_speaker = username
                print(f"[Day 10] Turn switch detected! {username} now has {rooms[room_id].turns[username]} turns.")

            # --- DAY 14: Neural Emotional Tone (DistilBERT Upgrade) ---
            try:
                # TextBlob fallback if text is too short or weird
                if len(text.split()) < 3:
                    blob = TextBlob(text)
                    sentiment_score = blob.sentiment.polarity
                else:
                    nlp_res = sentiment_analyzer(text)[0]
                    # Map "POSITIVE" to 1.0, "NEGATIVE" to -1.0, weighted by score
                    base_val = 1.0 if nlp_res['label'] == 'POSITIVE' else -1.0
                    sentiment_score = base_val * nlp_res['score']
            except Exception as e:
                print(f"[!] Sentiment AI error: {e}")
                # Fallback to legacy
                blob = TextBlob(text)
                sentiment_score = blob.sentiment.polarity

            rooms[room_id].emotion_history.append({
                "user": username,
                "sentiment": round(sentiment_score, 2),
                "timestamp": datetime.now().strftime("%H:%M:%S")
            })
            
            # --- DAY 14: Enhanced Confidence Estimation (Neural Context) ---
            segments = result.get("segments", [])
            
            # 1. AI Certainty (Logprob) - Normalized to 0-1
            avg_logprob = sum([s.get("avg_logprob", -1.0) for s in segments]) / max(len(segments), 1)
            stability_score = max(0, min(1, (avg_logprob + 1.2) / 1.2))
            
            # 2. Silence/Uncertainty Rate (no_speech_prob)
            # High no_speech_prob usually means the person is trailing off or pausing awkwardly
            avg_no_speech = sum([s.get("no_speech_prob", 0.0) for s in segments]) / max(len(segments), 1)
            fluency_score = 1.0 - avg_no_speech
            
            # 3. WPM Score (Speech Tempo)
            words = text.split()
            duration = sum([s["end"] - s["start"] for s in segments])
            wpm = (len(words) / duration * 60) if duration > 0.5 else 145
            # Target 145, penalty outside 120-170
            wpm_score = 1.0 - (abs(145 - wpm) / 100)
            
            # Final Confidence - Day 14 Enhanced Formula
            # 40% AI Certainty, 30% Fluency (Silences), 30% Tempo (WPM)
            final_conf = (stability_score * 0.4) + (fluency_score * 0.3) + (wpm_score * 0.3)
            # Filter words penalty still applies
            fillers = ["um", "uh", "ah", "like", "actually", "basically"]
            filler_count = sum([1 for w in words if w.lower().strip(",.") in fillers])
            final_conf = final_conf * max(0.6, 1.0 - (filler_count * 0.1))
            
            rooms[room_id].confidence_scores[username] = round(final_conf * 100, 1)

            print(f"[Day 14] {username} Neural Confidence: {rooms[room_id].confidence_scores[username]}% (Mood: {sentiment_score:.2f})")
# --- end of day 14 ---
            
            return {"status": "success", "transcript": transcript_entry}
    except FileNotFoundError:
        error_msg = "Transcription failed: FFmpeg not found on system. Please install FFmpeg."
        print(error_msg)
        return {"error": error_msg}
    except Exception as e:
        error_msg = f"Transcription error: {str(e)}"
        print(error_msg)
        return {"error": error_msg}
        
    return {"status": "uploaded"}

@app.get("/api/rooms/{room_id}/transcript")
async def get_transcript(room_id: str):
    if room_id in rooms:
        return {"transcripts": rooms[room_id].transcripts}
    return {"error": "Not found"}

@app.post("/api/rooms/settings")
async def update_settings(request: Request):
    data = await request.json()
    room_id = data.get("room_id")
    if room_id in rooms:
        rooms[room_id].settings.update(data.get("settings", {}))
        return rooms[room_id]
    return {"error": "Not found"}
