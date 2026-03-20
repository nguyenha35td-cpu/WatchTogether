const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ==================== Tencent Cloud VOD Config ====================
const TENCENT_SECRET_ID = process.env.TENCENT_SECRET_ID || "";
const TENCENT_SECRET_KEY = process.env.TENCENT_SECRET_KEY || "";
const VOD_APP_ID = process.env.VOD_APP_ID || "";
const VOD_REGION = process.env.VOD_REGION || "ap-chongqing";

// ==================== MKV Subtitle Extractor (no ffmpeg needed) ====================
// Uses pure JS MKV parser with HTTP Range requests for fast subtitle extraction.
// Typically extracts subtitles in <5 seconds vs 1-3 minutes with ffmpeg.
console.log("[Subtitle] Using fast MKV Range-based extractor (no ffmpeg)");

// ==================== Subtitle Cache ====================
const subtitlesDir = path.join(__dirname, "subtitles");
if (!fs.existsSync(subtitlesDir)) {
  fs.mkdirSync(subtitlesDir, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json());

// Serve extracted subtitle VTT files
app.use("/subtitles", express.static(subtitlesDir, {
  setHeaders: (res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Type", "text/vtt; charset=utf-8");
  },
}));

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
    // 指定存储区域，SDK 会自动就近选择最优上传链路（全球加速）
    storageRegion: VOD_REGION || "ap-chongqing",
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
    res.json({ signature, vodAppId: Number(VOD_APP_ID), storageRegion: VOD_REGION });
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

// ==================== Subtitle APIs ====================

const { probeMKVSubtitles, extractMKVSubtitle } = require("./mkv-subtitle-extractor");

/**
 * Helper: Create a VOD client instance
 */
function createVodClient() {
  const tencentcloud = require("tencentcloud-sdk-nodejs");
  const VodClient = tencentcloud.vod.v20180717.Client;
  return new VodClient({
    credential: {
      secretId: TENCENT_SECRET_ID,
      secretKey: TENCENT_SECRET_KEY,
    },
    region: VOD_REGION,
    profile: { httpProfile: { endpoint: "vod.tencentcloudapi.com" } },
  });
}

// Cache probe results in memory to avoid re-probing (fileId -> probeResult)
const probeCache = new Map();
// Track in-progress extractions so we don't start duplicates (vttPath -> Promise)
const extractionInProgress = new Map();

/**
 * GET /api/subtitles/vod/:fileId — Probe subtitle tracks from a VOD file
 *
 * Uses pure JS MKV parser with HTTP Range requests — only downloads ~512KB of metadata
 * instead of the entire file. Probing typically completes in <2 seconds.
 *
 * After probing, immediately starts background extraction of ALL text-based subtitle
 * tracks using Range requests (also very fast, typically <5 seconds per track).
 */
app.get("/api/subtitles/vod/:fileId", async (req, res) => {
  const { fileId } = req.params;
  try {
    const client = createVodClient();
    const result = await client.DescribeMediaInfos({
      FileIds: [fileId],
      SubAppId: Number(VOD_APP_ID),
      Filters: ["basicInfo"],
    });

    const media = result.MediaInfoSet?.[0];
    if (!media) {
      return res.status(404).json({ error: "视频不存在" });
    }

    const basicInfo = media.BasicInfo;
    const mediaUrl = basicInfo?.MediaUrl;
    if (!mediaUrl) {
      return res.status(404).json({ error: "无法获取原始文件地址" });
    }

    // Check if it's an MKV file (by extension or just try MKV parsing first)
    const isMKV = /\.(mkv|webm)($|\?)/i.test(mediaUrl) || basicInfo.Type === "mkv" || basicInfo.Type === "webm";

    let textTracks = [];

    if (isMKV || true) {
      // Try MKV Range-based probe first (works for any Matroska container)
      try {
        console.log(`[Subtitle] Attempting fast MKV Range-based probe for fileId=${fileId}`);
        const probeResult = await probeMKVSubtitles(mediaUrl);
        probeCache.set(fileId, { probeResult, mediaUrl });

        textTracks = probeResult.tracks
          .filter((t) => !["hdmv_pgs_subtitle", "dvb_subtitle", "dvd_subtitle", "pgssub", "S_HDMV/PGS", "S_DVBSUB", "S_VOBSUB"].includes(t.codec) &&
                         !["hdmv_pgs_subtitle", "dvb_subtitle", "dvd_subtitle", "pgssub", "S_HDMV/PGS", "S_DVBSUB", "S_VOBSUB"].includes(t.codecId))
          .map((t, idx) => ({
            index: idx,
            streamIndex: idx,
            trackNumber: t.trackNumber,
            codec: t.codec,
            language: t.language || "",
            title: t.title || "",
          }));

        // No pre-extraction: subtitles are extracted on-demand when user selects a track
        // via GET /api/subtitles/vod/:fileId/:trackIdx
      } catch (mkvErr) {
        console.error("[Subtitle] MKV probe failed, not an MKV file:", mkvErr.message);
        // Not an MKV file or parsing failed — return empty
        textTracks = [];
      }
    }

    // Return probed tracks to frontend; include pre-cached VTT URLs
    const tracksWithVtt = textTracks.map((t) => {
      const vttFilename = `vod_${fileId}_sub${t.streamIndex}.vtt`;
      const vttPath = path.join(subtitlesDir, vttFilename);
      let vttUrl = null;
      if (fs.existsSync(vttPath) && fs.statSync(vttPath).size > 0) {
        vttUrl = `/subtitles/${vttFilename}`;
      }
      return { ...t, vttUrl };
    });

    res.json({ tracks: tracksWithVtt, mediaUrl });
  } catch (err) {
    console.error("[Subtitle] Error probing VOD file:", err);
    res.status(500).json({ error: "字幕探测失败", detail: err.message });
  }
});

/**
 * GET /api/subtitles/vod/:fileId/:streamIndex — Extract a subtitle track as WebVTT
 *
 * Uses fast MKV Range-based extraction. If already cached, returns immediately.
 * If extraction is in progress, waits for it to complete (typically <5 seconds).
 * No more polling needed — the response includes the VTT URL directly.
 */
app.get("/api/subtitles/vod/:fileId/:streamIndex", async (req, res) => {
  const { fileId, streamIndex } = req.params;
  const idx = parseInt(streamIndex, 10);

  if (isNaN(idx) || idx < 0) {
    return res.status(400).json({ error: "无效的字幕轨索引" });
  }

  const vttFilename = `vod_${fileId}_sub${idx}.vtt`;
  const vttPath = path.join(subtitlesDir, vttFilename);

  // Check if already cached
  if (fs.existsSync(vttPath) && fs.statSync(vttPath).size > 0) {
    return res.json({ status: "ready", url: `/subtitles/${vttFilename}` });
  }

  // If extraction is already in progress, wait for it
  if (extractionInProgress.has(vttPath)) {
    try {
      await extractionInProgress.get(vttPath);
      if (fs.existsSync(vttPath) && fs.statSync(vttPath).size > 0) {
        return res.json({ status: "ready", url: `/subtitles/${vttFilename}` });
      }
      return res.status(500).json({ status: "failed", error: "字幕提取完成但文件为空" });
    } catch (err) {
      return res.status(500).json({ status: "failed", error: err.message });
    }
  }

  // Need to extract — get probe data (from cache or re-probe)
  try {
    let cached = probeCache.get(fileId);
    if (!cached) {
      // Re-probe
      const client = createVodClient();
      const result = await client.DescribeMediaInfos({
        FileIds: [fileId],
        SubAppId: Number(VOD_APP_ID),
        Filters: ["basicInfo"],
      });

      const media = result.MediaInfoSet?.[0];
      const mediaUrl = media?.BasicInfo?.MediaUrl;
      if (!mediaUrl) {
        return res.status(404).json({ error: "无法获取原始文件地址" });
      }

      const probeResult = await probeMKVSubtitles(mediaUrl);
      cached = { probeResult, mediaUrl };
      probeCache.set(fileId, cached);
    }

    const { probeResult, mediaUrl } = cached;

    if (idx >= probeResult.tracks.length) {
      return res.status(400).json({ error: `字幕轨 ${idx} 不存在，共 ${probeResult.tracks.length} 条字幕轨` });
    }

    // Extract synchronously (fast — typically <5 seconds via Range requests)
    console.log(`[Subtitle] On-demand extraction for ${vttFilename}`);
    const startTime = Date.now();

    const promise = extractMKVSubtitle(mediaUrl, probeResult, idx)
      .then((vtt) => {
        fs.writeFileSync(vttPath, vtt, "utf-8");
        console.log(`[Subtitle] Extraction done: ${vttFilename} (${vtt.length} bytes) in ${Date.now() - startTime}ms`);
        extractionInProgress.delete(vttPath);
        return vtt;
      });

    extractionInProgress.set(vttPath, promise);
    const vtt = await promise;

    if (vtt && vtt.length > 10) {
      return res.json({ status: "ready", url: `/subtitles/${vttFilename}` });
    } else {
      return res.status(500).json({ status: "failed", error: "提取的字幕为空" });
    }
  } catch (err) {
    extractionInProgress.delete(vttPath);
    console.error("[Subtitle] Extraction error:", err);
    res.status(500).json({ status: "failed", error: err.message || "字幕提取失败" });
  }
});

// ==================== Global Upload History (JSON file persistence) ====================

const UPLOAD_HISTORY_FILE = path.join(__dirname, "upload-history.json");
const MAX_HISTORY_RECORDS = 500;

/** Read upload history from disk */
function readUploadHistory() {
  try {
    if (fs.existsSync(UPLOAD_HISTORY_FILE)) {
      const raw = fs.readFileSync(UPLOAD_HISTORY_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error("[UploadHistory] Failed to read:", err.message);
  }
  return [];
}

/** Write upload history to disk */
function writeUploadHistory(records) {
  try {
    fs.writeFileSync(UPLOAD_HISTORY_FILE, JSON.stringify(records, null, 2), "utf-8");
  } catch (err) {
    console.error("[UploadHistory] Failed to write:", err.message);
  }
}

// GET /api/upload-history — List all upload history records
app.get("/api/upload-history", (req, res) => {
  const records = readUploadHistory();
  res.json({ records });
});

// POST /api/upload-history — Add a new record
app.post("/api/upload-history", (req, res) => {
  const { title, vodFileId, uploadedBy } = req.body;
  if (!title) {
    return res.status(400).json({ error: "缺少 title" });
  }

  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title,
    vodFileId: vodFileId || "",
    uploadedAt: Date.now(),
    uploadedBy: uploadedBy || "未知用户",
  };

  const records = readUploadHistory();
  records.unshift(record);
  // Keep max records
  if (records.length > MAX_HISTORY_RECORDS) {
    records.length = MAX_HISTORY_RECORDS;
  }
  writeUploadHistory(records);

  res.json({ record });
});

// DELETE /api/upload-history/:id — Delete a single record
app.delete("/api/upload-history/:id", (req, res) => {
  const { id } = req.params;
  let records = readUploadHistory();
  const before = records.length;
  records = records.filter((r) => r.id !== id);
  if (records.length === before) {
    return res.status(404).json({ error: "记录不存在" });
  }
  writeUploadHistory(records);
  res.json({ success: true });
});

// DELETE /api/upload-history — Clear all records
app.delete("/api/upload-history", (req, res) => {
  writeUploadHistory([]);
  res.json({ success: true });
});

// ==================== HTTP Server & WebSocket ====================

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ==================== VOD File Cleanup ====================

/**
 * Track all uploaded VOD fileIds with their upload time for cleanup.
 * vodFileTracker: Map<fileId, { uploadedAt: number, roomId: string | null }>
 */
const vodFileTracker = new Map();

/**
 * Delete a single VOD file from Tencent Cloud.
 * Silently ignores errors (file may already be deleted).
 */
async function deleteVodFile(fileId) {
  try {
    const client = createVodClient();
    await client.DeleteMedia({
      FileId: fileId,
      SubAppId: Number(VOD_APP_ID),
    });
    console.log(`[VOD Cleanup] Deleted VOD file: ${fileId}`);
    // Also clean up subtitle cache
    cleanupSubtitleCache(fileId);
    vodFileTracker.delete(fileId);
  } catch (err) {
    // Ignore "file not found" errors — may already be deleted
    if (err.code === "ResourceNotFound" || err.code === "ResourceNotFound.FileNotExist") {
      console.log(`[VOD Cleanup] File already gone: ${fileId}`);
      vodFileTracker.delete(fileId);
    } else {
      console.error(`[VOD Cleanup] Failed to delete ${fileId}:`, err.message);
    }
  }
}

/**
 * Clean up subtitle VTT cache files for a given VOD fileId.
 */
function cleanupSubtitleCache(fileId) {
  try {
    const files = fs.readdirSync(subtitlesDir);
    const prefix = `vod_${fileId}_`;
    let cleaned = 0;
    for (const file of files) {
      if (file.startsWith(prefix)) {
        fs.unlinkSync(path.join(subtitlesDir, file));
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[VOD Cleanup] Cleaned ${cleaned} subtitle cache files for ${fileId}`);
    }
    // Also clear probe cache
    probeCache.delete(fileId);
  } catch (err) {
    console.error(`[VOD Cleanup] Subtitle cache cleanup error:`, err.message);
  }
}

/**
 * Collect VOD fileIds from a room's playlist and delete them all.
 * Called when a room is destroyed (all participants left).
 */
async function cleanupRoomVodFiles(roomId, playlist) {
  const vodFileIds = playlist
    .filter((v) => v.vodFileId)
    .map((v) => v.vodFileId);

  if (vodFileIds.length === 0) return;

  console.log(`[VOD Cleanup] Room ${roomId} destroyed, cleaning ${vodFileIds.length} VOD files: ${vodFileIds.join(", ")}`);

  // Delete all in parallel, don't await (fire-and-forget, don't block room cleanup)
  Promise.allSettled(vodFileIds.map((fid) => deleteVodFile(fid)))
    .then((results) => {
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      console.log(`[VOD Cleanup] Room ${roomId} cleanup done: ${succeeded}/${vodFileIds.length} files deleted`);
    });
}

/**
 * 24-hour safety net: periodically check vodFileTracker and delete files older than 24h.
 * This handles edge cases like server restart losing room state.
 */
const VOD_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function startVodCleanupTimer() {
  // Run every 30 minutes
  setInterval(() => {
    const now = Date.now();
    let expiredCount = 0;

    for (const [fileId, info] of vodFileTracker.entries()) {
      if (now - info.uploadedAt > VOD_FILE_MAX_AGE_MS) {
        expiredCount++;
        console.log(`[VOD Cleanup] File ${fileId} expired (uploaded ${Math.round((now - info.uploadedAt) / 3600000)}h ago), deleting...`);
        deleteVodFile(fileId);
      }
    }

    if (expiredCount > 0) {
      console.log(`[VOD Cleanup] Timer: found ${expiredCount} expired files`);
    }
  }, 30 * 60 * 1000); // every 30 min

  console.log(`[VOD Cleanup] 24h safety-net timer started (checks every 30min)`);
}

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

        // Track VOD fileId for 24h safety-net cleanup
        if (video.vodFileId) {
          vodFileTracker.set(video.vodFileId, {
            uploadedAt: Date.now(),
            roomId: currentRoomId,
          });
          console.log(`[VOD Cleanup] Tracking VOD file: ${video.vodFileId} (room: ${currentRoomId})`);
        }

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
        // Find the video before removing to clean up VOD file
        const removedVideo = room2.playlist.find((v) => v.id === videoId);
        if (removedVideo?.vodFileId) {
          console.log(`[VOD Cleanup] Video removed from playlist, deleting VOD file: ${removedVideo.vodFileId}`);
          deleteVodFile(removedVideo.vodFileId);
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
      // Room is empty — clean up VOD files then remove room
      cleanupRoomVodFiles(currentRoomId, room.playlist);
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

  // Start 24h safety-net cleanup timer
  startVodCleanupTimer();
});
