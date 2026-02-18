const EMOJI_LIST = ["😀", "😂", "😎", "🥳", "😭", "❤️", "👍", "🔥", "👀", "🎉"];
const FULLSCREEN_DANMAKU_AUTO_HIDE_MS = 9000;
const BLOCKED_SYNC_SEEK_INTERVAL_MS = 1800;
const SW_VERSION = "20260216-v3";

const state = {
  socket: null,
  connected: false,
  joined: false,
  roomId: "",
  nickname: "",
  selfId: "",
  controllerId: "",
  members: [],
  rootFolderId: "-1",
  folderStack: [],
  media: null,
  pendingSync: null,
  syncDriftThreshold: 0.4,
  blockLocalUntil: 0,
  draggingProgress: false,
  heartbeatTimer: null,
  danmakuTracks: [],
  sourceCandidates: [],
  sourceIndex: 0,
  sourceTypeCache: {},
  dp: null,
  mpegtsPlayer: null,
  playerReady: false,
  autoPlayBlocked: false,
  blockedSyncSeekAt: 0,
  syncPlayTask: null,
  fullscreenBarTimer: null,
  playerFullscreen: false,
  isMobile: false,
  isIOS: false,
  iosInlineFullscreen: false,
  serviceWorkerReady: false,
  fullscreenDanmakuPlugin: null,
  directRecoverAttempted: false,
  sourceRecovering: false,
  playMode: "signed-header",
  transportDragging: false,
  lockedDuration: 0,
  durationProbeTask: null,
  mpegtsTimelineOffset: 0,
  mobileTab: "player"
};
if (typeof window !== "undefined") {
  window.__vo_state = state;
}

const refs = {
  roomApp: document.getElementById("roomApp"),
  roomTitle: document.getElementById("roomTitle"),
  roomSubtitle: document.getElementById("roomSubtitle"),
  backLobbyBtn: document.getElementById("backLobbyBtn"),
  claimBtn: document.getElementById("claimBtn"),
  leaveBtn: document.getElementById("leaveBtn"),
  connectState: document.getElementById("connectState"),
  controllerState: document.getElementById("controllerState"),
  refreshFolderBtn: document.getElementById("refreshFolderBtn"),
  backFolderBtn: document.getElementById("backFolderBtn"),
  folderPathText: document.getElementById("folderPathText"),
  fileList: document.getElementById("fileList"),
  videoStage: document.getElementById("videoStage"),
  dplayerContainer: document.getElementById("dplayerContainer"),
  danmakuLayer: document.getElementById("danmakuLayer"),
  playerOverlayHint: document.getElementById("playerOverlayHint"),
  seekBackBtn: document.getElementById("seekBackBtn"),
  timeLabel: document.getElementById("timeLabel"),
  seekRange: document.getElementById("seekRange"),
  seekForwardBtn: document.getElementById("seekForwardBtn"),
  sendDanmakuBtn: document.getElementById("sendDanmakuBtn"),
  danmakuColorInput: document.getElementById("danmakuColorInput"),
  danmakuInput: document.getElementById("danmakuInput"),
  fullscreenBtn: document.getElementById("fullscreenBtn"),
  syncHint: document.getElementById("syncHint"),
  memberCount: document.getElementById("memberCount"),
  memberList: document.getElementById("memberList"),
  chatList: document.getElementById("chatList"),
  emojiRow: document.getElementById("emojiRow"),
  chatInput: document.getElementById("chatInput"),
  chatSendBtn: document.getElementById("chatSendBtn"),
  mobileTabs: Array.from(document.querySelectorAll("[data-mobile-tab-btn]"))
};

function nowMs() {
  return Date.now();
}

function setHint(text) {
  refs.syncHint.textContent = String(text || "");
}

function withLocalBlock(fn) {
  state.blockLocalUntil = performance.now() + 420;
  fn();
}

function isController() {
  return Boolean(state.selfId && state.controllerId && state.selfId === state.controllerId);
}

function isMobileClient() {
  const ua = navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|MiuiBrowser/i.test(ua) || navigator.maxTouchPoints > 1;
}

function isIOSClient() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (/iPhone|iPad|iPod/i.test(platform)) return true;
  // iPadOS 13+ may report itself as Macintosh with touch points
  return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
}

function getQueryParam(name) {
  return new URLSearchParams(location.search).get(name) || "";
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function generateRandomNickname() {
  const prefix = ["星河", "晚风", "柠檬", "山海", "橘猫", "浮光", "灯塔", "云雀", "青柠", "轻舟"];
  const suffix = ["同学", "队友", "观众", "影迷", "旅人", "玩家", "学者", "老师"];
  return `${randomFrom(prefix)}${randomFrom(suffix)}${Math.floor(Math.random() * 90 + 10)}`;
}

function formatBytes(bytes) {
  const num = Number(bytes || 0);
  if (!Number.isFinite(num) || num <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = num;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatClock(seconds = 0) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) {
    return "00:00";
  }
  const whole = Math.floor(value);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function lockDuration(seconds, force = false) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0) return false;
  if (!force && Number(state.lockedDuration || 0) > 0) return false;
  state.lockedDuration = value;
  if (state.media) {
    state.media = {
      ...state.media,
      duration: value
    };
  }
  return true;
}

function getDirectBridgeUrl(fileId) {
  const key = String(fileId || "").trim();
  if (!key) return "";
  return `/s3-direct/${encodeURIComponent(key)}`;
}

function getSourceType(video = state.dp?.video) {
  return String(video?.dataset?.sourceType || "");
}

function getMpegtsTimelineOffsetFromSource(sourceUrl) {
  const raw = String(sourceUrl || "").trim();
  if (!raw) return 0;
  try {
    const parsed = new URL(raw, location.origin);
    const at = Number(parsed.searchParams.get("_at") || 0);
    return Number.isFinite(at) && at > 0 ? at : 0;
  } catch {
    return 0;
  }
}

function syncMpegtsTimelineOffset(sourceUrl, sourceType) {
  if (String(sourceType || "") !== "mpegts") {
    state.mpegtsTimelineOffset = 0;
    return;
  }
  state.mpegtsTimelineOffset = getMpegtsTimelineOffsetFromSource(sourceUrl);
}

function getPlaybackCurrentTime(video = state.dp?.video) {
  const raw = Number(video?.currentTime || 0);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  if (getSourceType(video) !== "mpegts") return raw;
  const offset = Number(state.mpegtsTimelineOffset || 0);
  if (!Number.isFinite(offset) || offset <= 0) return raw;
  return Math.max(0, raw + offset);
}

function buildMpegtsSeekSource(targetTime, duration) {
  const total = Number(state.media?.contentLength || 0);
  const fileId = String(state.media?.fileId || "").trim();
  if (!(duration > 0) || !(total > 0) || !fileId) return "";

  const ratio = Math.max(0, Math.min(0.9995, Number(targetTime || 0) / duration));
  const safeTail = Math.min(total, 188 * 8192);
  const maxStart = Math.max(0, total - safeTail);

  let start = Math.floor(total * ratio);
  start = Math.max(0, Math.min(start, maxStart));
  start = Math.floor(start / 188) * 188;

  const baseUrl = getDirectBridgeUrl(fileId);
  if (!baseUrl) return "";
  try {
    const parsed = new URL(baseUrl, location.origin);
    parsed.searchParams.set("_start", String(start));
    parsed.searchParams.set("_at", String(Math.max(0, Number(targetTime || 0))));
    parsed.searchParams.set("_seek", String(Date.now()));
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "";
  }
}

function seekMpegtsBySourceReload(targetTime, keepPlaying, shouldEmit, reason = "seek") {
  if (!state.dp) return false;
  const duration = getPlayableDuration(state.dp.video);
  const seekSource = buildMpegtsSeekSource(targetTime, duration);
  if (!seekSource) return false;

  state.mpegtsTimelineOffset = Math.max(0, Number(targetTime || 0));
  if (!shouldEmit) {
    state.blockLocalUntil = performance.now() + 2600;
  }

  withLocalBlock(() => {
    destroyMpegtsPlayer();
    state.dp.switchVideo({
      url: seekSource,
      type: "mpegts"
    });
    state.dp.video.dataset.sourceType = "mpegts";
  });

  state.playerReady = false;
  updateTransportControls(Number(targetTime || 0));
  if (keepPlaying) {
    requestPlayWithFallback(false).catch(() => {});
  } else {
    state.dp.pause();
  }
  if (shouldEmit) {
    emitSync(reason);
  }
  return true;
}

function findTsSyncOffset(bytes) {
  const size = Number(bytes?.length || 0);
  if (size < 188) return -1;
  for (let offset = 0; offset < 188 && offset < size; offset += 1) {
    if (bytes[offset] !== 0x47) continue;
    const p2 = offset + 188;
    const p3 = offset + 376;
    if (p2 < size && bytes[p2] !== 0x47) continue;
    if (p3 < size && bytes[p3] !== 0x47) continue;
    return offset;
  }
  return -1;
}

function collectTsPcrSamples(bytes) {
  const syncOffset = findTsSyncOffset(bytes);
  if (syncOffset < 0) return [];
  const list = [];
  for (let pos = syncOffset; pos + 188 <= bytes.length; pos += 188) {
    if (bytes[pos] !== 0x47) continue;
    const pid = ((bytes[pos + 1] & 0x1f) << 8) | bytes[pos + 2];
    const afc = (bytes[pos + 3] >> 4) & 0x03;
    if (afc !== 2 && afc !== 3) continue;
    const adaptationLength = bytes[pos + 4];
    if (adaptationLength < 7) continue;
    if (pos + 5 + adaptationLength > pos + 187) continue;
    const flags = bytes[pos + 5];
    if ((flags & 0x10) === 0) continue;

    const b0 = bytes[pos + 6];
    const b1 = bytes[pos + 7];
    const b2 = bytes[pos + 8];
    const b3 = bytes[pos + 9];
    const b4 = bytes[pos + 10];
    const base =
      (BigInt(b0) << 25n) |
      (BigInt(b1) << 17n) |
      (BigInt(b2) << 9n) |
      (BigInt(b3) << 1n) |
      (BigInt(b4 >> 7) & 0x01n);
    list.push({ pid, base });
  }
  return list;
}

function collectTsPtsSamples(bytes) {
  const syncOffset = findTsSyncOffset(bytes);
  if (syncOffset < 0) return [];
  const list = [];
  for (let pos = syncOffset; pos + 188 <= bytes.length; pos += 188) {
    if (bytes[pos] !== 0x47) continue;
    const pusi = (bytes[pos + 1] & 0x40) !== 0;
    if (!pusi) continue;
    const pid = ((bytes[pos + 1] & 0x1f) << 8) | bytes[pos + 2];
    const afc = (bytes[pos + 3] >> 4) & 0x03;
    if (afc === 0 || afc === 2) continue;

    let payloadStart = pos + 4;
    if (afc === 3) {
      const adaptationLength = bytes[pos + 4];
      payloadStart = pos + 5 + adaptationLength;
    }
    if (payloadStart + 14 > pos + 188) continue;
    if (bytes[payloadStart] !== 0x00 || bytes[payloadStart + 1] !== 0x00 || bytes[payloadStart + 2] !== 0x01) {
      continue;
    }

    const ptsDtsFlags = bytes[payloadStart + 7] & 0xc0;
    if ((ptsDtsFlags & 0x80) === 0) continue;
    const ptsStart = payloadStart + 9;
    if (ptsStart + 5 > pos + 188) continue;
    const b0 = bytes[ptsStart];
    const b1 = bytes[ptsStart + 1];
    const b2 = bytes[ptsStart + 2];
    const b3 = bytes[ptsStart + 3];
    const b4 = bytes[ptsStart + 4];
    const pts =
      (BigInt((b0 & 0x0e) >> 1) << 30n) |
      (BigInt(b1) << 22n) |
      (BigInt((b2 & 0xfe) >> 1) << 15n) |
      (BigInt(b3) << 7n) |
      BigInt((b4 & 0xfe) >> 1);
    list.push({ pid, pts });
  }
  return list;
}

async function fetchRangeBuffer(url, start, end) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Range: `bytes=${start}-${end}`
    },
    mode: "cors",
    credentials: "omit",
    cache: "no-store"
  });
  if (!(response.ok || response.status === 206)) {
    throw new Error(`range request failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function estimateTsDurationByPcr(url, contentLength) {
  const total = Number(contentLength || 0);
  if (!(total > 188 * 4)) {
    return 0;
  }
  const windowSize = Math.min(2 * 1024 * 1024, total);
  const headEnd = Math.min(total - 1, windowSize - 1);
  const tailStart = Math.max(0, total - windowSize);

  const [headBytes, tailBytes] = await Promise.all([
    fetchRangeBuffer(url, 0, headEnd),
    fetchRangeBuffer(url, tailStart, total - 1)
  ]);
  const headPcr = collectTsPcrSamples(headBytes);
  const tailPcr = collectTsPcrSamples(tailBytes);
  if (!headPcr.length || !tailPcr.length) {
    return 0;
  }

  const headPidCount = new Map();
  const tailPidCount = new Map();
  for (const sample of headPcr) {
    headPidCount.set(sample.pid, (headPidCount.get(sample.pid) || 0) + 1);
  }
  for (const sample of tailPcr) {
    tailPidCount.set(sample.pid, (tailPidCount.get(sample.pid) || 0) + 1);
  }

  let selectedPid = -1;
  let selectedScore = -1;
  for (const [pid, headCount] of headPidCount.entries()) {
    const tailCount = tailPidCount.get(pid) || 0;
    if (tailCount <= 0) continue;
    const score = headCount + tailCount;
    if (score > selectedScore) {
      selectedScore = score;
      selectedPid = pid;
    }
  }

  let first = null;
  let last = null;
  if (selectedPid >= 0) {
    for (const sample of headPcr) {
      if (sample.pid === selectedPid) {
        first = sample.base;
        break;
      }
    }
    for (let i = tailPcr.length - 1; i >= 0; i -= 1) {
      const sample = tailPcr[i];
      if (sample.pid === selectedPid) {
        last = sample.base;
        break;
      }
    }
  }
  if (first == null || last == null) {
    first = headPcr[0].base;
    last = tailPcr[tailPcr.length - 1].base;
  }

  const pcrMod = 1n << 33n;
  let diff = last - first;
  if (diff < 0n) {
    diff += pcrMod;
  }
  if (diff <= 0n) return 0;
  const duration = Number(diff) / 90000;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return duration;
}

async function estimateTsDurationByPts(url, contentLength) {
  const total = Number(contentLength || 0);
  if (!(total > 188 * 8)) {
    return 0;
  }
  const windowSize = Math.min(3 * 1024 * 1024, total);
  const headEnd = Math.min(total - 1, windowSize - 1);
  const tailStart = Math.max(0, total - windowSize);

  const [headBytes, tailBytes] = await Promise.all([
    fetchRangeBuffer(url, 0, headEnd),
    fetchRangeBuffer(url, tailStart, total - 1)
  ]);
  const headPts = collectTsPtsSamples(headBytes);
  const tailPts = collectTsPtsSamples(tailBytes);
  if (!headPts.length || !tailPts.length) return 0;

  const headPidCount = new Map();
  const tailPidCount = new Map();
  for (const sample of headPts) {
    headPidCount.set(sample.pid, (headPidCount.get(sample.pid) || 0) + 1);
  }
  for (const sample of tailPts) {
    tailPidCount.set(sample.pid, (tailPidCount.get(sample.pid) || 0) + 1);
  }

  let selectedPid = -1;
  let selectedScore = -1;
  for (const [pid, headCount] of headPidCount.entries()) {
    const tailCount = tailPidCount.get(pid) || 0;
    if (tailCount <= 0) continue;
    const score = headCount + tailCount;
    if (score > selectedScore) {
      selectedScore = score;
      selectedPid = pid;
    }
  }
  if (selectedPid < 0) return 0;

  let first = null;
  let last = null;
  for (const sample of headPts) {
    if (sample.pid === selectedPid) {
      first = sample.pts;
      break;
    }
  }
  for (let i = tailPts.length - 1; i >= 0; i -= 1) {
    const sample = tailPts[i];
    if (sample.pid === selectedPid) {
      last = sample.pts;
      break;
    }
  }
  if (first == null || last == null) return 0;

  const mod = 1n << 33n;
  let diff = last - first;
  if (diff < 0n) diff += mod;
  if (diff <= 0n) return 0;
  const duration = Number(diff) / 90000;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return duration;
}

function probeLockedDurationForMpegts() {
  if (Number(state.lockedDuration || 0) > 0) return;
  if (state.durationProbeTask) return;
  const fileId = String(state.media?.fileId || "").trim();
  const contentLength = Number(state.media?.contentLength || 0);
  if (!fileId || !(contentLength > 0)) return;
  const directUrl = getDirectBridgeUrl(fileId);
  if (!directUrl) return;

  state.durationProbeTask = (async () => {
    try {
      if (!state.serviceWorkerReady) {
        await ensureDirectS3Bridge();
      }
      let estimated = await estimateTsDurationByPts(directUrl, contentLength);
      if (!(estimated > 0)) {
        estimated = await estimateTsDurationByPcr(directUrl, contentLength);
      }
      if (estimated > 0 && lockDuration(estimated, false)) {
        updateTransportControls();
      }
    } catch {
      // ignore duration probe failure
    } finally {
      state.durationProbeTask = null;
    }
  })();
}

function getPlayableDuration(video = state.dp?.video) {
  const locked = Number(state.lockedDuration || 0);
  if (Number.isFinite(locked) && locked > 0) {
    return locked;
  }
  if (!video) {
    const mediaDuration = Number(state.media?.duration || 0);
    return Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : 0;
  }
  const nativeDuration = Number(video.duration || 0);
  if (Number.isFinite(nativeDuration) && nativeDuration > 0) {
    return nativeDuration;
  }
  const mediaDuration = Number(state.media?.duration || 0);
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
  return mediaDuration;
}

function updateDPlayerTimeline(currentTime, duration) {
  const container = state.dp?.container;
  if (!container) return;
  const ptime = container.querySelector(".dplayer-ptime");
  const dtime = container.querySelector(".dplayer-dtime");
  if (ptime) {
    ptime.textContent = formatClock(currentTime);
  }
  if (dtime) {
    dtime.textContent = duration > 0 ? formatClock(duration) : "--:--";
  }
  if (duration > 0) {
    const percent = Math.max(0, Math.min(100, (currentTime / duration) * 100));
    const played = container.querySelector(".dplayer-played");
    if (played) {
      played.style.width = `${percent}%`;
    }
  }
}

function updateTransportControls(previewTime = null) {
  const video = state.dp?.video;
  const duration = getPlayableDuration(video);
  const currentTime = getPlaybackCurrentTime(video);
  const shownCurrent = previewTime == null ? currentTime : Number(previewTime || 0);

  const currentText = formatClock(shownCurrent);
  const durationText = duration > 0 ? formatClock(duration) : "--:--";
  refs.timeLabel.textContent = `${currentText} / ${durationText}`;
  if (!state.transportDragging) {
    if (duration > 0) {
      const ratio = Math.max(0, Math.min(1, currentTime / duration));
      refs.seekRange.value = String(Math.round(ratio * 1000));
    } else {
      refs.seekRange.value = "0";
    }
  }
  refs.seekRange.disabled = !(duration > 0);
  updateDPlayerTimeline(currentTime, duration);
}

function seekTo(targetTime, reason = "seek") {
  if (!state.dp?.video) return;
  const video = state.dp.video;
  const duration = getPlayableDuration(video);
  let nextTime = Number(targetTime || 0);
  if (!Number.isFinite(nextTime)) return;
  nextTime = Math.max(0, nextTime);
  if (duration > 0) {
    nextTime = Math.min(nextTime, Math.max(0, duration - 0.05));
  }

  withLocalBlock(() => {
    const nativeDuration = Number(video.duration || 0);
    const sourceType = getSourceType(video);
    const forceNativeSeek = sourceType === "mpegts" || !(Number.isFinite(nativeDuration) && nativeDuration > 0);
    if (forceNativeSeek) {
      if (sourceType === "mpegts") {
        const keepPlaying = !video.paused;
        if (seekMpegtsBySourceReload(nextTime, keepPlaying, true, reason)) {
          return;
        }
      }
      seekMpegtsTarget(video, nextTime);
      return;
    }
    try {
      state.dp.seek(nextTime);
    } catch {
      seekMpegtsTarget(video, nextTime);
    }
  });
  updateTransportControls();
  emitSync(reason);
}

function seekBy(deltaSeconds) {
  const current = getPlaybackCurrentTime(state.dp?.video);
  seekTo(current + Number(deltaSeconds || 0), "seek");
}

function seekMpegtsTarget(video, targetTime) {
  if (state.mpegtsPlayer) {
    try {
      state.mpegtsPlayer.currentTime = targetTime;
      return;
    } catch {
      // ignore and fallback
    }
  }
  video.currentTime = targetTime;
}

function bindDPlayerTimelineFallback() {
  const container = state.dp?.container;
  if (!container || container.dataset.timelineBound === "1") return;
  const barWrap = container.querySelector(".dplayer-bar-wrap");
  if (!barWrap) return;
  const onClick = (event) => {
    const video = state.dp?.video;
    if (!video) return;
    const nativeDuration = Number(video.duration || 0);
    if (Number.isFinite(nativeDuration) && nativeDuration > 0) {
      return;
    }
    const duration = getPlayableDuration(video);
    if (!(duration > 0)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = barWrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seekTo(duration * ratio, "seek");
  };
  barWrap.addEventListener("click", onClick, true);
  container.dataset.timelineBound = "1";
}

function guessVideoType(url) {
  const raw = String(url || "").toLowerCase();
  if (raw.includes(".m3u8")) return "hls";
  if (raw.includes(".flv")) return "flv";
  return "auto";
}

function destroyMpegtsPlayer() {
  if (!state.mpegtsPlayer) return;
  try {
    state.mpegtsPlayer.pause();
  } catch {
    // ignore
  }
  try {
    state.mpegtsPlayer.unload();
  } catch {
    // ignore
  }
  try {
    state.mpegtsPlayer.detachMediaElement();
  } catch {
    // ignore
  }
  try {
    state.mpegtsPlayer.destroy();
  } catch {
    // ignore
  }
  state.mpegtsPlayer = null;
}

async function probeSourceType(url) {
  const raw = String(url || "");
  const normalized = raw.toLowerCase();
  if (!raw) return "auto";
  if (normalized.includes(".m3u8")) return "hls";
  if (normalized.includes(".flv")) return "flv";
  try {
    const response = await fetch(raw, {
      method: "GET",
      headers: {
        Range: "bytes=0-511"
      },
      credentials: "omit",
      mode: "cors"
    });
    if (!response.ok) return "auto";
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length >= 376 && bytes[0] === 0x47 && bytes[188] === 0x47) {
      return "mpegts";
    }
    if (bytes.length >= 3 && bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56) {
      return "flv";
    }
    if (bytes.length >= 7) {
      const text = new TextDecoder().decode(bytes.slice(0, 64));
      if (text.includes("#EXTM3U")) return "hls";
    }
  } catch {
    // ignore probe error and fallback to auto
  }
  return "auto";
}

async function resolveSourceType(url) {
  const key = String(url || "").trim();
  if (!key) return "auto";
  if (state.sourceTypeCache[key]) {
    return state.sourceTypeCache[key];
  }
  const detected = await probeSourceType(key);
  state.sourceTypeCache[key] = detected;
  return detected;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    throw new Error(json.message || `请求失败: ${response.status}`);
  }
  return json;
}

function waitForController(timeoutMs = 5000) {
  if (navigator.serviceWorker?.controller) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(Boolean(navigator.serviceWorker?.controller));
    }, timeoutMs);
    const onChange = () => {
      cleanup();
      resolve(Boolean(navigator.serviceWorker?.controller));
    };
    const cleanup = () => {
      clearTimeout(timer);
      navigator.serviceWorker?.removeEventListener?.("controllerchange", onChange);
    };
    navigator.serviceWorker?.addEventListener?.("controllerchange", onChange, { once: true });
  });
}

async function ensureDirectS3Bridge(forceUpdate = false) {
  if (!("serviceWorker" in navigator)) {
    throw new Error("当前浏览器不支持 Service Worker，无法直连 S3 播放");
  }
  const swScript = `/sw.js?v=${encodeURIComponent(SW_VERSION)}`;
  const registration = await navigator.serviceWorker.register(swScript, { scope: "/" });
  if (forceUpdate) {
    await registration.update();
  }
  registration.waiting?.postMessage?.({ type: "SKIP_WAITING" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    const ok = await waitForController(4500);
    if (!ok) {
      throw new Error("S3 直连桥初始化失败，请刷新页面重试");
    }
  }
  state.serviceWorkerReady = true;
}

function shouldUseSignedHeaderBridge() {
  return state.playMode === "signed-header";
}

function getIdentityLabel() {
  const name = String(state.nickname || "匿名用户");
  const role = isController() ? "主控" : "成员";
  return `${name} · ${role}`;
}

function getFullscreenDanmakuPlugin() {
  return state.fullscreenDanmakuPlugin;
}

function getFullscreenPluginMountTarget() {
  return state.dp?.container || refs.dplayerContainer || refs.videoStage;
}

function getDPlayerRightControlContainer() {
  return (
    state.dp?.container?.querySelector?.(".dplayer-icons.dplayer-icons-right") ||
    state.dp?.container?.querySelector?.(".dplayer-icons-right") ||
    null
  );
}

function ensureFullscreenDanmakuPlugin() {
  if (state.fullscreenDanmakuPlugin) {
    const mountTarget = getFullscreenPluginMountTarget();
    if (mountTarget && state.fullscreenDanmakuPlugin.root.parentElement !== mountTarget) {
      mountTarget.appendChild(state.fullscreenDanmakuPlugin.root);
    }
    const rightControls = getDPlayerRightControlContainer();
    if (rightControls && state.fullscreenDanmakuPlugin.toggleBtn?.parentElement !== rightControls) {
      rightControls.appendChild(state.fullscreenDanmakuPlugin.toggleBtn);
    }
    return state.fullscreenDanmakuPlugin;
  }
  const root = document.createElement("div");
  root.className = "dplayer-danmaku-plugin-bar hidden";
  root.innerHTML = `
    <span class="dplayer-danmaku-plugin-identity"></span>
    <input type="text" maxlength="80" placeholder="全屏弹幕输入..." />
    <button type="button" class="btn primary">发送</button>
    <button type="button" class="btn ghost">退出全屏</button>
  `;

  const identity = root.querySelector(".dplayer-danmaku-plugin-identity");
  const input = root.querySelector("input");
  const sendBtn = root.querySelector(".btn.primary");
  const exitBtn = root.querySelector(".btn.ghost");

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "dplayer-icon dplayer-danmaku-plugin-toggle";
  toggleBtn.setAttribute("aria-label", "显示弹幕输入");
  toggleBtn.title = "弹幕输入";
  toggleBtn.textContent = "弹";

  const mountTarget = getFullscreenPluginMountTarget();
  mountTarget.appendChild(root);
  const rightControls = getDPlayerRightControlContainer();
  rightControls?.appendChild(toggleBtn);

  state.fullscreenDanmakuPlugin = {
    root,
    identity,
    input,
    sendBtn,
    exitBtn,
    toggleBtn
  };
  return state.fullscreenDanmakuPlugin;
}

function bindIOSFullscreenGuards(video) {
  if (!state.isIOS || !state.dp?.container || !video) return;
  const container = state.dp.container;
  if (container.dataset.iosFullscreenGuardBound === "1") return;

  const interceptClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const hit = target.closest(".dplayer-full-icon, .dplayer-full-in-icon, .dplayer-full");
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (isFullscreenMode()) {
      cancelIOSInlineFullscreen();
      return;
    }
    requestIOSInlineFullscreen();
  };

  const handleNativeFullscreenBegin = () => {
    try {
      if (typeof video.webkitExitFullscreen === "function") {
        video.webkitExitFullscreen();
      }
    } catch {
      // ignore
    }
    requestIOSInlineFullscreen();
  };

  container.addEventListener("click", interceptClick, true);
  container.addEventListener("pointerup", interceptClick, true);
  video.addEventListener("webkitbeginfullscreen", handleNativeFullscreenBegin);
  container.dataset.iosFullscreenGuardBound = "1";
}

function updateFullscreenDanmakuIdentity() {
  const plugin = getFullscreenDanmakuPlugin();
  if (!plugin?.identity) return;
  plugin.identity.textContent = getIdentityLabel();
}

function updateRoomHeader() {
  refs.roomTitle.textContent = `房间：${state.roomId || "--"}`;
  refs.roomSubtitle.textContent = state.nickname ? `当前用户：${state.nickname}` : "正在连接...";
  updateFullscreenDanmakuIdentity();
}

function updateTopStatus() {
  refs.connectState.textContent = state.connected ? "已连接" : "未连接";
  if (!state.controllerId) {
    refs.controllerState.textContent = "主控：--";
    return;
  }
  const controllerName = state.members.find((item) => item.socketId === state.controllerId)?.nickname || "未知";
  refs.controllerState.textContent = `主控：${controllerName}`;
}

function updateOverlayHint() {
  refs.playerOverlayHint.classList.toggle("hidden", Boolean(state.media?.fileId));
}

function setMobileTab(tab) {
  const nextTab = tab === "media" || tab === "chat" || tab === "player" ? tab : "player";
  state.mobileTab = nextTab;
  if (refs.roomApp) {
    refs.roomApp.dataset.mobileCurrent = nextTab;
  }
  refs.mobileTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.mobileTabBtn === nextTab);
  });
}

function initMobileTabbar() {
  if (refs.mobileTabs.length === 0) return;
  refs.mobileTabs.forEach((button) => {
    button.addEventListener("click", () => {
      const tab = String(button.dataset.mobileTabBtn || "player");
      setMobileTab(tab);
    });
  });
  setMobileTab("player");
}

function renderMembers() {
  refs.memberList.innerHTML = "";
  refs.memberCount.textContent = `在线 ${state.members.length}`;
  state.members.forEach((member) => {
    const node = document.createElement("div");
    node.className = `member-chip${member.socketId === state.controllerId ? " controller" : ""}`;
    const suffix = [];
    if (member.socketId === state.selfId) suffix.push("我");
    if (member.socketId === state.controllerId) suffix.push("主控");
    node.textContent = suffix.length > 0 ? `${member.nickname}（${suffix.join(" · ")}）` : member.nickname;
    refs.memberList.appendChild(node);
  });
  updateTopStatus();
  updateFullscreenDanmakuIdentity();
}

function appendChat(item) {
  const wrap = document.createElement("div");
  wrap.className = `chat-item${item.fromSocketId === state.selfId ? " me" : ""}`;

  const head = document.createElement("div");
  head.className = "chat-head";
  const date = new Date(item.createdAt);
  const typeLabel = item.type === "danmaku" ? "弹幕镜像" : "消息";
  head.textContent = `${item.nickname} · ${typeLabel} · ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;

  const body = document.createElement("div");
  body.className = "chat-body";
  body.textContent = item.text;

  wrap.appendChild(head);
  wrap.appendChild(body);
  refs.chatList.appendChild(wrap);
  refs.chatList.scrollTop = refs.chatList.scrollHeight;
}

function resetChat(items = []) {
  refs.chatList.innerHTML = "";
  items.forEach((item) => appendChat(item));
}

function clearDanmakuLayer() {
  refs.danmakuLayer.innerHTML = "";
  state.danmakuTracks = [];
}

function pickDanmakuTrack(trackCount, durationMs) {
  const current = performance.now();
  while (state.danmakuTracks.length < trackCount) {
    state.danmakuTracks.push(0);
  }
  let chosen = 0;
  let minValue = Number.POSITIVE_INFINITY;
  for (let i = 0; i < trackCount; i += 1) {
    const value = state.danmakuTracks[i];
    if (value <= current) {
      chosen = i;
      break;
    }
    if (value < minValue) {
      minValue = value;
      chosen = i;
    }
  }
  state.danmakuTracks[chosen] = current + durationMs * 0.72;
  return chosen;
}

function spawnDanmaku(item) {
  const layer = refs.danmakuLayer;
  if (!layer) return;
  const h = Math.max(layer.clientHeight, 160);
  const trackHeight = 34;
  const trackCount = Math.max(4, Math.floor(h / trackHeight) - 1);
  const duration = Math.max(6400, Math.min(12500, 8200 + String(item.text || "").length * 60));
  const trackIndex = pickDanmakuTrack(trackCount, duration);
  const top = 8 + trackIndex * trackHeight;

  const node = document.createElement("div");
  node.className = "danmaku-item";
  node.textContent = item.text;
  node.style.top = `${top}px`;
  node.style.color = item.color || "#ffffff";
  layer.appendChild(node);

  const startX = layer.clientWidth + 44;
  const endX = -Math.max(node.clientWidth + 60, 220);
  const anim = node.animate(
    [
      { transform: `translate3d(${startX}px, 0, 0)` },
      { transform: `translate3d(${endX}px, 0, 0)` }
    ],
    {
      duration,
      easing: "linear"
    }
  );
  anim.onfinish = () => node.remove();
}

function refreshFolderPathText() {
  const pathText = "/" + state.folderStack.map((item) => item.name).join("/");
  refs.folderPathText.textContent = pathText.replace("//", "/");
}

function currentFolder() {
  return state.folderStack[state.folderStack.length - 1] || { id: state.rootFolderId, name: "根目录" };
}

function ensurePlayer(sourceUrl = "") {
  if (state.dp) return state.dp;
  if (!window.DPlayer) {
    throw new Error("DPlayer 资源加载失败");
  }
  const customType = {
    mpegts(video) {
      if (!window.mpegts || !window.mpegts.isSupported()) return;
      destroyMpegtsPlayer();
      const sourceUrl = new URL(video.src || "", location.origin).toString();
      const player = window.mpegts.createPlayer(
        {
          type: "mpegts",
          url: sourceUrl,
          isLive: false
        },
        {
          enableWorker: false,
          autoCleanupSourceBuffer: true,
          seekType: "range",
          accurateSeek: true,
          lazyLoad: true,
          lazyLoadMaxDuration: 30,
          lazyLoadRecoverDuration: 8,
          rangeLoadZeroStart: true,
          enableStashBuffer: true,
          stashInitialSize: 256 * 1024
        }
      );
      state.mpegtsPlayer = player;
      player.on(window.mpegts.Events.MEDIA_INFO, (mediaInfo) => {
        const rawDuration = Number(mediaInfo?.duration || 0);
        if (Number.isFinite(rawDuration) && rawDuration > 0) {
          const durationSeconds = rawDuration > 1000 ? rawDuration / 1000 : rawDuration;
          if (lockDuration(durationSeconds, false)) {
            updateTransportControls();
          }
        }
      });
      player.on(window.mpegts.Events.ERROR, (type, detail) => {
        if (String(type) === "NetworkError") {
          setHint(`TS 播放网络错误：${detail || "unknown"}，正在切换备用源...`);
          tryNextSourceAfterError().catch(() => {});
        }
      });
      player.attachMediaElement(video);
      player.load();
      player.play().catch(() => {});
    }
  };
  state.dp = new window.DPlayer({
    container: refs.dplayerContainer,
    autoplay: false,
    hotkey: true,
    mutex: true,
    loop: false,
    theme: "#2ee8ad",
    lang: "zh-cn",
    volume: 0.8,
    video: {
      url: sourceUrl || "",
      type: guessVideoType(sourceUrl),
      customType
    }
  });

  const video = state.dp.video;
  video.setAttribute("playsinline", "");
  video.setAttribute("playsinline", "true");
  video.setAttribute("webkit-playsinline", "true");
  video.setAttribute("x5-playsinline", "true");
  if (state.isIOS) {
    video.setAttribute("x-webkit-airplay", "allow");
    try {
      video.disableRemotePlayback = true;
    } catch {
      // ignore
    }
  }

  const fullscreenPlugin = ensureFullscreenDanmakuPlugin();
  updateFullscreenDanmakuIdentity();
  if (!fullscreenPlugin.root.dataset.bound) {
    fullscreenPlugin.root.dataset.bound = "1";
    fullscreenPlugin.sendBtn.addEventListener("click", () => sendDanmaku(true));
    fullscreenPlugin.exitBtn.addEventListener("click", () => cancelPlayerFullscreen());
    fullscreenPlugin.toggleBtn?.addEventListener("click", () => {
      if (!isFullscreenMode()) {
        requestPlayerFullscreen();
        return;
      }
      showFullscreenDanmakuBar(true);
      fullscreenPlugin.input?.focus();
    });
    fullscreenPlugin.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") sendDanmaku(true);
    });
    fullscreenPlugin.input.addEventListener("focus", () => showFullscreenDanmakuBar(false));
    fullscreenPlugin.input.addEventListener("input", () => showFullscreenDanmakuBar(false));
    fullscreenPlugin.input.addEventListener("blur", () => showFullscreenDanmakuBar(true));
    fullscreenPlugin.root.addEventListener("pointerdown", () => showFullscreenDanmakuBar(false));
  }

  video.addEventListener("play", () => {
    state.autoPlayBlocked = false;
    emitSync("play");
    updateTransportControls();
  });
  video.addEventListener("pause", () => {
    emitSync("pause");
    updateTransportControls();
  });
  video.addEventListener("timeupdate", () => {
    updateTransportControls();
  });
  video.addEventListener("durationchange", () => {
    updateTransportControls();
  });
  video.addEventListener("progress", () => {
    updateTransportControls();
  });
  video.addEventListener("seeked", () => {
    emitSync("seek");
    updateTransportControls();
  });
  video.addEventListener("ratechange", () => {
    emitSync("ratechange");
  });
  video.addEventListener("error", () => {
    if (String(video.dataset?.sourceType || "") === "mpegts") {
      return;
    }
    tryNextSourceAfterError().catch(() => {});
  });
  video.addEventListener("loadedmetadata", () => {
    state.playerReady = true;
    updateTransportControls();
    if (state.pendingSync) {
      applyRemoteSync(state.pendingSync, true);
      state.pendingSync = null;
    }
  });

  state.dp.on("fullscreen", () => handlePlayerFullscreen(true));
  state.dp.on("fullscreen_cancel", () => handlePlayerFullscreen(false));
  state.dp.on("webfullscreen", () => handlePlayerFullscreen(true));
  state.dp.on("webfullscreen_cancel", () => handlePlayerFullscreen(false));
  bindIOSFullscreenGuards(video);
  bindDPlayerTimelineFallback();
  updateTransportControls();

  return state.dp;
}

function getCurrentSource() {
  if (!state.sourceCandidates.length) return "";
  return state.sourceCandidates[state.sourceIndex] || "";
}

function buildPlaybackFailureHint() {
  const source = getCurrentSource();
  try {
    const parsed = new URL(source, location.origin);
    if (parsed.origin === location.origin && parsed.pathname.startsWith("/s3-direct/")) {
      return "当前视频地址均播放失败，可能是视频封装格式异常（如 TS 伪装 MP4）或对象权限异常";
    }
    if (parsed.hostname) {
      return `当前视频地址均播放失败，可能无法访问 ${parsed.hostname}（DNS/网络异常）`;
    }
  } catch {
    // ignore
  }
  return "当前视频所有地址均播放失败";
}

function isSignedQueryUrl(url) {
  const raw = String(url || "");
  return /[?&]x-amz-signature=/i.test(raw) || /[?&]x-amz-algorithm=/i.test(raw);
}

function isLocalDirectBridgeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw, location.origin);
    return parsed.origin === location.origin && parsed.pathname.startsWith("/s3-direct/");
  } catch {
    return raw.startsWith("/s3-direct/");
  }
}

function appendRetryParam(url, token) {
  if (!isLocalDirectBridgeUrl(url) || isSignedQueryUrl(url)) {
    return String(url || "");
  }
  const suffix = token || String(Date.now());
  try {
    const parsed = new URL(String(url || ""), location.origin);
    parsed.searchParams.set("_retry", suffix);
    return parsed.origin === location.origin ? `${parsed.pathname}${parsed.search}` : parsed.toString();
  } catch {
    const raw = String(url || "");
    if (!raw) return "";
    return `${raw}${raw.includes("?") ? "&" : "?"}_retry=${encodeURIComponent(suffix)}`;
  }
}

async function switchToCurrentSource(autoPlay = false) {
  const source = getCurrentSource();
  if (!source) {
    throw new Error("没有可用播放地址");
  }
  if (isLocalDirectBridgeUrl(source) && !state.serviceWorkerReady) {
    await ensureDirectS3Bridge();
  }
  const sourceType = await resolveSourceType(source);
  const dp = ensurePlayer(source);
  syncMpegtsTimelineOffset(source, sourceType);
  if (sourceType === "mpegts") {
    probeLockedDurationForMpegts();
  }
  const currentType = String(dp.video?.dataset?.sourceType || "");
  if (dp.video?.src !== source || currentType !== sourceType) {
    destroyMpegtsPlayer();
    dp.switchVideo({
      url: source,
      type: sourceType
    });
    dp.video.dataset.sourceType = sourceType;
  }
  state.playerReady = false;
  updateTransportControls(0);
  if (autoPlay) {
    requestPlayWithFallback(false).catch(() => {});
  } else {
    dp.pause();
  }
}

async function recoverDirectPlaybackSource() {
  if (!state.media?.fileId || state.sourceRecovering || state.directRecoverAttempted) {
    return false;
  }
  state.sourceRecovering = true;
  state.directRecoverAttempted = true;
  setHint("直连通道异常，正在自动修复...");
  try {
    if (shouldUseSignedHeaderBridge()) {
      await ensureDirectS3Bridge(true);
    }
    const recovered = await resolveMediaByFileId(state.media.fileId, state.media.name, state.media);
    const token = String(Date.now());
    state.sourceCandidates = (recovered.candidateUrls || [])
      .map((url) => appendRetryParam(url, token))
      .filter(Boolean);
    if (!state.sourceCandidates.length && recovered.url) {
      state.sourceCandidates = [appendRetryParam(recovered.url, token)];
    }
    state.sourceIndex = 0;
    await switchToCurrentSource(true);
    setHint("直连通道已重试，正在重新加载...");
    return true;
  } catch (error) {
    setHint(`直连修复失败：${error.message || "未知错误"}`);
    return false;
  } finally {
    state.sourceRecovering = false;
  }
}

async function tryNextSourceAfterError() {
  const next = state.sourceIndex + 1;
  if (next >= state.sourceCandidates.length) {
    recoverDirectPlaybackSource().then((ok) => {
      if (!ok) {
        setHint(buildPlaybackFailureHint());
      }
    });
    return;
  }
  state.sourceIndex = next;
  setHint(`当前地址失败，切换备用地址 ${next + 1}/${state.sourceCandidates.length}...`);
  try {
    await switchToCurrentSource(true);
  } catch (error) {
    setHint(error.message);
  }
}

async function resolveMediaByFileId(fileId, fileName = "", fromMedia = null) {
  const result = await fetchJson(`/api/cx/link?fileId=${encodeURIComponent(fileId)}`);
  const playUrl = String(result.playUrl || result.url || "");
  const list = Array.isArray(result.candidateUrls) ? result.candidateUrls.filter(Boolean) : [];
  if (playUrl && !list.includes(playUrl)) {
    list.unshift(playUrl);
  }
  if (playUrl && shouldUseSignedHeaderBridge() && isLocalDirectBridgeUrl(playUrl)) {
    const retryUrl = appendRetryParam(playUrl, "seed");
    if (retryUrl && !list.includes(retryUrl)) {
      list.push(retryUrl);
    }
  }
  return {
    id: fromMedia?.id || `${fileId}-${Date.now()}`,
    fileId,
    name: fileName || fromMedia?.name || "未命名视频",
    duration: Number(result.duration || fromMedia?.duration || 0),
    contentLength: Number(result.contentLength || fromMedia?.contentLength || 0),
    candidateUrls: list,
    url: playUrl || list[0] || ""
  };
}

async function setMedia(media, broadcast) {
  state.media = media;
  state.lockedDuration = 0;
  state.durationProbeTask = null;
  state.mpegtsTimelineOffset = 0;
  lockDuration(Number(media?.duration || 0), true);
  state.directRecoverAttempted = false;
  state.sourceRecovering = false;
  clearDanmakuLayer();
  state.sourceCandidates = (media.candidateUrls || []).filter(Boolean);
  if (!state.sourceCandidates.length && media.url) {
    state.sourceCandidates = [media.url];
  }
  state.sourceIndex = 0;
  await switchToCurrentSource(false);
  updateTransportControls(0);
  updateOverlayHint();

  if (broadcast && state.joined && state.socket) {
    state.socket.emit("media:change", media, (ack) => {
      if (!ack || !ack.ok) {
        setHint(`同步切换失败：${ack?.message || "未知错误"}`);
      }
    });
  }
}

function getPlaybackState() {
  const video = state.dp?.video;
  if (!video) {
    return {
      playing: false,
      currentTime: 0,
      playbackRate: 1
    };
  }
  return {
    playing: !video.paused,
    currentTime: getPlaybackCurrentTime(video),
    playbackRate: Number(video.playbackRate || 1)
  };
}

function emitSync(reason) {
  if (!state.dp || !state.socket || !state.joined || !state.media || !isController()) return;
  if (performance.now() < state.blockLocalUntil) return;
  const playback = getPlaybackState();
  state.socket.emit("sync:update", {
    playing: playback.playing,
    currentTime: playback.currentTime,
    playbackRate: playback.playbackRate,
    reason
  });
}

async function requestPlayWithFallback(fromSync = false) {
  if (!state.dp) return false;
  const video = state.dp.video;
  try {
    await state.dp.play();
    state.autoPlayBlocked = false;
    return true;
  } catch {
    if (fromSync && !video.muted) {
      video.muted = true;
      try {
        await state.dp.play();
        state.autoPlayBlocked = false;
        setHint("移动端自动播放受限，已临时切为静音播放");
        return true;
      } catch {
        // ignore
      }
    }
    state.autoPlayBlocked = true;
    if (fromSync) {
      setHint("当前设备限制自动播放，请点击播放器中央开始播放");
    }
    return false;
  }
}

function requestSyncPlayIfNeeded() {
  if (state.syncPlayTask) return;
  state.syncPlayTask = requestPlayWithFallback(true)
    .catch(() => false)
    .finally(() => {
      state.syncPlayTask = null;
    });
}

function applyRemoteSync(syncState, forceSeek = false) {
  if (!syncState) return;
  if (!state.media || !state.dp) {
    state.pendingSync = syncState;
    return;
  }

  const video = state.dp.video;
  const serverTime = Number(syncState.serverTime || nowMs());
  const elapsed = Math.max(0, (nowMs() - serverTime) / 1000);
  const targetTime =
    Number(syncState.currentTime || 0) +
    (syncState.playing ? elapsed * Number(syncState.playbackRate || 1) : 0);
  const drift = Math.abs(getPlaybackCurrentTime(video) - targetTime);
  const nowTick = performance.now();
  const throttleBlockedSeek =
    syncState.playing &&
    state.autoPlayBlocked &&
    video.paused &&
    !forceSeek &&
    syncState.reason !== "seek" &&
    nowTick - state.blockedSyncSeekAt < BLOCKED_SYNC_SEEK_INTERVAL_MS;

  withLocalBlock(() => {
    const nextRate = Number(syncState.playbackRate || 1);
    if (Math.abs(video.playbackRate - nextRate) > 0.01) {
      video.playbackRate = nextRate;
    }

    if (!throttleBlockedSeek && (forceSeek || drift > state.syncDriftThreshold || syncState.reason === "seek")) {
      try {
        const seekTarget = Math.max(0, targetTime);
        const nativeDuration = Number(video.duration || 0);
        const sourceType = getSourceType(video);
        const forceNativeSeek = sourceType === "mpegts" || !(Number.isFinite(nativeDuration) && nativeDuration > 0);
        if (forceNativeSeek) {
          if (sourceType === "mpegts") {
            if (!seekMpegtsBySourceReload(seekTarget, Boolean(syncState.playing), false, "seek")) {
              seekMpegtsTarget(video, seekTarget);
            }
          } else {
            seekMpegtsTarget(video, seekTarget);
          }
        } else {
          state.dp.seek(seekTarget);
        }
        if (syncState.playing && state.autoPlayBlocked && video.paused) {
          state.blockedSyncSeekAt = nowTick;
        }
      } catch {
        // ignore
      }
    }

    if (syncState.playing) {
      if (video.paused) {
        requestSyncPlayIfNeeded();
      }
    } else if (!video.paused) {
      state.dp.pause();
    }
  });

  updateTransportControls();
  setHint(`同步漂移 ${drift.toFixed(2)}s`);
}

function clearFullscreenBarTimer() {
  if (!state.fullscreenBarTimer) return;
  clearTimeout(state.fullscreenBarTimer);
  state.fullscreenBarTimer = null;
}

function setIOSInlineFullscreen(opened) {
  state.iosInlineFullscreen = Boolean(opened);
  const active = state.iosInlineFullscreen;
  document.documentElement.classList.toggle("ios-inline-fullscreen", active);
  document.body.classList.toggle("ios-inline-fullscreen", active);
  refs.roomApp?.classList?.toggle("ios-inline-fullscreen", active);
}

function requestIOSInlineFullscreen() {
  if (!state.isIOS) return false;
  setIOSInlineFullscreen(true);
  handlePlayerFullscreen(true);
  return true;
}

function cancelIOSInlineFullscreen() {
  if (!state.isIOS) return false;
  handlePlayerFullscreen(false);
  setIOSInlineFullscreen(false);
  return true;
}

function isFullscreenMode() {
  return state.playerFullscreen;
}

function showFullscreenDanmakuBar(autoHide = true) {
  if (!isFullscreenMode()) return;
  const plugin = getFullscreenDanmakuPlugin();
  if (!plugin?.root) return;
  plugin.root.classList.remove("hidden", "auto-hidden");
  state.dp?.container?.classList?.add("dplayer-danmaku-plugin-active");
  clearFullscreenBarTimer();
  if (!autoHide) return;
  if (plugin.input && document.activeElement === plugin.input) return;
  state.fullscreenBarTimer = setTimeout(() => {
    plugin.root.classList.add("auto-hidden");
    state.dp?.container?.classList?.remove("dplayer-danmaku-plugin-active");
  }, FULLSCREEN_DANMAKU_AUTO_HIDE_MS);
}

function hideFullscreenDanmakuBar() {
  const plugin = getFullscreenDanmakuPlugin();
  if (!plugin?.root) return;
  clearFullscreenBarTimer();
  plugin.root.classList.remove("auto-hidden");
  plugin.root.classList.add("hidden");
  state.dp?.container?.classList?.remove("dplayer-danmaku-plugin-active");
}

async function lockLandscapeIfNeeded() {
  if (!state.isMobile) return;
  const orientation = screen.orientation;
  if (!orientation || typeof orientation.lock !== "function") return;
  try {
    await orientation.lock("landscape");
  } catch {
    // ignore
  }
}

async function unlockOrientationIfNeeded() {
  const orientation = screen.orientation;
  if (!orientation || typeof orientation.unlock !== "function") return;
  try {
    orientation.unlock();
  } catch {
    // ignore
  }
}

function handlePlayerFullscreen(opened) {
  state.playerFullscreen = Boolean(opened);
  if (!opened) {
    hideFullscreenDanmakuBar();
    unlockOrientationIfNeeded().catch(() => {});
    return;
  }
  showFullscreenDanmakuBar(true);
  lockLandscapeIfNeeded().catch(() => {});
}

function requestPlayerFullscreen() {
  if (state.isIOS) {
    requestIOSInlineFullscreen();
    return;
  }
  if (!state.dp?.fullScreen) return;
  try {
    state.dp.fullScreen.request("browser");
    return;
  } catch {
    // ignore and fallback
  }
  try {
    state.dp.fullScreen.request("web");
  } catch {
    // ignore
  }
}

function cancelPlayerFullscreen() {
  if (state.isIOS) {
    cancelIOSInlineFullscreen();
    return;
  }
  if (!state.dp?.fullScreen) return;
  try {
    state.dp.fullScreen.cancel("browser");
  } catch {
    // ignore
  }
  try {
    state.dp.fullScreen.cancel("web");
  } catch {
    // ignore
  }
}

async function loadFolder(folderId) {
  refs.fileList.innerHTML = '<div class="hint">目录加载中...</div>';
  try {
    const result = await fetchJson(`/api/cx/list?folderId=${encodeURIComponent(folderId)}`);
    renderFolderItems(result.items || []);
  } catch (error) {
    refs.fileList.innerHTML = `<div class="hint">目录加载失败：${error.message}</div>`;
  }
}

function renderFolderItems(items) {
  refs.fileList.innerHTML = "";
  if (!items.length) {
    refs.fileList.innerHTML = '<div class="hint">当前目录为空</div>';
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "file-item";
    const icon = item.itemType === "folder" ? "📁" : item.isVideo ? "🎬" : "📄";
    row.innerHTML = `
      <strong>${icon} ${item.name}</strong>
      <div class="file-meta">${item.itemType === "folder" ? "进入目录" : item.isVideo ? "点击播放" : "非视频文件"}</div>
      <div class="file-meta">${
        item.itemType === "folder" ? `目录 ID: ${item.id}` : `${formatBytes(item.size)} · fileId: ${item.fileId}`
      }</div>
    `;
    row.addEventListener("click", async () => {
      if (item.itemType === "folder") {
        state.folderStack.push({ id: item.id, name: item.name });
        refreshFolderPathText();
        await loadFolder(item.id);
        return;
      }
      if (!item.isVideo) {
        setHint("该文件不是可播放视频");
        return;
      }
      await playFromFile(item);
    });
    refs.fileList.appendChild(row);
  });
}

async function playFromFile(fileItem) {
  if (state.joined && !isController()) {
    setHint("当前不是主控，不能切换视频");
    return;
  }
  setHint("正在读取 S3 播放地址...");
  try {
    const media = await resolveMediaByFileId(fileItem.fileId, fileItem.name);
    await setMedia(media, true);
    if (state.isMobile) {
      setMobileTab("player");
    }
    setHint(`视频已加载：${fileItem.name}`);
    requestPlayWithFallback(false).catch(() => {});
  } catch (error) {
    setHint(`加载失败：${error.message}`);
  }
}

function sendChat() {
  if (!state.socket || !state.joined) {
    setHint("请先加入房间");
    return;
  }
  const text = refs.chatInput.value.trim();
  if (!text) return;
  const videoTime = getPlaybackCurrentTime(state.dp?.video);
  state.socket.emit("chat:send", { text, color: refs.danmakuColorInput.value, videoTime }, (ack) => {
    if (!ack || !ack.ok) {
      setHint(`消息发送失败：${ack?.message || "未知错误"}`);
      return;
    }
    refs.chatInput.value = "";
  });
}

function sendDanmaku(fromFullscreen = false) {
  if (!state.socket || !state.joined) {
    setHint("请先加入房间");
    return;
  }
  const plugin = getFullscreenDanmakuPlugin();
  const input = fromFullscreen ? plugin?.input : refs.danmakuInput;
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const videoTime = getPlaybackCurrentTime(state.dp?.video);
  state.socket.emit(
    "danmaku:send",
    {
      text,
      color: refs.danmakuColorInput.value,
      videoTime
    },
    (ack) => {
      if (!ack || !ack.ok) {
        setHint(`弹幕发送失败：${ack?.message || "未知错误"}`);
        return;
      }
      input.value = "";
      if (fromFullscreen) {
        showFullscreenDanmakuBar(true);
      }
    }
  );
}

function joinCurrentRoom() {
  if (!state.socket) return;
  state.socket.emit("room:join", { roomId: state.roomId, nickname: state.nickname }, (ack) => {
    if (!ack || !ack.ok) {
      setHint(`加入失败：${ack?.message || "未知错误"}`);
      return;
    }
    state.joined = true;
    setHint("已加入房间");
  });
}

function bindActions() {
  refs.backLobbyBtn.addEventListener("click", () => {
    if (state.iosInlineFullscreen) {
      cancelIOSInlineFullscreen();
    }
    location.href = "/";
  });
  refs.leaveBtn.addEventListener("click", () => {
    if (state.iosInlineFullscreen) {
      cancelIOSInlineFullscreen();
    }
    if (state.socket) state.socket.emit("room:leave");
    location.href = "/";
  });
  refs.claimBtn.addEventListener("click", () => {
    if (!state.socket) return;
    state.socket.emit("controller:claim", (ack) => {
      if (!ack || !ack.ok) {
        setHint(`抢主控失败：${ack?.message || "未知错误"}`);
        return;
      }
      setHint("你已成为主控");
    });
  });

  refs.refreshFolderBtn.addEventListener("click", () => {
    loadFolder(currentFolder().id);
  });
  refs.backFolderBtn.addEventListener("click", () => {
    if (state.folderStack.length <= 1) {
      setHint("已经在根目录");
      return;
    }
    state.folderStack.pop();
    refreshFolderPathText();
    loadFolder(currentFolder().id);
  });

  refs.seekBackBtn.addEventListener("click", () => seekBy(-10));
  refs.seekForwardBtn.addEventListener("click", () => seekBy(10));
  refs.seekRange.addEventListener("pointerdown", () => {
    state.transportDragging = true;
  });
  refs.seekRange.addEventListener("pointerup", () => {
    state.transportDragging = false;
    updateTransportControls();
  });
  refs.seekRange.addEventListener("pointercancel", () => {
    state.transportDragging = false;
    updateTransportControls();
  });
  refs.seekRange.addEventListener("input", () => {
    const duration = getPlayableDuration(state.dp?.video);
    if (!(duration > 0)) {
      refs.timeLabel.textContent = "00:00 / --:--";
      return;
    }
    state.transportDragging = true;
    const ratio = Number(refs.seekRange.value || 0) / 1000;
    const preview = Math.max(0, Math.min(duration, ratio * duration));
    refs.timeLabel.textContent = `${formatClock(preview)} / ${formatClock(duration)}`;
  });
  refs.seekRange.addEventListener("change", () => {
    const duration = getPlayableDuration(state.dp?.video);
    if (!(duration > 0)) {
      state.transportDragging = false;
      updateTransportControls();
      return;
    }
    const ratio = Number(refs.seekRange.value || 0) / 1000;
    seekTo(duration * ratio, "seek");
    state.transportDragging = false;
    updateTransportControls();
  });

  refs.chatSendBtn.addEventListener("click", sendChat);
  refs.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendChat();
  });

  refs.sendDanmakuBtn.addEventListener("click", () => sendDanmaku(false));
  refs.danmakuInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendDanmaku(false);
  });
  refs.videoStage.addEventListener("pointerup", (event) => {
    if (!isFullscreenMode()) return;
    const pluginRoot = getFullscreenDanmakuPlugin()?.root;
    if (pluginRoot && event.target instanceof Node && pluginRoot.contains(event.target)) return;
    showFullscreenDanmakuBar(true);
  });
  refs.dplayerContainer.addEventListener("pointerup", (event) => {
    if (!isFullscreenMode()) return;
    const pluginRoot = getFullscreenDanmakuPlugin()?.root;
    if (pluginRoot && event.target instanceof Node && pluginRoot.contains(event.target)) return;
    showFullscreenDanmakuBar(true);
  });

  refs.fullscreenBtn.addEventListener("click", () => requestPlayerFullscreen());

  refs.emojiRow.innerHTML = "";
  EMOJI_LIST.forEach((emoji) => {
    const button = document.createElement("button");
    button.className = "emoji-btn";
    button.type = "button";
    button.textContent = emoji;
    button.addEventListener("click", () => {
      refs.chatInput.value += emoji;
      refs.chatInput.focus();
    });
    refs.emojiRow.appendChild(button);
  });

  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement && !state.playerFullscreen) {
      handlePlayerFullscreen(true);
      return;
    }
    if (!document.fullscreenElement && state.playerFullscreen) {
      handlePlayerFullscreen(false);
    }
  });
  document.addEventListener("webkitfullscreenchange", () => {
    if (document.webkitFullscreenElement && !state.playerFullscreen) {
      handlePlayerFullscreen(true);
      return;
    }
    if (!document.webkitFullscreenElement && state.playerFullscreen) {
      handlePlayerFullscreen(false);
    }
  });
}

function initSocket() {
  if (state.socket) return;
  const socket = io({
    transports: ["websocket", "polling"],
    withCredentials: true
  });
  state.socket = socket;

  socket.on("connect", () => {
    state.connected = true;
    updateTopStatus();
    joinCurrentRoom();
  });

  socket.on("disconnect", () => {
    state.connected = false;
    updateTopStatus();
  });

  socket.on("connect_error", (error) => {
    if (String(error?.message || "").includes("UNAUTHORIZED")) {
      location.href = "/";
    }
  });

  socket.on("room:welcome", async (snapshot) => {
    state.joined = true;
    state.selfId = snapshot.selfId || "";
    state.controllerId = snapshot.controllerId || "";
    state.members = snapshot.members || [];
    renderMembers();
    resetChat(snapshot.chatHistory || []);
    clearDanmakuLayer();
    (snapshot.danmakuHistory || []).slice(-60).forEach(spawnDanmaku);

    if (snapshot.media?.fileId) {
      try {
        const media = await resolveMediaByFileId(snapshot.media.fileId, snapshot.media.name, snapshot.media);
        await setMedia(media, false);
        if (snapshot.syncState) {
          applyRemoteSync(snapshot.syncState, true);
        }
      } catch (error) {
        setHint(`恢复房间视频失败：${error.message}`);
      }
    }
  });

  socket.on("room:member_update", (payload) => {
    state.controllerId = payload?.controllerId || "";
    state.members = payload?.members || [];
    renderMembers();
  });

  socket.on("media:change", async (payload) => {
    const mediaPayload = payload?.media || {};
    if (!mediaPayload.fileId) return;
    try {
      const resolved = await resolveMediaByFileId(mediaPayload.fileId, mediaPayload.name, mediaPayload);
      await setMedia(resolved, false);
      if (payload.syncState) {
        applyRemoteSync(payload.syncState, true);
      }
    } catch (error) {
      setHint(`切换视频失败：${error.message}`);
    }
  });

  socket.on("sync:state", (payload) => {
    applyRemoteSync(payload, false);
  });

  socket.on("chat:new", (item) => {
    appendChat(item);
  });

  socket.on("danmaku:new", (item) => {
    spawnDanmaku(item);
  });
}

async function ensureAccess() {
  try {
    const status = await fetchJson("/api/access/status");
    if (!status.authorized) {
      location.href = "/";
      return false;
    }
    return true;
  } catch {
    location.href = "/";
    return false;
  }
}

async function bootstrap() {
  const accessOk = await ensureAccess();
  if (!accessOk) return;

  state.isMobile = isMobileClient();
  state.isIOS = isIOSClient();
  state.roomId = String(getQueryParam("room") || localStorage.getItem("vo_room_id") || "").trim();
  state.nickname = String(getQueryParam("nick") || localStorage.getItem("vo_nickname") || "").trim();
  if (!state.roomId) {
    location.href = "/";
    return;
  }
  if (!state.nickname) {
    state.nickname = generateRandomNickname();
  }
  localStorage.setItem("vo_room_id", state.roomId);
  localStorage.setItem("vo_nickname", state.nickname);

  refs.roomApp.classList.remove("hidden");
  initMobileTabbar();
  updateRoomHeader();
  updateTopStatus();
  updateOverlayHint();

  try {
    if (shouldUseSignedHeaderBridge()) {
      await ensureDirectS3Bridge();
    }
  } catch (error) {
    const message = `S3 直连初始化失败：${error.message}`;
    setHint(message);
    refs.fileList.innerHTML = `<div class="hint">${message}</div>`;
    return;
  }

  bindActions();
  ensurePlayer("");

  try {
    const health = await fetchJson("/api/health");
    state.syncDriftThreshold = Number(health.syncDriftThreshold || 0.4);
  } catch {
    // ignore
  }

  try {
    const cfg = await fetchJson("/api/cx/config");
    state.playMode = String(cfg?.config?.playMode || "signed-header");
    if (shouldUseSignedHeaderBridge() && !state.serviceWorkerReady) {
      await ensureDirectS3Bridge();
    }
    state.rootFolderId = String(cfg?.config?.rootFolderId || "-1");
    state.folderStack = [{ id: state.rootFolderId, name: "根目录" }];
    refreshFolderPathText();
    await loadFolder(state.rootFolderId);
  } catch (error) {
    refs.fileList.innerHTML = `<div class="hint">初始化 S3 配置失败：${error.message}</div>`;
  }

  initSocket();

  state.heartbeatTimer = setInterval(() => {
    if (!state.joined || !state.media || !isController()) return;
    const video = state.dp?.video;
    if (!video || video.paused) return;
    emitSync("heartbeat");
  }, 1000);
}

bootstrap();
