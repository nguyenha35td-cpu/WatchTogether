/**
 * MKV (Matroska) Subtitle Probe — HTTP Range based
 *
 * Probes subtitle track metadata from remote MKV files using HTTP Range requests.
 * Only downloads the MKV header (~512KB) to discover subtitle tracks (codec, language, etc.)
 *
 * Actual subtitle extraction is handled by ffmpeg (see server/index.js).
 */

"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");

// HTTP keep-alive agents — reuse TCP/TLS connections across Range requests
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000 });

// ==================== EBML Element IDs ====================

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
};

const TRACK_TYPE_SUBTITLE = 0x11; // 17

// ==================== HTTP Range Fetcher ====================

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
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          return fetchRange(res.headers.location, start, end, redirectCount + 1)
            .then(resolve)
            .catch(reject);
        }

        if (res.statusCode !== 206 && res.statusCode !== 200) {
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

  readVINT() {
    if (this.pos >= this.buf.length) return null;
    const first = this.buf[this.pos];
    let len, mask;
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

    let allOnes = mask;
    for (let i = 1; i < len; i++) allOnes = allOnes * 256 + 0xff;
    if (value === allOnes) return -1;

    return value;
  }

  readUint(len) {
    if (this.pos + len > this.buf.length) return 0;
    let val = 0;
    for (let i = 0; i < len; i++) {
      val = val * 256 + this.buf[this.pos + i];
    }
    this.pos += len;
    return val;
  }

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

  readString(len) {
    const str = this.buf.toString("utf-8", this.pos, this.pos + len).replace(/\0+$/, "");
    this.pos += len;
    return str;
  }

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

function parseSegmentChildren(buf) {
  const reader = new EBMLReader(buf, 0);
  const seekHeadEntries = [];
  let timestampScale = 1000000;
  let durationFloat = 0;
  const trackEntries = [];

  while (!reader.done && reader.remaining > 2) {
    const id = reader.readElementID();
    if (id === null) break;
    const size = reader.readVINT();
    if (size === null) break;
    const dataStart = reader.pos;

    if (size < 0) break;
    if (dataStart + size > buf.length) break;

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
      case EBML_IDS.Cluster:
        // Hit Clusters; stop scanning metadata
        reader.pos = dataStart + size;
        continue;
      default:
        break;
    }

    reader.pos = dataStart + size;
  }

  return { seekHeadEntries, timestampScale, durationFloat, trackEntries };
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

// ==================== Codec ID Helper ====================

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

// ==================== Main Probe Function ====================

/**
 * Probe subtitle tracks from a remote MKV URL.
 * Only downloads the first ~512KB to find EBML header, Tracks, and SeekHead.
 *
 * Returns: { tracks: SubtitleTrackInfo[] }
 */
async function probeMKVSubtitles(mediaUrl) {
  console.log("[MKV] Probing subtitles from:", mediaUrl.substring(0, 100) + "...");
  const startTime = Date.now();

  const INITIAL_FETCH = 512 * 1024;
  let fileSize;
  try {
    fileSize = await getFileSize(mediaUrl);
  } catch (e) {
    console.error("[MKV] Failed to get file size:", e.message);
    fileSize = 0;
  }

  const endByte = Math.min(INITIAL_FETCH - 1, fileSize ? fileSize - 1 : INITIAL_FETCH - 1);
  const headerBuf = await fetchRange(mediaUrl, 0, endByte);
  console.log(`[MKV] Fetched initial ${headerBuf.length} bytes in ${Date.now() - startTime}ms`);

  // Parse EBML header
  const ebmlReader = new EBMLReader(headerBuf);
  const ebmlId = ebmlReader.readElementID();
  if (ebmlId !== EBML_IDS.EBML) {
    throw new Error("Not a valid EBML/MKV file (bad EBML header)");
  }
  const ebmlSize = ebmlReader.readVINT();
  ebmlReader.skip(ebmlSize);

  // Parse Segment header
  const segId = ebmlReader.readElementID();
  if (segId !== EBML_IDS.Segment) {
    throw new Error("Not a valid MKV file (no Segment element)");
  }
  ebmlReader.readVINT(); // segment size
  const segmentDataOffset = ebmlReader.pos;

  // Parse Segment children from initial buffer
  const segBuf = headerBuf.subarray(segmentDataOffset);
  const parsed = parseSegmentChildren(segBuf);

  // If we didn't find Tracks in the initial fetch, look in SeekHead
  if (parsed.trackEntries.length === 0 && parsed.seekHeadEntries.length > 0) {
    const tracksSeek = parsed.seekHeadEntries.find((e) => e.id === EBML_IDS.Tracks);
    if (tracksSeek) {
      const tracksFileOffset = segmentDataOffset + tracksSeek.position;
      console.log(`[MKV] Tracks element at file offset ${tracksFileOffset}, fetching...`);
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
      hasContentEncodings: t.hasContentEncodings,
    }));

  console.log(`[MKV] Found ${subtitleTracks.length} subtitle tracks in ${Date.now() - startTime}ms`);
  subtitleTracks.forEach((t) => {
    console.log(`  Track #${t.trackNumber}: ${t.codecId} [${t.language}] "${t.title}"`);
  });

  return { tracks: subtitleTracks };
}

// ==================== Exports ====================

module.exports = {
  probeMKVSubtitles,
  codecIdToShortName,
};
