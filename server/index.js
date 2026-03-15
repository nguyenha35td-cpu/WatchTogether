const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");

// ==================== Tencent Cloud VOD Config ====================
const TENCENT_SECRET_ID = process.env.TENCENT_SECRET_ID || "";
const TENCENT_SECRET_KEY = process.env.TENCENT_SECRET_KEY || "";
const VOD_APP_ID = process.env.VOD_APP_ID || "";
const VOD_REGION = process.env.VOD_REGION || "ap-guangzhou";

const app = express();
app.use(cors());
app.use(express.json());

// ==================== VOD Upload Signature ====================

/**
 * Generate client upload signature for vod-js-sdk-v6.
 * See: https://cloud.tencent.com/document/product/266/9221
 */
function generateVodSignature() {
  const current = Math.floor(Date.now() / 1000);
  const expired = current + 86400; // 24h validity

  const params = {
    secretId: TENCENT_SECRET_ID,
    currentTimeStamp: current,
    expireTime: expired,
    random: Math.floor(Math.random() * 0xffffffff),
  };

  // 使用子应用时必须在签名中带上 vodSubAppId，否则报 "signature has no permission"
  if (VOD_APP_ID) {
    params.vodSubAppId = Number(VOD_APP_ID);
  }

  // Build query string (sorted keys)
  const queryString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");

  // HMAC-SHA1 signature
  const hmac = crypto.createHmac("sha1", TENCENT_SECRET_KEY);
  hmac.update(queryString);
  const signature = Buffer.concat([
    hmac.digest(),
    Buffer.from(queryString, "utf-8"),
  ]);

  return signature.toString("base64");
}

// GET /api/upload/vod-signature — Return one-time upload signature for frontend SDK
app.get("/api/upload/vod-signature", (req, res) => {
  if (!TENCENT_SECRET_ID || !TENCENT_SECRET_KEY || !VOD_APP_ID) {
    return res.status(500).json({ error: "VOD 配置缺失，请检查环境变量" });
  }
  try {
    const signature = generateVodSignature();
    res.json({ signature, vodAppId: Number(VOD_APP_ID) });
  } catch (err) {
    console.error("[VOD] Signature error:", err);
    res.status(500).json({ error: "生成签名失败" });
  }
});

// ==================== VOD Transcode Trigger ====================

// POST /api/upload/vod-complete — Trigger transcoding after upload completes
app.post("/api/upload/vod-complete", async (req, res) => {
  const { fileId } = req.body;
  if (!fileId) {
    return res.status(400).json({ error: "缺少 fileId" });
  }

  try {
    // Import Tencent Cloud VOD SDK
    const tencentcloud = require("tencentcloud-sdk-nodejs");
    const VodClient = tencentcloud.vod.v20180717.Client;
    const client = new VodClient({
      credential: {
        secretId: TENCENT_SECRET_ID,
        secretKey: TENCENT_SECRET_KEY,
      },
      region: VOD_REGION,
      profile: { httpProfile: { endpoint: "vod.tencentcloudapi.com" } },
    });

    // Trigger ProcessMedia — Adaptive Dynamic Streaming (Definition 10 = HLS multi-bitrate)
    const result = await client.ProcessMedia({
      FileId: fileId,
      SubAppId: Number(VOD_APP_ID),
      AdaptiveDynamicStreamingTaskSet: [{ Definition: 10 }],
    });

    console.log(`[VOD] ProcessMedia triggered for fileId=${fileId}, TaskId=${result.TaskId}`);
    res.json({ success: true, taskId: result.TaskId, fileId });
  } catch (err) {
    console.error("[VOD] ProcessMedia error:", err);
    res.status(500).json({ error: "转码触发失败", detail: err.message });
  }
});

// ==================== VOD Play URL ====================

// GET /api/video/:fileId/playurl — Get HLS/MP4 play URL from VOD
app.get("/api/video/:fileId/playurl", async (req, res) => {
  const { fileId } = req.params;
  try {
    const tencentcloud = require("tencentcloud-sdk-nodejs");
    const VodClient = tencentcloud.vod.v20180717.Client;
    const client = new VodClient({
      credential: {
        secretId: TENCENT_SECRET_ID,
        secretKey: TENCENT_SECRET_KEY,
      },
      region: VOD_REGION,
      profile: { httpProfile: { endpoint: "vod.tencentcloudapi.com" } },
    });

    const result = await client.DescribeMediaInfos({
      FileIds: [fileId],
      SubAppId: Number(VOD_APP_ID),
      Filters: ["basicInfo", "transcodeInfo", "adaptiveDynamicStreamingInfo"],
    });

    const media = result.MediaInfoSet?.[0];
    if (!media) {
      return res.status(404).json({ error: "视频不存在" });
    }

    // Priority 1: Adaptive HLS stream
    const adaptive = media.AdaptiveDynamicStreamingInfo?.AdaptiveDynamicStreamingSet;
    if (adaptive && adaptive.length > 0) {
      // Find the first HLS package
      const hlsStream = adaptive.find((s) => s.Package === "HLS" || s.Url?.endsWith(".m3u8"));
      if (hlsStream?.Url) {
        return res.json({
          playUrl: hlsStream.Url,
          type: "hls",
          fileId,
          title: media.BasicInfo?.Name || "",
          coverUrl: media.BasicInfo?.CoverUrl || "",
        });
      }
      // Any adaptive stream
      if (adaptive[0]?.Url) {
        return res.json({
          playUrl: adaptive[0].Url,
          type: adaptive[0].Url.endsWith(".m3u8") ? "hls" : "mp4",
          fileId,
          title: media.BasicInfo?.Name || "",
          coverUrl: media.BasicInfo?.CoverUrl || "",
        });
      }
    }

    // Priority 2: Transcoded MP4
    const transcodes = media.TranscodeInfo?.TranscodeSet;
    if (transcodes && transcodes.length > 0) {
      // Pick highest definition
      const sorted = [...transcodes].sort((a, b) => (b.Height || 0) - (a.Height || 0));
      return res.json({
        playUrl: sorted[0].Url,
        type: "mp4",
        fileId,
        title: media.BasicInfo?.Name || "",
        coverUrl: media.BasicInfo?.CoverUrl || "",
      });
    }

    // Priority 3: Original file URL
    if (media.BasicInfo?.MediaUrl) {
      return res.json({
        playUrl: media.BasicInfo.MediaUrl,
        type: "mp4",
        fileId,
        title: media.BasicInfo?.Name || "",
        coverUrl: media.BasicInfo?.CoverUrl || "",
      });
    }

    res.status(404).json({ error: "暂无可用播放地址，视频可能正在转码中" });
  } catch (err) {
    console.error("[VOD] DescribeMediaInfos error:", err);
    res.status(500).json({ error: "获取播放地址失败", detail: err.message });
  }
});

// ==================== VOD Debug ====================

app.get("/api/debug/vod", (req, res) => {
  res.json({
    configured: !!(TENCENT_SECRET_ID && TENCENT_SECRET_KEY && VOD_APP_ID),
    vodAppId: VOD_APP_ID,
    vodRegion: VOD_REGION,
    secretIdPrefix: TENCENT_SECRET_ID ? TENCENT_SECRET_ID.substring(0, 8) + "..." : "NOT SET",
  });
});

// ==================== HTTP Server & WebSocket ====================

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
      // Room is empty, remove room (no local files to clean up with VOD)
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
  console.log(`   VOD:  AppId=${VOD_APP_ID}, Region=${VOD_REGION}`);
});
