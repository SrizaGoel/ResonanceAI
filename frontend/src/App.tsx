import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Play, LogIn, AlertCircle, Users, Settings as SettingsIcon, Shield, Activity, Copy, CheckCircle, LogOut, Mic, MicOff, Volume2, VolumeX, Eye, EyeOff } from 'lucide-react';
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import './index.css';
import './room.css';

const API_BASE_URL = 'https://artisticme-resonanceai-backend.hf.space/api/rooms';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

// --- Types ---
interface RoomSettings {
  auto_analyze: boolean;
  confidential: boolean;
  live_analytics: boolean;
  data_persistence: boolean;
  analysis_type: string;
}

interface RoomData {
  id: string;
  host: string;
  participants: string[];
  consent_status: { [key: string]: boolean };
  settings: RoomSettings;
  created_at: string;
  is_active: boolean;
  last_speaker?: string | null;
  transcripts: Array<{ user: string; text: string; timestamp: string }>;
  talk_times: { [key: string]: number };
  intelligence?: {
    metrics: {
      [user: string]: {
        talk_time: number;
        turns: number;
        dominance_score: number;
        talk_percentage: number;
      }
    };
    silent_users: string[];
    total_meeting_time: number;
    total_talk_time: number;
    total_turns: number;
    latest_emotions: Record<string, number>;
    confidence_scores: Record<string, number>;
    emotion_trend: Array<{ user: string; sentiment: number; timestamp: string }>;
  };
}

// --- Main App Component ---
function App() {
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<string>(sessionStorage.getItem('currentUser') || '');
  const [room, setRoom] = useState<RoomData | null>(null);
  const [hasConsented, setHasConsented] = useState<boolean>(false);

  // --- Landing Page State ---
  const [name, setName] = useState('');
  const [roomIdToJoin, setRoomIdToJoin] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [autoStart, setAutoStart] = useState(true);
  const [isConfidential, setIsConfidential] = useState(false);

  // --- Room Page State ---
  const [copied, setCopied] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<{ [key: string]: MediaStream }>({});
  const peers = React.useRef<{ [key: string]: RTCPeerConnection }>({});
  const localStreamRef = React.useRef<MediaStream | null>(null);
  const pendingCandidates = React.useRef<{ [key: string]: RTCIceCandidateInit[] }>({});
  const wsRef = React.useRef<WebSocket | null>(null);
  const [transcripts, setTranscripts] = useState<Array<{ user: string; text: string; timestamp: string }>>([]);
  const mediaRecorder = React.useRef<MediaRecorder | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isEngaged, setIsEngaged] = useState(true);
  const [engagementStatuses, setEngagementStatuses] = useState<{ [key: string]: boolean }>({});
  const [engagementHistory, setEngagementHistory] = useState<{ [key: string]: Array<{ timestamp: number, isEngaged: boolean }> }>({});
  const [micStatuses, setMicStatuses] = useState<{ [key: string]: boolean }>({});
  const faceLandmarker = React.useRef<FaceLandmarker | null>(null);
  const [showDashboard, setShowDashboard] = useState(false);
  const [isMicOn, setIsMicOn] = useState(true);
  const [mutedRemoteUsers, setMutedRemoteUsers] = useState<{ [key: string]: boolean }>({});

  // --- API Services ---
  const roomService = {
    createRoom: async (host: string, settings?: any) => {
      const response = await axios.post('https://artisticme-resonanceai-backend.hf.space/create-meeting', { host, settings });
      return response.data;
    },
    joinRoom: async (roomId: string, username: string) => {
      const response = await api.post('/join', { room_id: roomId, username });
      return response.data;
    },
    getRoom: async (roomId: string) => {
      const response = await api.get(`/${roomId}?t=${Date.now()}`);
      return response.data;
    },
    updateSettings: async (roomId: string, settings: any) => {
      const response = await api.post('/settings', { room_id: roomId, settings });
      return response.data;
    },
    updateConsent: async (roomId: string, username: string, consent: boolean) => {
      const response = await api.post(`/${roomId}/consent`, { username, consent });
      return response.data;
    },
    uploadAudio: async (roomId: string, username: string, blob: Blob) => {
      const formData = new FormData();
      formData.append('file', blob);
      const response = await axios.post(`https://artisticme-resonanceai-backend.hf.space/api/rooms/${roomId}/upload?username=${username}`, formData);
      return response.data;
    },
    getTranscript: async (roomId: string) => {
      try {
        const response = await axios.get(`https://artisticme-resonanceai-backend.hf.space/api/rooms/${roomId}/transcript?t=${Date.now()}`);
        return response.data.transcripts || [];
      } catch (err) {
        console.error("Transcript fetch error:", err);
        return [];
      }
    },
    sendSignal: async (roomId: string, sender: string, target: string, signal: any) => {
      // Use WebSocket if available (fast), fall back to HTTP
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ sender, target, signal }));
      } else {
        await axios.post(`https://artisticme-resonanceai-backend.hf.space/api/rooms/${roomId}/signal`, { sender, target, signal });
      }
    },
    getSignals: async (roomId: string, username: string) => {
      const response = await axios.get(`https://artisticme-resonanceai-backend.hf.space/api/rooms/${roomId}/signal/${username}?t=${Date.now()}`);
      return response.data.signals;
    }
  };

  // --- Room Polling ---
  useEffect(() => {
    if (!currentRoomId) return;
    let errorCount = 0;
    const fetchRoom = async () => {
      try {
        const data = await roomService.getRoom(currentRoomId);
        if (data.error) {
          errorCount++;
          // Only redirect after 3+ consecutive failures to avoid false triggers from network blips
          if (errorCount >= 3) {
            setError('Session expired. The room no longer exists — please create a new room.');
            setCurrentRoomId(null);
            setRoom(null);
          }
          return;
        }
        errorCount = 0; // Reset on success
        setRoom(data);
        if (data.consent_status[currentUser]) {
          setHasConsented(true);
        }
      } catch (err) {
        errorCount++;
        if (errorCount >= 5) setError('Connection lost. Please refresh the page.');
      }
    };
    fetchRoom();
    const intervalId = setInterval(fetchRoom, 5000);
    // Keep HuggingFace Space awake (free tier sleeps after ~15min of inactivity)
    const keepAlive = setInterval(async () => {
      try { await axios.get('https://artisticme-resonanceai-backend.hf.space/?keepalive=1'); } catch (_) { }
    }, 4 * 60 * 1000); // every 4 minutes
    return () => { clearInterval(intervalId); clearInterval(keepAlive); };
  }, [currentRoomId, currentUser]);

  // --- WebRTC Logic (WebSocket Signaling) ---
  useEffect(() => {
    if (!hasConsented || !currentRoomId || !currentUser) return;

    // 1. Get camera/mic
    const startMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false }
        });
        setLocalStream(stream);
        localStreamRef.current = stream;
      } catch (err) {
        console.error("Media access failed", err);
      }
    };
    startMedia();

    // 2. Connect WebSocket for instant signaling
    const wsUrl = `wss://artisticme-resonanceai-backend.hf.space/ws/${currentRoomId}/${currentUser}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    console.log('[WS] Connecting to', wsUrl);

    const handleSignal = async (sender: string, signal: any) => {
      if (signal.type === 'engagement') {
        setEngagementStatuses(prev => {
          if (prev[sender] !== signal.isEngaged) {
            setEngagementHistory(hist => ({
              ...hist,
              [sender]: [...(hist[sender] || []), { timestamp: Date.now(), isEngaged: signal.isEngaged }]
            }));
          }
          return { ...prev, [sender]: signal.isEngaged };
        });
        return;
      }
      if (signal.type === 'micStatus') {
        setMicStatuses(prev => ({ ...prev, [sender]: signal.isMicOn }));
        return;
      }

      // WebRTC signal
      if (!peers.current[sender]) {
        peers.current[sender] = createPeerConnection(sender);
      }
      const pc = peers.current[sender];

      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        // Flush buffered candidates
        for (const c of (pendingCandidates.current[sender] || [])) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => { });
        }
        pendingCandidates.current[sender] = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        // Use WebSocket if open, otherwise fall back to HTTP
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ sender: currentUser, target: sender, signal: answer }));
        } else {
          await roomService.sendSignal(currentRoomId, currentUser, sender, answer);
        }
      } else if (signal.type === 'answer' && pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal)).catch(() => { });
        for (const c of (pendingCandidates.current[sender] || [])) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => { });
        }
        pendingCandidates.current[sender] = [];
      } else if (signal.candidate) {
        if (!pc.remoteDescription) {
          pendingCandidates.current[sender] = [...(pendingCandidates.current[sender] || []), signal];
        } else {
          await pc.addIceCandidate(new RTCIceCandidate(signal)).catch(() => { });
        }
      }
    };

    ws.onmessage = (event) => {
      const { sender, signal } = JSON.parse(event.data);
      handleSignal(sender, signal);
    };
    ws.onopen = () => console.log('[WS] Connected!');
    ws.onerror = (e) => console.warn('[WS] Error:', e);
    ws.onclose = () => console.warn('[WS] Closed - falling back to HTTP polling');

    // HTTP polling fallback for when WebSocket is unavailable
    const httpFallbackInterval = setInterval(async () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return; // WS working, skip
      try {
        const signals = await roomService.getSignals(currentRoomId, currentUser);
        signals.forEach(async (s: any) => handleSignal(s.sender, s.signal));
      } catch (_) { }
    }, 2000);

    return () => {
      ws.close();
      wsRef.current = null;
      clearInterval(httpFallbackInterval);
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, [hasConsented, currentRoomId, currentUser]);

  const createPeerConnection = (targetUser: string) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
      ]
    });
    pc.onicecandidate = (e) => {
      if (e.candidate) roomService.sendSignal(currentRoomId!, currentUser, targetUser, e.candidate);
    };
    pc.ontrack = (e) => {
      setRemoteStreams(prev => ({ ...prev, [targetUser]: e.streams[0] }));
    };
    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] ${targetUser}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        console.warn(`[WebRTC] Connection to ${targetUser} lost. Cleaning up for reconnect...`);
        pc.close();
        delete peers.current[targetUser];
        delete pendingCandidates.current[targetUser];
        setRemoteStreams(prev => { const next = { ...prev }; delete next[targetUser]; return next; });
      }
    };
    // Use ref to always get the latest stream (fixes stale closure bug)
    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
    }
    return pc;
  };

  useEffect(() => {
    if (room && localStream && hasConsented) {
      // Broadcast initial states to existing participants
      room.participants.forEach(p => {
        if (p !== currentUser) {
          roomService.sendSignal(currentRoomId!, currentUser, p, { type: 'micStatus', isMicOn: isMicOn });
          roomService.sendSignal(currentRoomId!, currentUser, p, { type: 'engagement', isEngaged: isEngaged });
        }
      });

      room.participants.forEach(p => {
        if (p !== currentUser && !peers.current[p]) {
          const pc = createPeerConnection(p);
          peers.current[p] = pc;
          // Only the alphabetically-greater user sends the initial offer (prevents glare)
          if (currentUser > p) {
            pc.createOffer().then(offer => {
              pc.setLocalDescription(offer);
              roomService.sendSignal(currentRoomId!, currentUser, p, offer);
            });
          }
          // The other side creates PC and waits for the incoming offer via signaling interval
        }
      });
    }
  }, [room?.participants, localStream]);

  // --- DAY 8: Visual Engagement Tracking (MediaPipe) ---
  useEffect(() => {
    if (!hasConsented || !localStream || !currentRoomId || !currentUser) return;

    let active = true;
    const initLandmarker = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );
        faceLandmarker.current = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numFaces: 1
        });
        console.log("MediaPipe FaceLandmarker Ready");
      } catch (err) {
        console.error("MediaPipe initialization failed", err);
      }
    };

    initLandmarker();

    const videoElement = document.createElement('video');
    videoElement.srcObject = localStream;
    videoElement.play();

    let lastStatus = true;
    const checkEngagement = () => {
      if (!active) return;
      if (faceLandmarker.current && videoElement.readyState === 4) {
        const result = faceLandmarker.current.detectForVideo(videoElement, performance.now());
        const engaged = (result.faceLandmarks || []).length > 0;

        if (engaged !== lastStatus) {
          setIsEngaged(engaged);
          setEngagementHistory(hist => ({
            ...hist,
            [currentUser]: [...(hist[currentUser] || []), { timestamp: Date.now(), isEngaged: engaged }]
          }));
          lastStatus = engaged;
          // Broadcast engagement status to others
          room?.participants.forEach(p => {
            if (p !== currentUser) {
              roomService.sendSignal(currentRoomId, currentUser, p, { type: 'engagement', isEngaged: engaged });
            }
          });
        }
      }
      // Check every 2s for efficiency
      setTimeout(() => { if (active) requestAnimationFrame(checkEngagement); }, 2000);
    };

    requestAnimationFrame(checkEngagement);

    return () => {
      active = false;
      videoElement.pause();
      videoElement.srcObject = null;
    };
  }, [localStream, hasConsented, currentRoomId]);

  // --- Audio Recording & Polling Logic (Day 15.5 Decoupled) ---
  useEffect(() => {
    if (!hasConsented || !localStream || !currentRoomId || !currentUser || !room) return;

    let transcriptInterval: any = null;

    const startRecording = () => {
      // Day 15.5: Recording now depends on 'auto_analyze' (data capture) 
      // instead of 'live_analytics' (UI visibility)
      if (!room.settings.auto_analyze) return;

      try {
        const recorder = new MediaRecorder(localStream);
        mediaRecorder.current = recorder;
        const chunks: Blob[] = [];

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = async () => {
          if (chunks.length > 0) {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            try {
              setIsTranscribing(true);
              await roomService.uploadAudio(currentRoomId, currentUser, blob);
              setIsTranscribing(false);
            } catch (err) {
              console.error("Audio upload failed", err);
              setIsTranscribing(false);
            }
          }
          // Restart if still active
          if (room.settings.auto_analyze) {
            setTimeout(() => {
              if (room.settings.auto_analyze) startRecording();
            }, 100);
          }
        };

        recorder.start();
        setTimeout(() => {
          if (recorder.state === 'recording') recorder.stop();
        }, 5000);

      } catch (err) {
        console.error("Recording error", err);
      }
    };

    if (room.settings.auto_analyze && (!mediaRecorder.current || mediaRecorder.current.state === 'inactive')) {
      startRecording();
    }

    // Polling for transcripts
    transcriptInterval = setInterval(async () => {
      try {
        const history = await roomService.getTranscript(currentRoomId);
        setTranscripts(history);
      } catch (e) {
        console.warn("Polling error:", e);
      }
    }, 2000);

    return () => {
      if (mediaRecorder.current && mediaRecorder.current.state !== 'inactive') {
        mediaRecorder.current.stop();
      }
      if (transcriptInterval) clearInterval(transcriptInterval);
    };
  }, [hasConsented, localStream, currentRoomId, currentUser, room?.settings.auto_analyze]);

  // --- Handlers ---
  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Please enter your name');
    setIsLoading(true); setError('');
    try {
      const data = await roomService.createRoom(name, {
        live_analytics: autoStart,
        confidential: isConfidential
      });
      if (data.meeting_id) {
        setCurrentUser(name);
        setCurrentRoomId(data.meeting_id);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create room');
    } finally {
      setIsLoading(false);
    }
  };

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Please enter your name');
    if (!roomIdToJoin.trim()) return setError('Please enter a room code');
    setIsLoading(true); setError('');
    try {
      const data = await roomService.joinRoom(roomIdToJoin, name);
      if (data.error) throw new Error(data.error);
      sessionStorage.setItem('currentUser', name);
      setCurrentUser(name);
      setCurrentRoomId(roomIdToJoin);
    } catch (err: any) {
      setError(err.message || 'Failed to join room');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLeaveRoom = () => {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    setCurrentRoomId(null);
    setRoom(null);
    setError('');
  };

  const toggleMute = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMicOn(audioTrack.enabled);

        // Broadcast mic status change
        room?.participants.forEach(p => {
          if (p !== currentUser) {
            roomService.sendSignal(currentRoomId!, currentUser, p, { type: 'micStatus', isMicOn: audioTrack.enabled });
          }
        });
      }
    }
  };

  const toggleRemoteMute = (user: string) => {
    setMutedRemoteUsers(prev => ({ ...prev, [user]: !prev[user] }));
  };

  const copyRoomId = () => {
    if (!room) return;
    navigator.clipboard.writeText(room.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleToggleSetting = async (key: keyof RoomSettings) => {
    if (!currentRoomId || !isHost || isUpdating || !room) return;
    try {
      setIsUpdating(true);
      const newSettings = { ...room.settings };

      if (key === 'auto_analyze') {
        const currentVal = newSettings.auto_analyze;
        newSettings.auto_analyze = !currentVal;
        // Day 17: If turning OFF auto_analyze, also force OFF live_analytics
        if (currentVal) {
          newSettings.live_analytics = false;
        }
      } else {
        const currentVal = newSettings[key] as boolean;
        newSettings[key] = !currentVal as never;
      }

      await roomService.updateSettings(currentRoomId, newSettings);
      setRoom(prev => prev ? { ...prev, settings: newSettings } : null);
    } catch (err) {
      console.error("Failed to update settings", err);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleConsent = async () => {
    if (!currentRoomId || !currentUser) return;
    try {
      await roomService.updateConsent(currentRoomId, currentUser, true);
      setHasConsented(true);
    } catch (err) {
      console.error("Failed to submit consent", err);
    }
  };

  const handleDownloadPDF = () => {
    if (!room) return;
    if (room.settings.confidential) {
      alert("Downloads are disabled in Confidential Mode.");
      return;
    }
    window.print();
  };

  // --- Render logic ---
  if (!currentRoomId) {
    // Render Landing Page
    return (
      <div className="landing-container">
        <div className="landing-content">
          <h1 className="logo"><span className="logo-accent">Resonance</span>AI</h1>
          <p className="tagline">Intelligent insights for your meetings.</p>
          {error && <div className="error-alert"><AlertCircle size={18} /><span>{error}</span></div>}

          <div className="action-cards">
            <div className="card">
              <h2>Start a Meeting</h2>
              <form onSubmit={handleCreateRoom}>
                <div className="form-group">
                  <label>Your Name</label>
                  <input type="text" placeholder="Enter your name" value={name} onChange={(e) => setName(e.target.value)} disabled={isLoading} />
                </div>

                {/* Day 15.5: Premium Meeting Setup Toggles */}
                <div style={{ marginBottom: '1.5rem', padding: '1rem', background: 'rgba(255,255,255,0.03)', borderRadius: '0.75rem', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Activity size={16} style={{ color: 'var(--primary)' }} />
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-main)' }}>Automatic Start Analytics</span>
                    </div>
                    <label className="custom-toggle">
                      <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Shield size={16} style={{ color: 'var(--secondary)' }} />
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-main)' }}>Confidential Mode</span>
                    </div>
                    <label className="custom-toggle">
                      <input type="checkbox" checked={isConfidential} onChange={(e) => setIsConfidential(e.target.checked)} />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>
                </div>

                <button type="submit" className="btn btn-primary" disabled={isLoading || !name.trim()}>
                  <Play size={18} /> Create New Room
                </button>
              </form>
            </div>
            <div className="divider"><span>OR</span></div>
            <div className="card">
              <h2>Join a Meeting</h2>
              <form onSubmit={handleJoinRoom}>
                <div className="form-group">
                  <label>Room Code</label>
                  <input type="text" placeholder="e.g. ABC123" value={roomIdToJoin} onChange={(e) => setRoomIdToJoin(e.target.value)} disabled={isLoading} />
                </div>
                <button type="submit" className="btn btn-secondary" disabled={isLoading || !name.trim() || !roomIdToJoin.trim()}>
                  <LogIn size={18} /> Join Room
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error && !room) {
    return (
      <div className="landing-container">
        <div className="card" style={{ textAlign: 'center' }}>
          <h2 style={{ color: 'var(--error)' }}>Error</h2>
          <p>{error}</p>
          <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={handleLeaveRoom}>Return Home</button>
        </div>
      </div>
    );
  }

  if (!room) return <div className="loading-state">Loading resonance environment...</div>;

  if (!hasConsented) {
    return (
      <div className="consent-overlay">
        <div className="consent-card">
          <div className="consent-header">
            <Shield size={32} color="var(--primary)" />
            <h2>Privacy & Consent</h2>
          </div>
          <div className="consent-body">
            <p>To join <strong>{room.id}</strong>, you must agree to the following:</p>
            <ul>
              <li>Your audio and video will be processed by AI.</li>
              <li>Meeting data may be recorded based on host settings.</li>
              <li>You can leave the room at any time to stop processing.</li>
            </ul>
          </div>
          <div className="consent-footer">
            <button className="btn btn-secondary" onClick={handleLeaveRoom}>Decline</button>
            <button className="btn btn-primary" onClick={handleConsent}>I Agree & Join</button>
          </div>
        </div>
      </div>
    );
  }

  const isHost = room?.host === currentUser;

  return (
    <div className="room-layout">
      <aside className="room-sidebar">
        <div className="room-header-brand"><span className="logo-accent" style={{ fontSize: '1.5rem', fontWeight: 800 }}>Resonance</span>AI</div>
        <div className="room-info-card">
          <div className="room-id-box">
            <span className="label">Room Code</span>
            <div className="id-display" onClick={copyRoomId}>
              {room.id}
              {copied ? <CheckCircle size={16} color="var(--primary)" /> : <Copy size={16} />}
            </div>
          </div>
        </div>
        <div className="sidebar-section">
          <h3><SettingsIcon size={18} /> Meeting Intelligence</h3>
          <div className="settings-list">
            <div className="setting-item">
              <div className="setting-info">
                <span className="setting-title">Auto Analyze</span>
                <span className="setting-desc">Generate AI summaries</span>
              </div>
              <label className={`toggle ${room?.settings?.auto_analyze ? 'active' : ''} ${!isHost ? 'disabled' : ''}`}>
                <input type="checkbox" checked={room?.settings?.auto_analyze} onChange={() => handleToggleSetting('auto_analyze')} disabled={!isHost || isUpdating} />
                <span className="slider"></span>
              </label>
            </div>
            <div className="setting-item">
              <div className="setting-info">
                <Shield size={14} color={room.settings.confidential ? "var(--error)" : "var(--text-muted)"} style={{ marginBottom: 4 }} />
                <span className="setting-title">Confidential Mode</span>
                <span className="setting-desc">Disable data persistence</span>
              </div>
              <label className={`toggle ${room?.settings?.confidential ? 'active' : ''} ${!isHost ? 'disabled' : ''}`}>
                <input type="checkbox" checked={room?.settings?.confidential} onChange={() => handleToggleSetting('confidential')} disabled={!isHost || isUpdating} />
                <span className="slider"></span>
              </label>
            </div>
            <div className="setting-item">
              <div className="setting-info">
                <Activity size={14} color={room.settings.live_analytics ? "var(--primary)" : "var(--text-muted)"} style={{ marginBottom: 4 }} />
                <span className="setting-title">Live Analytics</span>
                <span className="setting-desc">Real-time sentiment</span>
              </div>
              <label className={`toggle ${room?.settings?.live_analytics ? 'active' : ''} ${(!isHost || !room.settings.auto_analyze) ? 'disabled' : ''}`}>
                <input type="checkbox" checked={room?.settings?.live_analytics} onChange={() => handleToggleSetting('live_analytics')} disabled={!isHost || !room.settings.auto_analyze || isUpdating} />
                <span className="slider"></span>
              </label>
            </div>
          </div>
          {!isHost && <div className="host-notice">Only the host ({room.host}) can change settings.</div>}
        </div>
        {isHost && room.settings.live_analytics && (
          <div className="sidebar-section">
            <h3><Activity size={18} /> Speaker Analytics</h3>
            <div className="analytics-list">
              {room.participants.map(p => {
                const talkTime = room.talk_times?.[p] || 0;
                const totalTalkTime = Object.values(room.talk_times || {}).reduce((a, b) => a + b, 0) || 1;
                const percentage = (talkTime / totalTalkTime) * 100;

                return (
                  <div key={`analytics-${p}`} className="analytics-item">
                    <div className="analytics-info">
                      <span className="name">{p}</span>
                      <span className="time">{Math.floor(talkTime / 60)}m {Math.floor(talkTime % 60)}s</span>
                    </div>
                    <div className="progress-bar-bg">
                      <div className="progress-bar-fill" style={{ width: `${percentage}%` }}></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="sidebar-section">
          <h3><Users size={18} /> Participants ({room.participants.length})</h3>
          <ul className="participant-list">
            {room.participants.map(p => {
              const sentiment = room.intelligence?.latest_emotions?.[p] ?? 0;
              const confidence = room.intelligence?.confidence_scores?.[p] ?? 0;
              const isSpeaking = room.last_speaker === p;

              const getSentimentBadge = (score: number) => {
                if (score > 0.1) return <span className="mood-badge mood-positive">Positive</span>;
                if (score < -0.1) return <span className="mood-badge mood-tense">Tense</span>;
                return <span className="mood-badge mood-neutral">Neutral</span>;
              };

              const getConfidenceLabel = (score: number) => {
                if (score > 75) return { label: "High", color: "var(--primary)" };
                if (score < 40) return { label: "Low", color: "var(--error)" };
                return { label: "Mid", color: "var(--secondary)" };
              };

              const conf = getConfidenceLabel(confidence);
              const isMuted = p === currentUser ? !isMicOn : (micStatuses[p] === false);
              const engaged = p === currentUser ? isEngaged : (engagementStatuses[p] ?? true);

              return (
                <li key={p} className={`${p === room.host ? 'host' : ''} ${isSpeaking ? 'speaking-glow' : ''}`}>
                  <div className={`avatar ${isSpeaking ? 'speaking-glow' : ''}`}>{p[0].toUpperCase()}</div>
                  <div className="participant-info">
                    <div className="participant-header">
                      <span className="name">{p} {p === currentUser ? '(You)' : ''} {p === room.host && <span className="badge">Host</span>}</span>
                      <div className="participant-icons">
                        {engaged ? <span title="Engaged"><Eye size={14} color="var(--primary)" /></span> : <span title="Not Engaged"><EyeOff size={14} color="var(--error)" /></span>}
                        {isMuted ? <MicOff size={14} color="var(--error)" /> : (isSpeaking ? <Volume2 size={14} color="var(--primary)" /> : <Mic size={14} color="var(--text-muted)" />)}
                      </div>
                    </div>
                    {isHost && room.settings.live_analytics && (
                      <div className="participant-metrics-row">
                        {getSentimentBadge(sentiment)}
                        <span className="conf-badge" style={{ color: conf.color, display: 'flex', alignItems: 'center' }}>
                          {conf.label} Conf ({confidence.toFixed(0)}%)
                        </span>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {isHost && room.settings.live_analytics && (
            <button className="btn btn-primary" style={{ marginTop: '1rem', background: 'linear-gradient(135deg, var(--primary), var(--secondary))' }} onClick={() => setShowDashboard(true)}>
              <Activity size={18} /> View Insights Dashboard
            </button>
          )}
          {isHost && !room.settings.confidential && (
            <button className="btn btn-secondary" style={{ marginTop: '0.5rem', width: '100%', display: 'flex', justifyContent: 'center', gap: '0.5rem' }} onClick={handleDownloadPDF}>
              <Shield size={16} /> Download PDF Report
            </button>
          )}
        </div>
        <div style={{ marginTop: 'auto', paddingTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <button
            className={`btn ${isMicOn ? 'btn-secondary' : 'btn-primary'}`}
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'center',
              gap: '0.5rem',
              backgroundColor: isMicOn ? 'rgba(255,255,255,0.05)' : 'rgba(239, 68, 68, 0.15)',
              color: isMicOn ? 'var(--text-main)' : 'var(--error)',
              borderColor: isMicOn ? 'rgba(255,255,255,0.1)' : 'var(--error)'
            }}
            onClick={toggleMute}
          >
            {isMicOn ? <Mic size={18} /> : <MicOff size={18} />}
            {isMicOn ? 'Mute Microphone' : 'Unmute Microphone'}
          </button>
          <button className="btn btn-secondary" style={{ width: '100%', backgroundColor: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)', border: 'none' }} onClick={handleLeaveRoom}>
            <LogOut size={18} /> Leave Room
          </button>
        </div>
      </aside>
      <main className="room-main">
        {/* Day 15: Transcripts visible to host only or if NOT in confidential mode (but user said host only) */}
        {isHost && (
          <div className="transcript-panel">
            <div className="transcript-header">
              <Activity size={16} className={isTranscribing ? 'pulse-text' : ''} />
              <span>Live Intelligence {isTranscribing && '(AI Processing...)'}</span>
            </div>
            <div className="transcript-content">
              {(transcripts || []).length === 0 && <div className="empty-message">Listening for audio...</div>}
              {(transcripts || []).slice().reverse().map((t, i) => (
                <div key={i} className="transcript-entry">
                  <span className="timestamp">[{t?.timestamp}]</span>
                  <span className="user">{t?.user}:</span>
                  <span className="text">{t?.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="video-grid">
          <div className={`video-container local ${room?.last_speaker === currentUser ? 'speaking-glow' : ''}`}>
            <video ref={v => { if (v && v.srcObject !== localStream) v.srcObject = localStream }} autoPlay muted playsInline />
            <div className="video-label">You ({currentUser})</div>
            <div className="video-controls-mini">
              <button className={`btn-mute ${!isMicOn ? 'active' : ''}`} onClick={toggleMute}>
                {isMicOn ? <Mic size={16} /> : <MicOff size={16} />}
              </button>
            </div>
          </div>
          {Object.entries(remoteStreams).map(([user, stream]) => (
            <div key={user} className={`video-container ${room?.last_speaker === user ? 'speaking-glow' : ''}`}>
              <video ref={v => { if (v && v.srcObject !== stream) v.srcObject = stream }} autoPlay playsInline muted={mutedRemoteUsers[user] || false} />
              <div className="video-label">{user}</div>
              <div className="video-controls-mini">
                <button className={`btn-mute ${mutedRemoteUsers[user] ? 'active' : ''}`} onClick={() => toggleRemoteMute(user)}>
                  {!mutedRemoteUsers[user] ? <Volume2 size={16} /> : <VolumeX size={16} />}
                </button>
              </div>
            </div>
          ))}
          {room?.participants?.filter(p => p !== currentUser && !remoteStreams[p]).map(p => (
            <div key={p} className={`video-container placeholder ${room?.last_speaker === p ? 'speaking-glow' : ''}`}>
              <div className="avatar-large">{p.charAt(0).toUpperCase()}</div>
              <div className="video-label">{p} (Connecting...)</div>
            </div>
          ))}
        </div>

        {/* Day 9 Layout Swap: Moved Room ID/Status to Bottom-Right Status Card */}
        <div className="room-status-card">
          <div className={`recording-indicator ${room?.settings?.auto_analyze ? 'active' : ''}`}>
            <div className="dot"></div>
            <span>{room?.settings?.auto_analyze ? 'Live AI Analysis' : 'Session Private'}</span>
          </div>
          <div className="status-room-id">
            <span className="label">Room ID</span>
            <code onClick={copyRoomId}>{room.id}</code>
          </div>
        </div>
      </main>

      {/* --- Day 11: Insights Dashboard Modal --- */}
      {showDashboard && room && room.intelligence && (
        <div className="dashboard-overlay" onClick={() => setShowDashboard(false)}>
          <div className="dashboard-content" onClick={e => e.stopPropagation()}>
            <div className="dashboard-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <h2><Activity size={24} color="var(--primary)" /> Meeting Insights</h2>
                <button className="btn-download" onClick={handleDownloadPDF}>
                  <Shield size={16} /> Download PDF Report
                </button>
              </div>
              <button className="close-btn" onClick={() => setShowDashboard(false)}>&times;</button>
            </div>

            <div className="dashboard-grid">
              {/* Talk Time Pie Chart */}
              <div className="dashboard-card chart-card">
                <h3>Talk Time Distribution (%)</h3>
                <div className="chart-container">
                  <svg viewBox="0 0 100 100" className="pie-chart">
                    {(() => {
                      let accumulatedPercent = 0;
                      return Object.entries(room.intelligence.metrics).map(([user, data], i) => {
                        const startPercent = accumulatedPercent;
                        accumulatedPercent += data.talk_percentage;
                        const endPercent = accumulatedPercent;

                        // Handle 100% edge case
                        if (data.talk_percentage >= 100) return <circle cx="50" cy="50" r="40" fill={`var(--primary)`} opacity={0.8} />;

                        const startX = 50 + 40 * Math.cos(2 * Math.PI * (startPercent / 100 - 0.25));
                        const startY = 50 + 40 * Math.sin(2 * Math.PI * (startPercent / 100 - 0.25));
                        const endX = 50 + 40 * Math.cos(2 * Math.PI * (endPercent / 100 - 0.25));
                        const endY = 50 + 40 * Math.sin(2 * Math.PI * (endPercent / 100 - 0.25));
                        const largeArcFlag = data.talk_percentage > 50 ? 1 : 0;

                        const colors = ['#4f46e5', '#2563eb', '#7c3aed', '#db2777', '#059669'];
                        return (
                          <path
                            key={user}
                            d={`M 50 50 L ${startX} ${startY} A 40 40 0 ${largeArcFlag} 1 ${endX} ${endY} Z`}
                            fill={colors[i % colors.length]}
                            opacity={0.8}
                          />
                        );
                      });
                    })()}
                  </svg>
                  <div className="chart-legend">
                    {Object.entries(room.intelligence.metrics).map(([user, data], i) => (
                      <div key={user} className="legend-item">
                        <span className="dot" style={{ background: ['#4f46e5', '#2563eb', '#7c3aed', '#db2777', '#059669'][i % 5] }}></span>
                        <span className="label">{user}: {data.talk_percentage}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Dominance Index Bar Graph */}
              <div className="dashboard-card chart-card">
                <h3>Dominance Index scores</h3>
                <div className="bar-chart-container">
                  {Object.entries(room.intelligence.metrics).map(([user, data]) => (
                    <div key={`bar-${user}`} className="bar-row">
                      <div className="bar-label">{user}</div>
                      <div className="bar-wrapper">
                        <div className="bar-fill" style={{ width: `${data.dominance_score}%` }}>
                          <span className="bar-value">{data.dominance_score.toFixed(1)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="formula-hint">Formula: 60% Talk Time + 40% Turns</p>
              </div>

              {/* Silent Participations */}
              <div className="dashboard-card silent-card">
                <h3>Silent Participations</h3>
                {room.intelligence.silent_users.length > 0 ? (
                  <ul className="silent-list">
                    {room.intelligence.silent_users.map(u => (
                      <li key={u}><AlertCircle size={14} color="var(--error)" /> {u} (Spoke less than 5%)</li>
                    ))}
                  </ul>
                ) : (
                  <p className="success-text"><CheckCircle size={14} /> Everyone contributed significantly!</p>
                )}
              </div>

              {/* Day 12: Emotional Trend Graph */}
              <div className="dashboard-card mood-card" style={{ gridColumn: 'span 2' }}>
                <h3>Emotional atmosphere Trend (Mood Over Time)</h3>
                <div className="trend-container">
                  <svg viewBox="0 0 400 120" className="trend-graph">
                    {/* Horizontal Neutral Line */}
                    <line x1="0" y1="60" x2="400" y2="60" stroke="rgba(255,255,255,0.1)" strokeDasharray="4 4" />

                    {/* Trend Line (Last 20 points) */}
                    {(() => {
                      const trend = room.intelligence.emotion_trend;
                      if (trend.length < 2) return null;

                      const points = trend.map((d, i) => {
                        const x = (i / (trend.length - 1)) * 400;
                        const y = 60 - (d.sentiment * 50); // Map -1..1 to 10..110
                        return `${x},${y}`;
                      }).join(' ');

                      return (
                        <polyline
                          fill="none"
                          stroke="var(--primary)"
                          strokeWidth="2"
                          points={points}
                          className="trend-polyline"
                        />
                      );
                    })()}

                    {/* Dynamic Labels */}
                    <text x="5" y="20" fill="var(--primary)" fontSize="10" opacity="0.6">Positive</text>
                    <text x="5" y="110" fill="var(--error)" fontSize="10" opacity="0.6">Negative</text>
                  </svg>
                </div>
                <p className="formula-hint">Tracks collective sentiment stability and tension shifts.</p>
              </div>

              {/* Engagement Timeline */}
              <div className="dashboard-card timeline-card" style={{ gridColumn: '1 / -1' }}>
                <h3>Engagement Timeline</h3>
                <div className="timeline-container" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
                  {room.participants.map(p => {
                    const history = engagementHistory[p] || [];
                    const currentStatus = p === currentUser ? isEngaged : (engagementStatuses[p] ?? true);
                    const now = Date.now();
                    const startTime = new Date(room.created_at).getTime();
                    const totalDur = Math.max(now - startTime, 1000);

                    const renderTimelineBlocks = () => {
                      if (history.length === 0) {
                        return <div style={{ width: '100%', height: '100%', background: currentStatus ? 'var(--primary)' : 'var(--error)', opacity: 0.8 }}></div>;
                      }

                      let blocks: any[] = [];
                      let lastTime = startTime;
                      let lastStatus = true; // default before join

                      const fullHistory = [...history, { timestamp: now, isEngaged: currentStatus }];

                      fullHistory.forEach((h, i) => {
                        const t = Math.max(startTime, Math.min(now, h.timestamp));
                        const widthPct = ((t - lastTime) / totalDur) * 100;
                        if (widthPct > 0) {
                          blocks.push(<div key={i} style={{ width: `${widthPct}%`, height: '100%', background: lastStatus ? 'var(--primary)' : 'var(--error)', opacity: 0.8 }} title={lastStatus ? 'Engaged' : 'Not Engaged'}></div>);
                        }
                        lastTime = t;
                        lastStatus = h.isEngaged;
                      });
                      return blocks;
                    };

                    return (
                      <div key={p} className="timeline-row" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <span style={{ width: 100, fontSize: '0.85rem', color: '#fff', fontWeight: 500 }}>{p}</span>
                        <div className="timeline-track" style={{ flex: 1, height: 16, background: 'rgba(255,255,255,0.05)', borderRadius: 8, display: 'flex', overflow: 'hidden' }}>
                          {renderTimelineBlocks()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Day 17: Printable PDF Report Container */}
      {room && (
        <div className="print-report-container">
          <div className="report-header">
            <h1>ResonanceAI Meeting Intelligence Report</h1>
            <p style={{ color: '#64748b' }}>Generated on {new Date().toLocaleString()} | ID: {room.id}</p>
          </div>

          <div className="report-grid">
            <div className="report-card">
              <h3>Total Duration</h3>
              <div className="value">{Math.floor((room.intelligence?.total_meeting_time || 0) / 60)}m {(room.intelligence?.total_meeting_time || 0) % 60}s</div>
            </div>
            <div className="report-card">
              <h3>Meeting Host</h3>
              <div className="value">{room.host}</div>
            </div>
            <div className="report-card">
              <h3>Total Turns</h3>
              <div className="value">{room.intelligence?.total_turns || 0}</div>
            </div>
            <div className="report-card">
              <h3>Dominance Summary</h3>
              <div className="value">{Object.keys(room.intelligence?.metrics || {}).length} Participants</div>
            </div>
          </div>

          <h2>Participant Analysis</h2>
          <table>
            <thead>
              <tr>
                <th>Participant</th>
                <th>Airtime (%)</th>
                <th>Turns</th>
                <th>DominanceScore</th>
                <th>Avg Sentiment</th>
                <th>Avg Confidence</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(room.intelligence?.metrics || {}).map(([user, data]) => {
                const sentiment = room.intelligence?.latest_emotions?.[user] ?? 0;
                const confidence = room.intelligence?.confidence_scores?.[user] ?? 0;
                return (
                  <tr key={user}>
                    <td>{user} {user === room.host ? '(Host)' : ''}</td>
                    <td>{data.talk_percentage.toFixed(1)}%</td>
                    <td>{data.turns}</td>
                    <td>{data.dominance_score.toFixed(2)}</td>
                    <td>
                      <span className={`metric-badge ${sentiment > 0.1 ? 'positive' : sentiment < -0.1 ? 'tense' : 'neutral'}`}>
                        {sentiment > 0.1 ? 'Positive' : sentiment < -0.1 ? 'Tense' : 'Neutral'}
                      </span>
                    </td>
                    <td>{confidence.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {room.intelligence?.silent_users?.length !== 0 && (
            <div style={{ padding: '1rem', background: '#fff1f2', border: '1px solid #fecaca', borderRadius: '0.5rem', marginBottom: '1.5rem', color: '#991b1b' }}>
              <strong>Silent Participant Alert:</strong> {room.intelligence?.silent_users?.join(', ')} showed very low engagement during the session.
            </div>
          )}

          <h2>Meeting Timeline</h2>
          <div className="report-timeline">
            {transcripts.map((t, idx) => (
              <div key={idx} className="timeline-item">
                <div className="timeline-user">
                  {t.user} <span className="timeline-time">{t.timestamp}</span>
                </div>
                <div className="timeline-text">{t.text}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: '3rem', fontSize: '0.75rem', color: '#94a3b8', textAlign: 'center', borderTop: '1px solid #e2e8f0', paddingTop: '1rem' }}>
            Report generated by ResonanceAI Intelligence Suite. Confidential & Internal Use Only.
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
