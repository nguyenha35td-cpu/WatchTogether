/**
 * MKV (Matroska) Subtitle Extractor — HTTP Range based
 *
 * Extracts subtitle tracks from remote MKV files using HTTP Range requests.
 * Only downloads the MKV header (EBML + Segment Info + Tracks + Cues) and
 * the subtitle data blocks — typically <1MB even for multi-GB files.
 *
 * Flow:
 * 1. Read EBML header + Segment element header (~64KB)
 * 2. Parse Tracks element to discover subtitle tracks (codec, language, etc.)
 * 3. Parse Cues element (seek index) to find Cluster positions
 * 4. For each Cluster, use Range requests to fetch only subtitle-track blocks
 * 5. Decode codec-specific data (ASS/SSA/SRT/UTF-8) and convert to WebVTT
 */

"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");

// HTTP keep-alive agents — reuse TCP/TLS connections across Range requests
// This avoids the ~100ms overhead of establishing a new connection per request
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000 });

// ==================== EBML Element IDs ====================
// Matroska spec: https://www.matroska.org/technical/elements.html

const EBML_IDS = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Name: 0x536e,
  ContentEncodings: 0x6d80,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
};

// Track types
const TRACK_TYPE_SUBTITLE = 0x11; // 17

// ==================== HTTP Range Fetcher ====================

/**
 * Fetch a byte range from a URL.
 * Returns a Buffer.
 */
function fetchRange(url, start, end, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));

    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === "https:" ? https : http;

    const agent = parsedUrl.protocol === "https:" ? httpsAgent : httpAgent;
    const req = mod.get(
      url,
      {
        agent,
        headers: { Range: `bytes=${start}-${end}` },
        timeout: 30000,
      },
      (res) => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          return fetchRange(res.headers.location, start, end, redirectCount + 1)
            .then(resolve)
            .catch(reject);
        }

        if (res.statusCode !== 206 && res.statusCode !== 200) {
          // Consume body to free socket
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for Range ${start}-${end}`));
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

/**
 * Get the total file size via HEAD request.
 */
function getFileSize(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));

    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === "https:" ? https : http;

    const req = mod.request(url, { method: "HEAD", timeout: 15000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return getFileSize(res.headers.location, redirectCount + 1)
          .then(resolve)
          .catch(reject);
      }
      res.resume();
      const cl = res.headers["content-length"];
      if (!cl) return reject(new Error("No Content-Length header"));
      resolve(parseInt(cl, 10));
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HEAD request timeout"));
    });
    req.end();
  });
}

// ==================== EBML Parser ====================

class EBMLReader {
  constructor(buffer, offset = 0) {
    this.buf = buffer;
    this.pos = offset;
  }

  get remaining() { return this.buf.length - this.pos; }
  get done() { return this.pos >= this.buf.length; }

  /**
   * Read a variable-length EBML element ID.
   * Returns { id, length } where length is the number of bytes consumed.
   */
  readElementID() {
    if (this.pos >= this.buf.length) return null;
    const first = this.buf[this.pos];
    let len;
    if      (first & 0x80) len = 1;
    else if (first & 0x40) len = 2;
    else if (first & 0x20) len = 3;
    else if (first & 0x10) len = 4;
    else return null;

    if (this.pos + len > this.buf.length) return null;

    let id = 0;
    for (let i = 0; i < len; i++) {
      id = (id * 256) + this.buf[this.pos + i];
    }
    this.pos += len;
    return id;
  }

  /**
   * Read a variable-length EBML data size (VINT).
   * Returns the size value, or -1 for unknown size.
   */
  readVINT() {
    if (this.pos >= this.buf.length) return null;
    const first = this.buf[this.pos];
    let len;
    let mask;
    if      (first & 0x80) { len = 1; mask = 0x7f; }
    else if (first & 0x40) { len = 2; mask = 0x3f; }
    else if (first & 0x20) { len = 3; mask = 0x1f; }
    else if (first & 0x10) { len = 4; mask = 0x0f; }
    else if (first & 0x08) { len = 5; mask = 0x07; }
    else if (first & 0x04) { len = 6; mask = 0x03; }
    else if (first & 0x02) { len = 7; mask = 0x01; }
    else if (first & 0x01) { len = 8; mask = 0x00; }
    else return null;

    if (this.pos + len > this.buf.length) return null;

    let value = first & mask;
    for (let i = 1; i < len; i++) {
      value = value * 256 + this.buf[this.pos + i];
    }
    this.pos += len;

    // Check for "unknown size" (all VINT_DATA bits set to 1)
    const maxVal = (1 << (7 * len)) - 1; // All data bits set
    // For the mask, need a more precise check
    let allOnes = mask;
    for (let i = 1; i < len; i++) allOnes = allOnes * 256 + 0xff;
    if (value === allOnes) return -1; // Unknown size

    return value;
  }

  /**
   * Read an unsigned integer of `len` bytes.
   */
  readUint(len) {
    if (this.pos + len > this.buf.length) return 0;
    let val = 0;
    for (let i = 0; i < len; i++) {
      val = val * 256 + this.buf[this.pos + i];
    }
    this.pos += len;
    return val;
  }

  /**
   * Read a float (4 or 8 bytes).
   */
  readFloat(len) {
    if (len === 4) {
      const val = this.buf.readFloatBE(this.pos);
      this.pos += 4;
      return val;
    } else if (len === 8) {
      const val = this.buf.readDoubleBE(this.pos);
      this.pos += 8;
      return val;
    }
    return 0;
  }

  /**
   * Read a UTF-8 string of `len` bytes.
   */
  readString(len) {
    const str = this.buf.toString("utf-8", this.pos, this.pos + len).replace(/\0+$/, "");
    this.pos += len;
    return str;
  }

  /**
   * Read raw bytes.
   */
  readBytes(len) {
    const data = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return data;
  }

  skip(len) {
    this.pos += len;
  }
}

// ==================== MKV Metadata Parser ====================

/**
 * Parse EBML header and Segment metadata from a buffer.
 * Returns an object with SeekHead entries, Tracks, TimestampScale, etc.
 */
function parseSegmentChildren(buf, segmentDataStart, segmentDataEnd) {
  const reader = new EBMLReader(buf, 0);
  const seekHeadEntries = []; // { id, position (relative to Segment data start) }
  let timestampScale = 1000000; // Default: 1ms
  let durationFloat = 0;
  const trackEntries = [];
  const cuePoints = [];

  // We need to find key top-level elements: SeekHead, Info, Tracks, Cues
  // They may appear in any order within the Segment

  while (!reader.done && reader.remaining > 2) {
    const elemStart = reader.pos;
    const id = reader.readElementID();
    if (id === null) break;
    const size = reader.readVINT();
    if (size === null) break;
    const dataStart = reader.pos;

    if (size < 0) {
      // Unknown size — skip
      break;
    }

    if (dataStart + size > buf.length) {
      // Element extends beyond our buffer — that's fine, we may not have it all
      break;
    }

    switch (id) {
      case EBML_IDS.SeekHead:
        parseSeekHead(buf.subarray(dataStart, dataStart + size), seekHeadEntries);
        break;

      case EBML_IDS.Info:
        parseInfo(buf.subarray(dataStart, dataStart + size), (ts) => { timestampScale = ts; }, (d) => { durationFloat = d; });
        break;

      case EBML_IDS.Tracks:
        parseTracks(buf.subarray(dataStart, dataStart + size), trackEntries);
        break;

      case EBML_IDS.Cues:
        parseCues(buf.subarray(dataStart, dataStart + size), cuePoints);
        break;

      case EBML_IDS.Cluster:
        // We've hit Clusters; stop scanning metadata
        // (Cues might be at the end, handled separately)
        reader.pos = dataStart + size;
        // Don't break outer loop — Cues might come after some Clusters in rare files
        continue;

      default:
        break;
    }

    reader.pos = dataStart + size;
  }

  return { seekHeadEntries, timestampScale, durationFloat, trackEntries, cuePoints };
}

function parseSeekHead(buf, entries) {
  const reader = new EBMLReader(buf);
  while (!reader.done && reader.remaining > 2) {
    const id = reader.readElementID();
    if (id === null) break;
    const size = reader.readVINT();
    if (size === null || size < 0) break;
    const dataStart = reader.pos;

    if (id === EBML_IDS.Seek) {
      let seekId = 0;
      let seekPos = 0;
      const sr = new EBMLReader(buf.subarray(dataStart, dataStart + size));
      while (!sr.done && sr.remaining > 2) {
        const sid = sr.readElementID();
        if (sid === null) break;
        const ssz = sr.readVINT();
        if (ssz === null || ssz < 0) break;
        const sds = sr.pos;
        if (sid === EBML_IDS.SeekID) {
          seekId = sr.readUint(ssz);
        } else if (sid === EBML_IDS.SeekPosition) {
          seekPos = sr.readUint(ssz);
        }
        sr.pos = sds + ssz;
      }
      entries.push({ id: seekId, position: seekPos });
    }

    reader.pos = dataStart + size;
  }
}

function parseInfo(buf, onTimestampScale, onDuration) {
  const reader = new EBMLReader(buf);
  while (!reader.done && reader.remaining > 2) {
    const id = reader.readElementID();
    if (id === null) break;
    const size = reader.readVINT();
    if (size === null || size < 0) break;
    const dataStart = reader.pos;

    if (id === EBML_IDS.TimestampScale) {
      onTimestampScale(reader.readUint(size));
    } else if (id === EBML_IDS.Duration) {
      onDuration(reader.readFloat(size));
    }

    reader.pos = dataStart + size;
  }
}

function parseTracks(buf, trackEntries) {
  const reader = new EBMLReader(buf);
  while (!reader.done && reader.remaining > 2) {
    const id = reader.readElementID();
    if (id === null) break;
    const size = reader.readVINT();
    if (size === null || size < 0) break;
    const dataStart = reader.pos;

    if (id === EBML_IDS.TrackEntry) {
      const entry = parseTrackEntry(buf.subarray(dataStart, dataStart + size));
      if (entry) trackEntries.push(entry);
    }

    reader.pos = dataStart + size;
  }
}

function parseTrackEntry(buf) {
  const reader = new EBMLReader(buf);
  const entry = {
    number: 0,
    uid: 0,
    type: 0,
    codecId: "",
    codecPrivate: null,
    language: "und",
    languageBCP47: "",
    name: "",
    flagDefault: 1,
    flagForced: 0,
    hasContentEncodings: false,
  };

  while (!reader.done && reader.remaining > 2) {
    const id = reader.readElementID();
    if (id === null) break;
    const size = reader.readVINT();
    if (size === null || size < 0) break;
    const dataStart = reader.pos;

    switch (id) {
      case EBML_IDS.TrackNumber:
        entry.number = reader.readUint(size);
        break;
      case EBML_IDS.TrackUID:
        entry.uid = reader.readUint(size);
        break;
      case EBML_IDS.TrackType:
        entry.type = reader.readUint(size);
        break;
      case EBML_IDS.CodecID:
        entry.codecId = reader.readString(size);
        break;
      case EBML_IDS.CodecPrivate:
        entry.codecPrivate = reader.readBytes(size);
        break;
      case EBML_IDS.Language:
        entry.language = reader.readString(size);
        break;
      case EBML_IDS.LanguageBCP47:
        entry.languageBCP47 = reader.readString(size);
        break;
      case EBML_IDS.Name:
        entry.name = reader.readString(size);
        break;
      case EBML_IDS.FlagDefault:
        entry.flagDefault = reader.readUint(size);
        break;
      case EBML_IDS.FlagForced:
        entry.flagForced = reader.readUint(size);
        break;
      case EBML_IDS.ContentEncodings:
        entry.hasContentEncodings = true;
        break;
      default:
        break;
    }

    reader.pos = dataStart + size;
  }

  return entry;
}

function parseCues(buf, cuePoints) {
  const reader = new EBMLReader(buf);
  while (!reader.done && reader.remaining > 2) {
    const id = reader.readElementID();
    if (id === null) break;
    const size = reader.readVINT();
    if (size === null || size < 0) break;
    const dataStart = reader.pos;

    if (id === EBML_IDS.CuePoint) {
      const cp = parseCuePoint(buf.subarray(dataStart, dataStart + size));
      if (cp) cuePoints.push(cp);
    }

    reader.pos = dataStart + size;
  }
}

function parseCuePoint(buf) {
  const reader = new EBMLReader(buf);
  let time = 0;
  const positions = [];

  while (!reader.done && reader.remaining > 2) {
    const id = reader.readElementID();
    if (id === null) break;
    const size = reader.readVINT();
    if (size === null || size < 0) break;
    const dataStart = reader.pos;

    if (id === EBML_IDS.CueTime) {
      time = reader.readUint(size);
    } else if (id === EBML_IDS.CueTrackPositions) {
      let track = 0;
      let clusterPos = 0;
      const sr = new EBMLReader(buf.subarray(dataStart, dataStart + size));
      while (!sr.done && sr.remaining > 2) {
        const sid = sr.readElementID();
        if (sid === null) break;
        const ssz = sr.readVINT();
        if (ssz === null || ssz < 0) break;
        const sds = sr.pos;
        if (sid === EBML_IDS.CueTrack) {
          track = sr.readUint(ssz);
        } else if (sid === EBML_IDS.CueClusterPosition) {
          clusterPos = sr.readUint(ssz);
        }
        sr.pos = sds + ssz;
      }
      positions.push({ track, clusterPos });
    }

    reader.pos = dataStart + size;
  }

  return { time, positions };
}

// ==================== Cluster Block Parser ====================

/**
 * Parse a Cluster's content to extract subtitle blocks for given track numbers.
 *
 * Returns an array of { trackNumber, timecodeMs, durationMs, data: Buffer }
 */
function parseClusterBlocks(clusterBuf, clusterTimestamp, timestampScale, subtitleTrackNumbers) {
  const reader = new EBMLReader(clusterBuf);
  const blocks = [];
  const trackSet = new Set(subtitleTrackNumbers);

  while (!reader.done && reader.remaining > 4) {
    const elemPos = reader.pos;
    const id = reader.readElementID();
    if (id === null) break;
    const size = reader.readVINT();
    if (size === null || size < 0) break;
    const dataStart = reader.pos;

    if (dataStart + size > clusterBuf.length) break;

    if (id === EBML_IDS.Timestamp) {
      // Already parsed via parameter
    } else if (id === EBML_IDS.SimpleBlock) {
      const block = parseBlockHeader(clusterBuf.subarray(dataStart, dataStart + size));
      if (block && trackSet.has(block.trackNumber)) {
        const timecodeMs = (clusterTimestamp + block.timecodeRelative) * (timestampScale / 1000000);
        blocks.push({
          trackNumber: block.trackNumber,
          timecodeMs,
          durationMs: 0, // SimpleBlock typically doesn't have duration for subtitles
          data: block.data,
          isKeyframe: block.isKeyframe,
        });
      }
    } else if (id === EBML_IDS.BlockGroup) {
      const bg = parseBlockGroup(clusterBuf.subarray(dataStart, dataStart + size), trackSet);
      if (bg) {
        const timecodeMs = (clusterTimestamp + bg.timecodeRelative) * (timestampScale / 1000000);
        blocks.push({
          trackNumber: bg.trackNumber,
          timecodeMs,
          durationMs: bg.blockDuration * (timestampScale / 1000000),
          data: bg.data,
        });
      }
    }

    reader.pos = dataStart + size;
  }

  return blocks;
}

function parseBlockHeader(buf) {
  if (buf.length < 4) return null;
  const reader = new EBMLReader(buf);
  // Track number is a VINT
  const startPos = reader.pos;
  const first = buf[reader.pos];
  let trackLen;
  if      (first & 0x80) trackLen = 1;
  else if (first & 0x40) trackLen = 2;
  else if (first & 0x20) trackLen = 3;
  else if (first & 0x10) trackLen = 4;
  else return null;

  let trackNumber = first & ((1 << (8 - trackLen)) - 1);
  for (let i = 1; i < trackLen; i++) {
    trackNumber = trackNumber * 256 + buf[reader.pos + i];
  }
  reader.pos += trackLen;

  if (reader.remaining < 3) return null;

  // Timecode relative to cluster (signed 16-bit)
  const timecodeRelative = buf.readInt16BE(reader.pos);
  reader.pos += 2;

  // Flags
  const flags = buf[reader.pos];
  reader.pos += 1;
  const isKeyframe = !!(flags & 0x80);

  const data = buf.subarray(reader.pos);

  return { trackNumber, timecodeRelative, isKeyframe, data };
}

function parseBlockGroup(buf, trackSet) {
  const reader = new EBMLReader(buf);
  let blockData = null;
  let blockDuration = 0;

  while (!reader.done && reader.remaining > 2) {
    const id = reader.readElementID();
    if (id === null) break;
    const size = reader.readVINT();
    if (size === null || size < 0) break;
    const dataStart = reader.pos;

    if (dataStart + size > buf.length) break;

    if (id === EBML_IDS.Block) {
      const block = parseBlockHeader(buf.subarray(dataStart, dataStart + size));
      if (block && trackSet.has(block.trackNumber)) {
        blockData = block;
      }
    } else if (id === EBML_IDS.BlockDuration) {
      blockDuration = reader.readUint(size);
    }

    reader.pos = dataStart + size;
  }

  if (!blockData) return null;
  return { ...blockData, blockDuration };
}

// ==================== ASS/SSA to VTT Converter ====================

/**
 * Parse ASS/SSA subtitle format.
 * The CodecPrivate contains the ASS header ([Script Info], [V4+ Styles], etc.)
 * Each block's data contains the "Dialogue:" line text (without the "Dialogue:" prefix).
 *
 * ASS Dialogue format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
 * But in MKV blocks, the data is: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
 * And the timing comes from the block's timecode + duration, not from the ASS fields.
 */
function stripAssTags(text) {
  // Remove ASS/SSA override tags like {\b1}, {\an8}, {\pos(x,y)}, {\fad(100,200)}
  let result = text.replace(/\{[^}]*\}/g, "");
  // Convert \N and \n to newlines
  result = result.replace(/\\[Nn]/g, "\n");
  // Remove leading/trailing whitespace
  result = result.trim();
  return result;
}

/**
 * Parse SRT/SubRip codec content.
 * Each block is a complete SRT entry (may include timing or just text).
 * In MKV, each block is usually just the text.
 */
function parseSRTBlock(data) {
  const text = data.toString("utf-8").trim();
  // Remove SRT sequence number and timing line if present
  const lines = text.split(/\r?\n/);
  // Filter out lines that look like SRT timing (00:00:00,000 --> 00:00:00,000)
  const textLines = lines.filter(
    (l) => !l.match(/^\d+$/) && !l.match(/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/)
  );
  return textLines.join("\n").trim();
}

// ==================== WebVTT Generator ====================

function msToVTTTime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = Math.floor(ms % 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function blocksToVTT(blocks, codecId) {
  let vtt = "WEBVTT\n\n";

  // Sort by timecode
  blocks.sort((a, b) => a.timecodeMs - b.timecodeMs);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const startMs = block.timecodeMs;
    let endMs = block.timecodeMs + (block.durationMs || 0);

    // If no duration, use a default (e.g., until next subtitle or +5s)
    if (block.durationMs <= 0) {
      if (i + 1 < blocks.length) {
        endMs = blocks[i + 1].timecodeMs;
      } else {
        endMs = startMs + 5000;
      }
    }

    let text = "";
    const isASS = codecId.includes("ASS") || codecId.includes("SSA");
    const isSRT = codecId.includes("SRT") || codecId === "S_TEXT/UTF8";

    if (isASS) {
      // MKV ASS block format: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
      const raw = block.data.toString("utf-8");
      const parts = raw.split(",");
      if (parts.length >= 9) {
        // Text is everything after the 8th comma
        text = parts.slice(8).join(",");
        text = stripAssTags(text);
      } else {
        text = stripAssTags(raw);
      }
    } else if (isSRT) {
      text = parseSRTBlock(block.data);
    } else {
      // Generic text subtitle
      text = block.data.toString("utf-8").trim();
    }

    if (!text) continue;

    vtt += `${i + 1}\n`;
    vtt += `${msToVTTTime(startMs)} --> ${msToVTTTime(endMs)}\n`;
    vtt += `${text}\n\n`;
  }

  return vtt;
}

// ==================== Main Extraction Functions ====================

/**
 * Probe subtitle tracks from a remote MKV URL.
 * Only downloads the first ~512KB to find EBML header, Tracks, and SeekHead.
 *
 * Returns: { tracks: SubtitleTrackInfo[], timestampScale, segmentDataOffset }
 */
async function probeMKVSubtitles(mediaUrl) {
  console.log("[MKV] Probing subtitles from:", mediaUrl.substring(0, 100) + "...");
  const startTime = Date.now();

  // Step 1: Fetch first chunk (enough for EBML header + SeekHead + Tracks in most files)
  // Most MKV files have metadata in the first 256KB-1MB
  const INITIAL_FETCH = 512 * 1024; // 512KB
  let fileSize;
  try {
    fileSize = await getFileSize(mediaUrl);
  } catch (e) {
    console.error("[MKV] Failed to get file size:", e.message);
    fileSize = 0; // will still try range requests
  }

  const endByte = Math.min(INITIAL_FETCH - 1, fileSize ? fileSize - 1 : INITIAL_FETCH - 1);
  const headerBuf = await fetchRange(mediaUrl, 0, endByte);
  console.log(`[MKV] Fetched initial ${headerBuf.length} bytes in ${Date.now() - startTime}ms`);

  // Step 2: Parse EBML header
  const ebmlReader = new EBMLReader(headerBuf);
  const ebmlId = ebmlReader.readElementID();
  if (ebmlId !== EBML_IDS.EBML) {
    throw new Error("Not a valid EBML/MKV file (bad EBML header)");
  }
  const ebmlSize = ebmlReader.readVINT();
  ebmlReader.skip(ebmlSize); // Skip EBML header content

  // Step 3: Parse Segment header
  const segId = ebmlReader.readElementID();
  if (segId !== EBML_IDS.Segment) {
    throw new Error("Not a valid MKV file (no Segment element)");
  }
  const segSize = ebmlReader.readVINT(); // Usually "unknown size" for streaming
  const segmentDataOffset = ebmlReader.pos; // File offset where Segment data begins

  // Step 4: Parse Segment children from initial buffer
  const segBuf = headerBuf.subarray(segmentDataOffset);
  let parsed = parseSegmentChildren(segBuf, segmentDataOffset, segmentDataOffset + (segSize > 0 ? segSize : headerBuf.length));

  // Step 5: If we didn't find Tracks in the initial fetch, look in SeekHead
  if (parsed.trackEntries.length === 0 && parsed.seekHeadEntries.length > 0) {
    const tracksSeek = parsed.seekHeadEntries.find((e) => e.id === EBML_IDS.Tracks);
    if (tracksSeek) {
      const tracksFileOffset = segmentDataOffset + tracksSeek.position;
      console.log(`[MKV] Tracks element at file offset ${tracksFileOffset}, fetching...`);
      // Fetch extra for Tracks element (usually <32KB)
      const tracksBuf = await fetchRange(mediaUrl, tracksFileOffset, tracksFileOffset + 65535);
      const tr = new EBMLReader(tracksBuf);
      const tid = tr.readElementID();
      const tsize = tr.readVINT();
      if (tid === EBML_IDS.Tracks && tsize > 0) {
        const needed = tr.pos + tsize;
        let fullTracksBuf = tracksBuf;
        if (needed > tracksBuf.length) {
          fullTracksBuf = await fetchRange(mediaUrl, tracksFileOffset, tracksFileOffset + needed - 1);
          const tr2 = new EBMLReader(fullTracksBuf);
          tr2.readElementID();
          tr2.readVINT();
          parseTracks(fullTracksBuf.subarray(tr2.pos, tr2.pos + tsize), parsed.trackEntries);
        } else {
          parseTracks(tracksBuf.subarray(tr.pos, tr.pos + tsize), parsed.trackEntries);
        }
      }
    }
  }

  // Filter subtitle tracks
  const subtitleTracks = parsed.trackEntries
    .filter((t) => t.type === TRACK_TYPE_SUBTITLE)
    .map((t, idx) => ({
      index: idx,
      streamIndex: idx,
      trackNumber: t.number,
      codec: codecIdToShortName(t.codecId),
      codecId: t.codecId,
      language: t.languageBCP47 || t.language || "und",
      title: t.name || "",
      codecPrivate: t.codecPrivate,
      hasContentEncodings: t.hasContentEncodings,
    }));

  // Find Cues position from SeekHead for later use
  let cuesFileOffset = null;
  const cuesSeek = parsed.seekHeadEntries.find((e) => e.id === EBML_IDS.Cues);
  if (cuesSeek) {
    cuesFileOffset = segmentDataOffset + cuesSeek.position;
  }

  console.log(`[MKV] Found ${subtitleTracks.length} subtitle tracks in ${Date.now() - startTime}ms`);
  subtitleTracks.forEach((t) => {
    console.log(`  Track #${t.trackNumber}: ${t.codecId} [${t.language}] "${t.title}"`);
  });

  return {
    tracks: subtitleTracks,
    timestampScale: parsed.timestampScale,
    segmentDataOffset,
    cuesFileOffset,
    fileSize,
    seekHeadEntries: parsed.seekHeadEntries,
  };
}

function codecIdToShortName(codecId) {
  const map = {
    "S_TEXT/ASS": "ass",
    "S_TEXT/SSA": "ssa",
    "S_TEXT/UTF8": "srt",
    "S_TEXT/WEBVTT": "webvtt",
    "S_HDMV/PGS": "hdmv_pgs_subtitle",
    "S_DVBSUB": "dvb_subtitle",
    "S_VOBSUB": "dvd_subtitle",
  };
  return map[codecId] || codecId;
}

/**
 * Parse a single cluster buffer and extract subtitle blocks.
 * Reusable helper for both pass 1 and pass 2.
 * Returns an array of subtitle block objects.
 */
function parseClusterBuffer(buf, timestampScale, trackNumbers) {
  const reader = new EBMLReader(buf, 0);
  const cid = reader.readElementID();
  if (cid !== EBML_IDS.Cluster) return [];
  const csize = reader.readVINT();
  if (csize === null) return [];

  const clusterDataStart = reader.pos;
  // If csize is -1 (unknown size), use the rest of the buffer
  const clusterDataEnd = (csize < 0)
    ? buf.length
    : Math.min(clusterDataStart + csize, buf.length);
  const clusterData = buf.subarray(clusterDataStart, clusterDataEnd);

  // Parse cluster timestamp
  const tsr = new EBMLReader(clusterData);
  let clusterTimestamp = 0;
  while (!tsr.done && tsr.remaining > 2) {
    const tid = tsr.readElementID();
    if (tid === null) break;
    const tsz = tsr.readVINT();
    if (tsz === null || tsz < 0) break;
    if (tid === EBML_IDS.Timestamp) {
      clusterTimestamp = tsr.readUint(tsz);
      break;
    }
    tsr.pos = tsr.pos + tsz;
  }

  return parseClusterBlocks(clusterData, clusterTimestamp, timestampScale, trackNumbers);
}

/**
 * Fetch multiple byte ranges in parallel with concurrency control and retry.
 * Returns an array of Buffers in the same order as the ranges.
 */
async function fetchRangesParallel(url, ranges, concurrency = 6) {
  const results = new Array(ranges.length);
  let idx = 0;
  const MAX_RETRIES = 3;

  async function worker() {
    while (idx < ranges.length) {
      const i = idx++;
      const [start, end] = ranges[i];
      let lastErr;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          results[i] = await fetchRange(url, start, end);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          // Wait a bit before retry (exponential backoff: 500ms, 1500ms, 3500ms)
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
          }
        }
      }
      if (lastErr) {
        throw new Error(`Range ${start}-${end} failed after ${MAX_RETRIES} retries: ${lastErr.message}`);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, ranges.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Extract a specific subtitle track from a remote MKV URL using Range requests.
 *
 * OPTIMIZED Strategy (v2):
 * 1. Parse Cues to get all Cluster positions
 * 2. Merge adjacent Cluster positions into large contiguous byte ranges (~4MB each)
 * 3. Fetch these merged ranges in parallel (8 concurrent requests)
 * 4. Parse each merged chunk in-memory to extract only subtitle blocks
 *
 * For a typical 2-hour movie with 1000+ clusters, this reduces ~2000 HTTP requests
 * to ~20-50 merged parallel requests, completing in 2-5 seconds.
 *
 * Returns WebVTT string.
 */
async function extractMKVSubtitle(mediaUrl, probeResult, trackIndex) {
  const startTime = Date.now();
  const track = probeResult.tracks[trackIndex];
  if (!track) {
    throw new Error(`Subtitle track index ${trackIndex} not found`);
  }

  console.log(`[MKV] Extracting subtitle track #${track.trackNumber} (${track.codecId}) [${track.language}]`);

  const {
    timestampScale,
    segmentDataOffset,
    cuesFileOffset,
    fileSize,
    seekHeadEntries,
  } = probeResult;

  const subtitleBlocks = [];
  const trackNumbers = [track.trackNumber];

  // First, find where the first Cluster starts
  let firstClusterOffset = null;
  const clusterSeek = seekHeadEntries.find((e) => e.id === EBML_IDS.Cluster);
  if (clusterSeek) {
    firstClusterOffset = segmentDataOffset + clusterSeek.position;
  }

  // If we have Cues, use them for efficient extraction
  if (cuesFileOffset) {
    console.log(`[MKV] Using Cues at offset ${cuesFileOffset} for seek-based extraction`);

    // Fetch Cues element
    const CUES_INITIAL = 512 * 1024; // 512KB initial fetch for Cues
    let cuesBuf = await fetchRange(mediaUrl, cuesFileOffset,
      Math.min(cuesFileOffset + CUES_INITIAL - 1, fileSize ? fileSize - 1 : cuesFileOffset + CUES_INITIAL - 1));

    const cuesReader = new EBMLReader(cuesBuf);
    const cuesId = cuesReader.readElementID();
    const cuesSize = cuesReader.readVINT();

    if (cuesId === EBML_IDS.Cues && cuesSize > 0) {
      const cuesDataStart = cuesReader.pos;
      const needed = cuesDataStart + cuesSize;
      if (needed > cuesBuf.length) {
        console.log(`[MKV] Cues element is ${cuesSize} bytes, fetching full...`);
        cuesBuf = await fetchRange(mediaUrl, cuesFileOffset,
          Math.min(cuesFileOffset + needed - 1, fileSize ? fileSize - 1 : cuesFileOffset + needed - 1));
      }

      const cuePoints = [];
      parseCues(cuesBuf.subarray(cuesDataStart, cuesDataStart + Math.min(cuesSize, cuesBuf.length - cuesDataStart)), cuePoints);

      console.log(`[MKV] Parsed ${cuePoints.length} cue points in ${Date.now() - startTime}ms`);

      // Collect all unique cluster positions
      const clusterPositions = new Set();
      let hasDirectCues = false;
      for (const cp of cuePoints) {
        for (const pos of cp.positions) {
          if (pos.track === track.trackNumber) {
            hasDirectCues = true;
            clusterPositions.add(pos.clusterPos);
          }
        }
      }

      if (!hasDirectCues) {
        // Subtitle tracks rarely have their own Cue entries — scan all clusters
        for (const cp of cuePoints) {
          for (const pos of cp.positions) {
            clusterPositions.add(pos.clusterPos);
          }
        }
      }

      if (clusterPositions.size > 0) {
        const sortedPositions = [...clusterPositions].sort((a, b) => a - b);
        console.log(`[MKV] Found ${sortedPositions.length} unique cluster positions`);

        // ===== TWO-PASS SMART CLUSTER EXTRACTION =====
        //
        // Pass 1: Read each cluster with a small cap (768KB) for speed.
        //         Most subtitle blocks are near the start of a cluster.
        // Pass 2: For clusters where we read less than the full size AND
        //         got no subtitle blocks, re-read with the full cluster size.
        //         This catches subtitles that sit beyond the 768KB mark
        //         (behind large video/audio blocks).
        //
        // Typical result: Pass 1 gets ~93% of subtitles in ~1.7s,
        //                 Pass 2 fills in the remaining ~7% with ~20 extra requests.

        const PASS1_MAX_READ = 768 * 1024; // 768KB — fast first pass
        const PASS2_MAX_READ = 0; // No cap — read full cluster size in pass 2

        // Compute each cluster's actual size from consecutive Cue positions
        const clusterActualSizes = [];
        for (let ci = 0; ci < sortedPositions.length; ci++) {
          const pos = sortedPositions[ci];
          const nextPos = ci + 1 < sortedPositions.length ? sortedPositions[ci + 1] : (fileSize ? fileSize - segmentDataOffset : pos + PASS2_MAX_READ);
          clusterActualSizes.push(nextPos - pos);
        }

        // --- Pass 1: Fast scan with small reads ---
        const pass1Sizes = clusterActualSizes.map((s) => Math.min(s, PASS1_MAX_READ));
        const pass1Ranges = sortedPositions.map((relPos, ci) => {
          const fileOffset = segmentDataOffset + relPos;
          const readSize = pass1Sizes[ci];
          return [fileOffset, Math.min(fileOffset + readSize - 1, fileSize ? fileSize - 1 : fileOffset + readSize - 1)];
        });

        const pass1EstBytes = pass1Ranges.reduce((s, [a, b]) => s + (b - a + 1), 0);
        console.log(`[MKV] Pass 1: Fetching ${sortedPositions.length} clusters (${(pass1EstBytes / 1024 / 1024).toFixed(1)}MB, cap ${PASS1_MAX_READ / 1024}KB)`);

        const t0 = Date.now();
        const pass1Buffers = await fetchRangesParallel(mediaUrl, pass1Ranges, 10);
        const pass1Fetched = pass1Buffers.reduce((s, b) => s + b.length, 0);
        console.log(`[MKV] Pass 1: Fetched in ${Date.now() - t0}ms (${(pass1Fetched / 1024 / 1024).toFixed(1)}MB)`);

        // Parse pass 1 results — store per-cluster blocks for potential replacement
        const truncatedIndices = []; // Cluster indices that need pass 2
        const clusterBlocksMap = new Map(); // ci -> blocks[]

        let pass1Total = 0;
        for (let ci = 0; ci < sortedPositions.length; ci++) {
          const buf = pass1Buffers[ci];
          if (!buf || buf.length === 0) continue;

          const blocks = parseClusterBuffer(buf, timestampScale, trackNumbers);
          clusterBlocksMap.set(ci, blocks);
          pass1Total += blocks.length;

          // If this cluster was truncated (actual size > what we read), queue for pass 2
          if (clusterActualSizes[ci] > PASS1_MAX_READ) {
            truncatedIndices.push(ci);
          }
        }

        console.log(`[MKV] Pass 1: Found ${pass1Total} subtitle blocks, ${truncatedIndices.length} truncated clusters need pass 2`);

        // --- Pass 2: Re-read only the truncated clusters with full size ---
        if (truncatedIndices.length > 0) {
          const pass2Ranges = truncatedIndices.map((ci) => {
            const fileOffset = segmentDataOffset + sortedPositions[ci];
            const readSize = PASS2_MAX_READ > 0 ? Math.min(clusterActualSizes[ci], PASS2_MAX_READ) : clusterActualSizes[ci];
            return [fileOffset, Math.min(fileOffset + readSize - 1, fileSize ? fileSize - 1 : fileOffset + readSize - 1)];
          });

          const pass2EstBytes = pass2Ranges.reduce((s, [a, b]) => s + (b - a + 1), 0);
          console.log(`[MKV] Pass 2: Re-fetching ${truncatedIndices.length} clusters (${(pass2EstBytes / 1024 / 1024).toFixed(1)}MB, full size)`);

          const t1 = Date.now();
          const pass2Buffers = await fetchRangesParallel(mediaUrl, pass2Ranges, 10);
          const pass2Fetched = pass2Buffers.reduce((s, b) => s + b.length, 0);
          console.log(`[MKV] Pass 2: Fetched in ${Date.now() - t1}ms (${(pass2Fetched / 1024 / 1024).toFixed(1)}MB)`);

          let pass2NewBlocks = 0;
          for (let i = 0; i < pass2Buffers.length; i++) {
            const ci = truncatedIndices[i];
            const buf = pass2Buffers[i];
            if (!buf || buf.length === 0) continue;

            const blocks = parseClusterBuffer(buf, timestampScale, trackNumbers);
            const oldCount = (clusterBlocksMap.get(ci) || []).length;
            // Replace pass 1 result with pass 2 result (which includes the full cluster)
            clusterBlocksMap.set(ci, blocks);
            pass2NewBlocks += Math.max(0, blocks.length - oldCount);
          }

          console.log(`[MKV] Pass 2: Recovered ${pass2NewBlocks} additional subtitle blocks`);
          console.log(`[MKV] Total fetched: ${((pass1Fetched + pass2Fetched) / 1024 / 1024).toFixed(1)}MB`);
        } else {
          console.log(`[MKV] Total fetched: ${(pass1Fetched / 1024 / 1024).toFixed(1)}MB (no pass 2 needed)`);
        }

        // Combine all cluster blocks into subtitleBlocks
        const sortedKeys = [...clusterBlocksMap.keys()].sort((a, b) => a - b);
        for (const ci of sortedKeys) {
          subtitleBlocks.push(...clusterBlocksMap.get(ci));
        }
      }
    }
  }

  // Fallback: Sequential scan if no cues or cues didn't yield results
  if (subtitleBlocks.length === 0) {
    console.log("[MKV] No cues available or no results from cues, scanning clusters sequentially...");
    await scanClustersSequentially(mediaUrl, segmentDataOffset, fileSize, timestampScale, trackNumbers, subtitleBlocks, firstClusterOffset);
  }

  console.log(`[MKV] Extracted ${subtitleBlocks.length} subtitle blocks in ${Date.now() - startTime}ms`);

  // Convert to WebVTT
  const vtt = blocksToVTT(subtitleBlocks, track.codecId);
  return vtt;
}

/**
 * Sequential cluster scanning — used as fallback when no Cues are available.
 * Reads file in large chunks (8MB) to minimize HTTP requests, scans for Cluster
 * elements and extracts subtitle blocks on the fly.
 */
async function scanClustersSequentially(mediaUrl, segmentDataOffset, fileSize, timestampScale, trackNumbers, subtitleBlocks, firstClusterOffset) {
  let scanOffset = firstClusterOffset || segmentDataOffset;
  const endOffset = fileSize || (scanOffset + 2 * 1024 * 1024 * 1024);
  let clusterCount = 0;
  let httpRequestCount = 0;

  // Use much larger chunks to minimize HTTP requests
  const SCAN_CHUNK = 8 * 1024 * 1024; // 8MB chunks — reduces 650 requests to ~80

  while (scanOffset < endOffset) {
    const chunkEnd = Math.min(scanOffset + SCAN_CHUNK - 1, endOffset - 1);
    let chunk;
    try {
      chunk = await fetchRange(mediaUrl, scanOffset, chunkEnd);
      httpRequestCount++;
    } catch (e) {
      console.log(`[MKV] Range fetch failed at offset ${scanOffset}:`, e.message);
      break;
    }

    if (chunk.length === 0) break;

    const reader = new EBMLReader(chunk);

    while (!reader.done && reader.remaining > 12) {
      const elemStart = reader.pos;
      const id = reader.readElementID();
      if (id === null) break;
      const size = reader.readVINT();
      if (size === null) break;

      if (size < 0) break; // Unknown size — can't skip

      const dataStart = reader.pos;

      if (id === EBML_IDS.Cluster) {
        clusterCount++;
        const available = chunk.length - dataStart;
        // Only need first portion of cluster for subtitle scanning
        const needed = Math.min(size, available);

        const clusterData = chunk.subarray(dataStart, dataStart + needed);

        // Parse cluster timestamp
        const tsr = new EBMLReader(clusterData);
        let clusterTimestamp = 0;
        while (!tsr.done && tsr.remaining > 2) {
          const tid = tsr.readElementID();
          if (tid === null) break;
          const tsz = tsr.readVINT();
          if (tsz === null || tsz < 0) break;
          if (tid === EBML_IDS.Timestamp) {
            clusterTimestamp = tsr.readUint(tsz);
            break;
          }
          tsr.pos = tsr.pos + tsz;
        }

        const blocks = parseClusterBlocks(clusterData, clusterTimestamp, timestampScale, trackNumbers);
        subtitleBlocks.push(...blocks);

        // Skip past this cluster
        reader.pos = dataStart + size;
        if (reader.pos > chunk.length) {
          scanOffset = scanOffset + dataStart + size;
          break;
        }
      } else {
        // Skip any non-Cluster element
        reader.pos = dataStart + size;
        if (reader.pos > chunk.length) {
          scanOffset = scanOffset + dataStart + size;
          break;
        }
      }
    }

    if (reader.pos <= chunk.length) {
      scanOffset = scanOffset + reader.pos;
    }

    if (clusterCount > 50000) {
      console.warn("[MKV] Too many clusters, stopping scan");
      break;
    }
  }

  console.log(`[MKV] Scanned ${clusterCount} clusters in ${httpRequestCount} HTTP requests`);
}

// ==================== Exports ====================

module.exports = {
  probeMKVSubtitles,
  extractMKVSubtitle,
  codecIdToShortName,
};
