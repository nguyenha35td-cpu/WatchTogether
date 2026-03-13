const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

// Get ffmpeg/ffprobe binary paths from npm packages (works on any platform)
let ffmpegPath = "ffmpeg";
let ffprobePath = "ffprobe";
const ffmpegErrors = [];

// Strategy 1: @ffmpeg-installer packages
try {
  ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
  console.log("[FFmpeg] @ffmpeg-installer/ffmpeg path:", ffmpegPath);
} catch (e) {
  ffmpegErrors.push("@ffmpeg-installer/ffmpeg: " + e.message);
}
try {
  ffprobePath = require("@ffprobe-installer/ffprobe").path;
  console.log("[FFmpeg] @ffprobe-installer/ffprobe path:", ffprobePath);
} catch (e) {
  ffmpegErrors.push("@ffprobe-installer/ffprobe: " + e.message);
}

// Strategy 2: ffmpeg-static / ffprobe-static (fallback)
if (ffmpegPath === "ffmpeg") {
  try {
    ffmpegPath = require("ffmpeg-static");
    console.log("[FFmpeg] ffmpeg-static path:", ffmpegPath);
  } catch (e) {
    ffmpegErrors.push("ffmpeg-static: " + e.message);
  }
}
if (ffprobePath === "ffprobe") {
  try {
    const ffprobeStatic = require("ffprobe-static");
    ffprobePath = ffprobeStatic.path || ffprobeStatic;
    console.log("[FFmpeg] ffprobe-static path:", ffprobePath);
  } catch (e) {
    ffmpegErrors.push("ffprobe-static: " + e.message);
  }
}

// Strategy 3: Check if binary files actually exist
if (ffmpegPath !== "ffmpeg" && !fs.existsSync(ffmpegPath)) {
  ffmpegErrors.push("ffmpeg binary not found at: " + ffmpegPath);
  ffmpegPath = "ffmpeg";
}
if (ffprobePath !== "ffprobe" && !fs.existsSync(ffprobePath)) {
  ffmpegErrors.push("ffprobe binary not found at: " + ffprobePath);
  ffprobePath = "ffprobe";
}

console.log("[FFmpeg] Final paths - ffmpeg:", ffmpegPath, "ffprobe:", ffprobePath);
if (ffmpegErrors.length > 0) {
  console.log("[FFmpeg] Errors encountered:", ffmpegErrors);
}

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

// ==================== File Cleanup ====================

// Delete a single uploaded file and its associated subtitle cache files
function deleteUploadFile(filename) {
  const filePath = path.join(uploadsDir, filename);
  fs.unlink(filePath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error(`[Cleanup] Failed to delete ${filename}:`, err.message);
    } else if (!err) {
      console.log(`[Cleanup] Deleted file: ${filename}`);
    }
  });

  // Also clean up any extracted subtitle VTT files for this video
  const baseName = path.parse(filename).name;
  fs.readdir(subtitlesDir, (err, files) => {
    if (err) return;
    for (const f of files) {
      if (f.startsWith(baseName + "_sub")) {
        const subPath = path.join(subtitlesDir, f);
        fs.unlink(subPath, () => {});
        console.log(`[Cleanup] Deleted subtitle cache: ${f}`);
      }
    }
  });
}

// Extract filename from a video URL like "/uploads/1234-5678.mp4"
function extractFilename(videoSrc) {
  if (!videoSrc) return null;
  const match = videoSrc.match(/\/uploads\/([^/?#]+)/);
  return match ? match[1] : null;
}

// Delete all uploaded files associated with a room's playlist
function cleanupRoomFiles(room) {
  if (!room || !room.playlist) return;
  let count = 0;
  for (const video of room.playlist) {
    const filename = extractFilename(video.src);
    if (filename) {
      deleteUploadFile(filename);
      count++;
    }
  }
  if (count > 0) {
    console.log(`[Cleanup] Cleaned ${count} file(s) for room ${room.id}`);
  }
}

// Periodic cleanup: delete files older than 24 hours
const FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // run every 1 hour

function periodicCleanup() {
  fs.readdir(uploadsDir, (err, files) => {
    if (err) {
      console.error("[Cleanup] Failed to read uploads dir:", err.message);
      return;
    }
    const now = Date.now();
    let deleted = 0;

    // Collect all filenames currently referenced by active rooms
    const activeFiles = new Set();
    rooms.forEach((room) => {
      for (const video of room.playlist) {
        const filename = extractFilename(video.src);
        if (filename) activeFiles.add(filename);
      }
    });

    for (const file of files) {
      // Skip files still in use by active rooms
      if (activeFiles.has(file)) continue;

      const filePath = path.join(uploadsDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > FILE_MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          deleted++;
          console.log(`[Cleanup] Expired file deleted: ${file}`);
        }
      } catch (e) {
        // ignore
      }
    }
    if (deleted > 0) {
      console.log(`[Cleanup] Periodic cleanup removed ${deleted} expired file(s)`);
    }
  });
}

// Start periodic cleanup timer
setInterval(periodicCleanup, CLEANUP_INTERVAL_MS);
// Also run once on startup to clean leftovers from previous runs
setTimeout(periodicCleanup, 5000);

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

// ==================== Subtitle APIs ====================

// Ensure subtitles directory exists
const subtitlesDir = path.join(__dirname, "subtitles");
if (!fs.existsSync(subtitlesDir)) {
  fs.mkdirSync(subtitlesDir, { recursive: true });
}

// Serve subtitle files as static assets
app.use("/subtitles", express.static(subtitlesDir, {
  setHeaders: (res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Type", "text/vtt; charset=utf-8");
  },
}));

// Helper: run ffprobe to get subtitle track info from a video file
function probeSubtitles(filePath) {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-select_streams", "s",  // only subtitle streams
      filePath,
    ], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        // ffprobe not available or file has no subtitle streams
        console.error("[Subtitle] ffprobe error:", err.message);
        return resolve([]);
      }
      try {
        const data = JSON.parse(stdout);
        const streams = (data.streams || []).map((s, idx) => ({
          index: s.index,
          streamIndex: idx,
          codec: s.codec_name,               // e.g. "ass", "srt", "subrip", "hdmv_pgs_subtitle"
          language: s.tags?.language || "",    // e.g. "chi", "eng", "jpn"
          title: s.tags?.title || "",          // e.g. "简体中文", "English"
        }));
        resolve(streams);
      } catch (parseErr) {
        console.error("[Subtitle] ffprobe parse error:", parseErr.message);
        resolve([]);
      }
    });
  });
}

// Helper: extract a subtitle stream to WebVTT format using ffmpeg
function extractSubtitleToVTT(videoPath, streamIndex, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      "-y",
      "-i", videoPath,
      "-map", `0:s:${streamIndex}`,  // select the Nth subtitle stream
      "-c:s", "webvtt",
      outputPath,
    ], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        console.error("[Subtitle] ffmpeg extract error:", err.message);
        return reject(new Error("字幕提取失败"));
      }
      resolve(outputPath);
    });
  });
}

// GET /api/subtitles/:filename - List all subtitle tracks in a video
app.get("/api/subtitles/:filename", async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(uploadsDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "视频文件不存在" });
  }

  try {
    const tracks = await probeSubtitles(filePath);

    // Filter out image-based subtitle formats (PGS, DVB, etc.) that can't convert to VTT
    const textTracks = tracks.filter((t) =>
      !["hdmv_pgs_subtitle", "dvb_subtitle", "dvd_subtitle", "pgssub"].includes(t.codec)
    );

    res.json({ tracks: textTracks });
  } catch (err) {
    console.error("[Subtitle] Error probing:", err);
    res.status(500).json({ error: "字幕探测失败" });
  }
});

// GET /api/subtitles/:filename/:streamIndex - Extract & serve a specific subtitle track as VTT
app.get("/api/subtitles/:filename/:streamIndex", async (req, res) => {
  const { filename, streamIndex } = req.params;
  const idx = parseInt(streamIndex, 10);

  if (isNaN(idx) || idx < 0) {
    return res.status(400).json({ error: "无效的字幕轨索引" });
  }

  const videoPath = path.join(uploadsDir, filename);
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: "视频文件不存在" });
  }

  // Cache: check if VTT already extracted
  const vttFilename = `${path.parse(filename).name}_sub${idx}.vtt`;
  const vttPath = path.join(subtitlesDir, vttFilename);

  if (fs.existsSync(vttPath)) {
    return res.json({ url: `/subtitles/${vttFilename}` });
  }

  try {
    await extractSubtitleToVTT(videoPath, idx, vttPath);
    res.json({ url: `/subtitles/${vttFilename}` });
  } catch (err) {
    res.status(500).json({ error: err.message || "字幕提取失败" });
  }
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

// Debug: check ffprobe availability and list uploaded files
app.get("/api/debug/ffprobe", async (req, res) => {
  const result = {
    ffprobeAvailable: false,
    ffmpegAvailable: false,
    ffprobePath,
    ffmpegPath,
    npmErrors: ffmpegErrors,
    nodeModulesExists: fs.existsSync(path.join(__dirname, "node_modules")),
    ffmpegInstallerExists: fs.existsSync(path.join(__dirname, "node_modules", "@ffmpeg-installer")),
    ffprobeInstallerExists: fs.existsSync(path.join(__dirname, "node_modules", "@ffprobe-installer")),
    ffmpegStaticExists: fs.existsSync(path.join(__dirname, "node_modules", "ffmpeg-static")),
    ffprobeStaticExists: fs.existsSync(path.join(__dirname, "node_modules", "ffprobe-static")),
    cwd: process.cwd(),
    dirname: __dirname,
    uploads: [],
    subtitles: [],
  };

  // Check ffprobe
  try {
    await new Promise((resolve, reject) => {
      execFile(ffprobePath, ["-version"], { timeout: 5000 }, (err, stdout) => {
        if (err) return reject(err);
        result.ffprobeAvailable = true;
        result.ffprobeVersion = stdout.split("\n")[0];
        resolve(stdout);
      });
    });
  } catch (e) {
    result.ffprobeError = e.message;
  }

  // Check ffmpeg
  try {
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, ["-version"], { timeout: 5000 }, (err, stdout) => {
        if (err) return reject(err);
        result.ffmpegAvailable = true;
        result.ffmpegVersion = stdout.split("\n")[0];
        resolve(stdout);
      });
    });
  } catch (e) {
    result.ffmpegError = e.message;
  }

  // List uploaded files
  try {
    result.uploads = fs.readdirSync(uploadsDir);
  } catch (e) {
    result.uploadsError = e.message;
  }

  // List subtitle files
  try {
    result.subtitles = fs.readdirSync(subtitlesDir);
  } catch (e) {
    result.subtitlesError = e.message;
  }

  res.json(result);
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
        // Find the video to delete its file
        const removedVideo = room2.playlist.find((v) => v.id === videoId);
        if (removedVideo) {
          const filename = extractFilename(removedVideo.src);
          if (filename) deleteUploadFile(filename);
        }
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
      // Room is empty, clean up uploaded files and remove room
      cleanupRoomFiles(room);
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
