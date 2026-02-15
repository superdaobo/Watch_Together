const EMOJI_LIST = ["😀", "😂", "😎", "🥳", "😭", "❤️", "👍", "🔥", "👀", "🎉"];
const FULLSCREEN_DANMAKU_AUTO_HIDE_MS = 9000;
const BLOCKED_SYNC_SEEK_INTERVAL_MS = 1800;
const SW_VERSION = "20260215-v2";

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
  serviceWorkerReady: false,
  fullscreenDanmakuPlugin: null,
  directRecoverAttempted: false,
  sourceRecovering: false,
  playMode: "presigned-url"
};

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
  chatSendBtn: document.getElementById("chatSendBtn")
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
  state.dp = new window.DPlayer({
    container: refs.dplayerContainer,
    autoplay: false,
    hotkey: true,
    mutex: true,
    loop: false,
    theme: "#2ee8ad",
    lang: "zh-cn",
    volume: 0.8,
    customType: {
      mpegts(video) {
        if (!window.mpegts || !window.mpegts.isSupported()) return;
        destroyMpegtsPlayer();
        const player = window.mpegts.createPlayer(
          {
            type: "mpegts",
            url: video.src,
            isLive: false
          },
          {
            enableWorker: true,
            autoCleanupSourceBuffer: true
          }
        );
        state.mpegtsPlayer = player;
        player.attachMediaElement(video);
        player.load();
        player.play().catch(() => {});
      }
    },
    video: {
      url: sourceUrl || "",
      type: guessVideoType(sourceUrl)
    }
  });

  const video = state.dp.video;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "true");
  video.setAttribute("x5-playsinline", "true");

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
  });
  video.addEventListener("pause", () => {
    emitSync("pause");
  });
  video.addEventListener("seeked", () => {
    emitSync("seek");
  });
  video.addEventListener("ratechange", () => {
    emitSync("ratechange");
  });
  video.addEventListener("error", () => {
    tryNextSourceAfterError();
  });
  video.addEventListener("loadedmetadata", () => {
    state.playerReady = true;
    if (state.pendingSync) {
      applyRemoteSync(state.pendingSync, true);
      state.pendingSync = null;
    }
  });

  state.dp.on("fullscreen", () => handlePlayerFullscreen(true));
  state.dp.on("fullscreen_cancel", () => handlePlayerFullscreen(false));
  state.dp.on("webfullscreen", () => handlePlayerFullscreen(true));
  state.dp.on("webfullscreen_cancel", () => handlePlayerFullscreen(false));

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
  const sourceType = await resolveSourceType(source);
  const dp = ensurePlayer(source);
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
    candidateUrls: list,
    url: playUrl || list[0] || ""
  };
}

async function setMedia(media, broadcast) {
  state.media = media;
  state.directRecoverAttempted = false;
  state.sourceRecovering = false;
  clearDanmakuLayer();
  state.sourceCandidates = (media.candidateUrls || []).filter(Boolean);
  if (!state.sourceCandidates.length && media.url) {
    state.sourceCandidates = [media.url];
  }
  state.sourceIndex = 0;
  await switchToCurrentSource(false);
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
    currentTime: Number(video.currentTime || 0),
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
  const drift = Math.abs(Number(video.currentTime || 0) - targetTime);
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
        state.dp.seek(Math.max(0, targetTime));
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

  setHint(`同步漂移 ${drift.toFixed(2)}s`);
}

function clearFullscreenBarTimer() {
  if (!state.fullscreenBarTimer) return;
  clearTimeout(state.fullscreenBarTimer);
  state.fullscreenBarTimer = null;
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
  const videoTime = Number(state.dp?.video?.currentTime || 0);
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
  const videoTime = Number(state.dp?.video?.currentTime || 0);
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
    location.href = "/";
  });
  refs.leaveBtn.addEventListener("click", () => {
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
    state.playMode = String(cfg?.config?.playMode || "presigned-url");
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
