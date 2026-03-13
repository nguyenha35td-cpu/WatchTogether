const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// ==================== File Upload ====================

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve uploaded files as static assets
app.use("/uploads", express.static(uploadsDir, {
  setHeaders: (res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Accept-Ranges", "bytes");
  },
}));

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  },
});

// Allowed video extensions (browsers may not set correct MIME for mkv/avi)
const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".webm", ".ogg", ".ogv", ".mov",
  ".mkv", ".avi", ".wmv", ".flv", ".m4v",
  ".ts", ".mts", ".3gp", ".rmvb", ".rm",
]);

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 * 1024 }, // 8GB max
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith("video/") || VIDEO_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error("不支持的视频格式"));
    }
  },
});

// Video upload endpoint
app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "没有上传文件" });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({
    url: fileUrl,
    filename: req.file.originalname,
    size: req.file.size,
  });
});

// Error handler for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "文件大小超过 8GB 限制" });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ==================== Room Management ====================

/**
 * rooms Map structure:
 * roomId -> {
 *   id: string,
 *   hostId: string,
 *   participants: Map<clientId, { id, name, isHost, ws }>,
 *   playlist: VideoItem[],
 *   currentVideoId: string | null,
 *   playbackState: { isPlaying: boolean, currentTime: number, lastUpdate: number }
 * }
 */
const rooms = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "WT-";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function generateUserId() {
  return uuidv4().substring(0, 8);
}

function getRoomInfo(room) {
  const participants = [];
  room.participants.forEach((p) => {
    participants.push({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      isConnected: true,
    });
  });
  return {
    id: room.id,
    hostId: room.hostId,
    participants,
    playlist: room.playlist,
    currentVideoId: room.currentVideoId,
    playbackState: room.playbackState,
  };
}

function broadcastToRoom(roomId, message, excludeClientId = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  const data = JSON.stringify(message);
  room.participants.forEach((participant) => {
    if (participant.id !== excludeClientId && participant.ws.readyState === 1) {
      participant.ws.send(data);
    }
  });
}

function sendToClient(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

// ==================== REST API ====================

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", rooms: rooms.size });
});

// Check if room exists
app.get("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (room) {
    res.json({ exists: true, participantCount: room.participants.size });
  } else {
    res.json({ exists: false });
  }
});

// ==================== WebSocket Handler ====================

wss.on("connection", (ws) => {
  let clientId = null;
  let currentRoomId = null;

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, payload } = message;

    switch (type) {
      // ---- Room Operations ----
      case "create_room": {
        const { userName, playlist } = payload;
        const roomId = generateRoomCode();
        clientId = generateUserId();

        const room = {
          id: roomId,
          hostId: clientId,
          participants: new Map(),
          playlist: playlist || [],
          currentVideoId: null,
          playbackState: {
            isPlaying: false,
            currentTime: 0,
            lastUpdate: Date.now(),
          },
        };

        room.participants.set(clientId, {
          id: clientId,
          name: userName || "匿名用户",
          isHost: true,
          ws,
        });

        rooms.set(roomId, room);
        currentRoomId = roomId;

        sendToClient(ws, {
          type: "room_created",
          payload: {
            roomId,
            clientId,
            room: getRoomInfo(room),
          },
        });

        console.log(`[Room] Created: ${roomId} by ${userName} (${clientId})`);
        break;
      }

      case "join_room": {
        const { roomId, userName } = payload;
        const room = rooms.get(roomId);

        if (!room) {
          sendToClient(ws, {
            type: "error",
            payload: { message: "房间不存在" },
          });
          return;
        }

        clientId = generateUserId();
        currentRoomId = roomId;

        room.participants.set(clientId, {
          id: clientId,
          name: userName || "匿名用户",
          isHost: false,
          ws,
        });

        // Send room state to the new participant
        sendToClient(ws, {
          type: "room_joined",
          payload: {
            roomId,
            clientId,
            room: getRoomInfo(room),
          },
        });

        // Notify others
        broadcastToRoom(
          roomId,
          {
            type: "participant_joined",
            payload: {
              participant: {
                id: clientId,
                name: userName || "匿名用户",
                isHost: false,
                isConnected: true,
              },
              participants: getRoomInfo(room).participants,
            },
          },
          clientId
        );

        console.log(`[Room] ${userName} (${clientId}) joined ${roomId}`);
        break;
      }

      case "leave_room": {
        handleLeaveRoom();
        break;
      }

      // ---- Playlist Operations ----
      case "playlist_add": {
        const room = rooms.get(currentRoomId);
        if (!room) return;

        const { video } = payload;
        room.playlist.push(video);

        broadcastToRoom(currentRoomId, {
          type: "playlist_updated",
          payload: { playlist: room.playlist },
        });
        break;
      }

      case "playlist_remove": {
        const room2 = rooms.get(currentRoomId);
        if (!room2) return;

        const { videoId } = payload;
        room2.playlist = room2.playlist.filter((v) => v.id !== videoId);

        if (room2.currentVideoId === videoId) {
          room2.currentVideoId = null;
          room2.playbackState = {
            isPlaying: false,
            currentTime: 0,
            lastUpdate: Date.now(),
          };
        }

        broadcastToRoom(currentRoomId, {
          type: "playlist_updated",
          payload: {
            playlist: room2.playlist,
            currentVideoId: room2.currentVideoId,
          },
        });
        break;
      }

      // ---- Playback Sync ----
      case "select_video": {
        const room3 = rooms.get(currentRoomId);
        if (!room3) return;

        room3.currentVideoId = payload.videoId;
        room3.playbackState = {
          isPlaying: false,
          currentTime: 0,
          lastUpdate: Date.now(),
        };

        broadcastToRoom(
          currentRoomId,
          {
            type: "video_changed",
            payload: {
              videoId: payload.videoId,
              playbackState: room3.playbackState,
            },
          },
          clientId
        );
        break;
      }

      case "play": {
        const room4 = rooms.get(currentRoomId);
        if (!room4) return;

        room4.playbackState.isPlaying = true;
        room4.playbackState.currentTime = payload.currentTime;
        room4.playbackState.lastUpdate = Date.now();

        broadcastToRoom(
          currentRoomId,
          {
            type: "sync_play",
            payload: {
              currentTime: payload.currentTime,
              timestamp: Date.now(),
            },
          },
          clientId
        );
        break;
      }

      case "pause": {
        const room5 = rooms.get(currentRoomId);
        if (!room5) return;

        room5.playbackState.isPlaying = false;
        room5.playbackState.currentTime = payload.currentTime;
        room5.playbackState.lastUpdate = Date.now();

        broadcastToRoom(
          currentRoomId,
          {
            type: "sync_pause",
            payload: {
              currentTime: payload.currentTime,
              timestamp: Date.now(),
            },
          },
          clientId
        );
        break;
      }

      case "seek": {
        const room6 = rooms.get(currentRoomId);
        if (!room6) return;

        room6.playbackState.currentTime = payload.currentTime;
        room6.playbackState.lastUpdate = Date.now();

        broadcastToRoom(
          currentRoomId,
          {
            type: "sync_seek",
            payload: {
              currentTime: payload.currentTime,
              timestamp: Date.now(),
            },
          },
          clientId
        );
        break;
      }

      case "request_sync": {
        const room7 = rooms.get(currentRoomId);
        if (!room7) return;

        sendToClient(ws, {
          type: "sync_state",
          payload: {
            currentVideoId: room7.currentVideoId,
            playbackState: room7.playbackState,
            playlist: room7.playlist,
          },
        });
        break;
      }

      default:
        console.log(`[WS] Unknown message type: ${type}`);
    }
  });

  function handleLeaveRoom() {
    if (!currentRoomId || !clientId) return;

    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.participants.delete(clientId);

    if (room.participants.size === 0) {
      // Room is empty, clean it up
      rooms.delete(currentRoomId);
      console.log(`[Room] Deleted empty room: ${currentRoomId}`);
    } else {
      // If host left, transfer host to another participant
      if (room.hostId === clientId) {
        const newHost = room.participants.values().next().value;
        if (newHost) {
          newHost.isHost = true;
          room.hostId = newHost.id;
        }
      }

      // Notify remaining participants
      broadcastToRoom(currentRoomId, {
        type: "participant_left",
        payload: {
          clientId,
          participants: getRoomInfo(room).participants,
          newHostId: room.hostId,
        },
      });
    }

    console.log(`[Room] ${clientId} left ${currentRoomId}`);
    currentRoomId = null;
    clientId = null;
  }

  ws.on("close", () => {
    handleLeaveRoom();
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error:`, err.message);
    handleLeaveRoom();
  });
});

// ==================== Start Server ====================

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 WatchTogether Server running on port ${PORT}`);
  console.log(`   HTTP: http://localhost:${PORT}`);
  console.log(`   WS:   ws://localhost:${PORT}`);
});
