const EMOJI_LIST = ["😀", "😂", "😎", "🥳", "😭", "❤️", "👍", "🔥", "👀", "🎉"];
const RATE_STEPS = [0.75, 1, 1.25, 1.5, 2];

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
  blockLocalUntil: 0,
  syncDriftThreshold: 0.4,
  draggingProgress: false,
  danmakuTracks: [],
  heartbeatTimer: null,
  sourceCandidates: [],
  sourceIndex: 0,
  hls: null
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
  videoEl: document.getElementById("videoEl"),
  danmakuLayer: document.getElementById("danmakuLayer"),
  playerOverlayHint: document.getElementById("playerOverlayHint"),
  playToggleBtn: document.getElementById("playToggleBtn"),
  currentTimeLabel: document.getElementById("currentTimeLabel"),
  progressRange: document.getElementById("progressRange"),
  durationLabel: document.getElementById("durationLabel"),
  rateBtn: document.getElementById("rateBtn"),
  volumeRange: document.getElementById("volumeRange"),
  muteBtn: document.getElementById("muteBtn"),
  fullscreenBtn: document.getElementById("fullscreenBtn"),
  sendDanmakuBtn: document.getElementById("sendDanmakuBtn"),
  danmakuColorInput: document.getElementById("danmakuColorInput"),
  danmakuInput: document.getElementById("danmakuInput"),
  sendDanmakuBtn2: document.getElementById("sendDanmakuBtn2"),
  fullscreenDanmakuBar: document.getElementById("fullscreenDanmakuBar"),
  fullscreenDanmakuInput: document.getElementById("fullscreenDanmakuInput"),
  fullscreenDanmakuSendBtn: document.getElementById("fullscreenDanmakuSendBtn"),
  fullscreenExitBtn: document.getElementById("fullscreenExitBtn"),
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

function formatClock(seconds = 0) {
  const raw = Number(seconds);
  if (!Number.isFinite(raw) || raw <= 0) return "00:00";
  const whole = Math.floor(raw);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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

function setHint(text) {
  refs.syncHint.textContent = text;
}

function getQueryParam(name) {
  return new URLSearchParams(location.search).get(name) || "";
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function generateRandomNickname() {
  const prefix = ["星河", "晚风", "柠檬", "山海", "橘猫", "浮光", "灯塔", "云雀", "鲸落", "青柚"];
  const suffix = ["同学", "队友", "观众", "影迷", "旅人", "玩家", "探长", "学者"];
  return `${randomFrom(prefix)}${randomFrom(suffix)}${Math.floor(Math.random() * 90 + 10)}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    throw new Error(json.message || `请求失败：${response.status}`);
  }
  return json;
}

function isController() {
  return Boolean(state.selfId && state.controllerId && state.selfId === state.controllerId);
}

function withLocalBlock(fn) {
  state.blockLocalUntil = performance.now() + 420;
  fn();
}

function updateRoomHeader() {
  refs.roomTitle.textContent = `房间：${state.roomId || "--"}`;
  refs.roomSubtitle.textContent = state.nickname ? `当前用户：${state.nickname}` : "正在连接...";
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

function updatePlayButton() {
  refs.playToggleBtn.textContent = refs.videoEl.paused ? "播放" : "暂停";
}

function updateMuteButton() {
  refs.muteBtn.textContent = refs.videoEl.muted ? "取消静音" : "静音";
}

function updateRateButton() {
  refs.rateBtn.textContent = `${refs.videoEl.playbackRate.toFixed(2)}x`;
}

function updateOverlayHint() {
  refs.playerOverlayHint.classList.toggle("hidden", Boolean(state.media?.fileId));
}

function setControlTimeUI(current, duration) {
  refs.currentTimeLabel.textContent = formatClock(current);
  refs.durationLabel.textContent = formatClock(duration);
  if (!state.draggingProgress) {
    const ratio = duration > 0 ? current / duration : 0;
    refs.progressRange.value = String(Math.max(0, Math.min(1000, Math.round(ratio * 1000))));
  }
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
}

function appendChat(item) {
  const wrap = document.createElement("div");
  wrap.className = `chat-item${item.fromSocketId === state.selfId ? " me" : ""}`;

  const head = document.createElement("div");
  head.className = "chat-head";
  const date = new Date(item.createdAt);
  head.textContent = `${item.nickname} · ${String(date.getHours()).padStart(2, "0")}:${String(
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
  const duration = Math.max(6400, Math.min(12500, 8200 + item.text.length * 60));
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

function destroyHls() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
}

function applySource(url) {
  destroyHls();
  const targetUrl = String(url || "");
  const isM3u8 = /\.m3u8($|\?)/i.test(targetUrl);
  if (isM3u8 && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({
      maxBufferLength: 20,
      backBufferLength: 8,
      lowLatencyMode: true
    });
    hls.loadSource(targetUrl);
    hls.attachMedia(refs.videoEl);
    state.hls = hls;
    return;
  }
  refs.videoEl.src = targetUrl;
}

function getCurrentSource() {
  if (!state.sourceCandidates.length) return "";
  return state.sourceCandidates[state.sourceIndex] || "";
}

function tryNextSourceAfterError() {
  const nextIndex = state.sourceIndex + 1;
  if (nextIndex >= state.sourceCandidates.length) {
    setHint("当前视频所有直连地址都播放失败");
    return;
  }
  const wasPlaying = !refs.videoEl.paused;
  state.sourceIndex = nextIndex;
  const nextSource = getCurrentSource();
  setHint(`正在切换备用播放地址（${nextIndex + 1}/${state.sourceCandidates.length}）...`);
  applySource(nextSource);
  refs.videoEl.load();
  if (wasPlaying) {
    refs.videoEl.play().catch(() => {});
  }
}

async function resolveMediaByFileId(fileId, fileName = "", fromMedia = null) {
  const result = await fetchJson(`/api/cx/link?fileId=${encodeURIComponent(fileId)}`);
  const list = Array.isArray(result.candidateUrls) ? result.candidateUrls.filter(Boolean) : [];
  return {
    id: fromMedia?.id || `${fileId}-${Date.now()}`,
    fileId,
    name: fileName || fromMedia?.name || "未命名视频",
    duration: Number(result.duration || fromMedia?.duration || 0),
    candidateUrls: list,
    url: list[0] || result.url || ""
  };
}

async function setMedia(media, broadcast) {
  state.media = media;
  clearDanmakuLayer();
  state.sourceCandidates = (media.candidateUrls || []).filter(Boolean);
  if (!state.sourceCandidates.length && media.url) {
    state.sourceCandidates = [media.url];
  }
  state.sourceIndex = 0;
  const firstSource = getCurrentSource();
  if (!firstSource) {
    throw new Error("没有可用播放地址");
  }

  applySource(firstSource);
  refs.videoEl.load();
  refs.videoEl.currentTime = 0;
  updateOverlayHint();
  setControlTimeUI(0, 0);
  updatePlayButton();

  if (broadcast && state.joined && state.socket) {
    state.socket.emit("media:change", media, (ack) => {
      if (!ack || !ack.ok) {
        setHint(`同步切换失败：${ack?.message || "未知错误"}`);
      }
    });
  }
}

async function playFromFile(fileItem) {
  if (state.joined && !isController()) {
    setHint("当前不是主控，不能切换视频");
    return;
  }
  setHint("正在获取直连地址...");
  try {
    const media = await resolveMediaByFileId(fileItem.fileId, fileItem.name);
    await setMedia(media, true);
    setHint(`视频已加载：${fileItem.name}`);
  } catch (error) {
    setHint(`加载失败：${error.message}`);
  }
}

function emitSync(reason) {
  if (!state.socket || !state.joined || !state.media || !isController()) return;
  if (performance.now() < state.blockLocalUntil) return;
  state.socket.emit("sync:update", {
    playing: !refs.videoEl.paused,
    currentTime: refs.videoEl.currentTime,
    playbackRate: refs.videoEl.playbackRate,
    reason
  });
}

function applyRemoteSync(syncState, forceSeek = false) {
  if (!syncState) return;
  if (!state.media) {
    state.pendingSync = syncState;
    return;
  }

  const video = refs.videoEl;
  const serverTime = Number(syncState.serverTime || nowMs());
  const elapsed = Math.max(0, (nowMs() - serverTime) / 1000);
  const targetTime =
    Number(syncState.currentTime || 0) +
    (syncState.playing ? elapsed * Number(syncState.playbackRate || 1) : 0);
  const drift = Math.abs(video.currentTime - targetTime);

  withLocalBlock(() => {
    const targetRate = Number(syncState.playbackRate || 1);
    if (Math.abs(video.playbackRate - targetRate) > 0.01) {
      video.playbackRate = targetRate;
      updateRateButton();
    }

    if (forceSeek || drift > state.syncDriftThreshold || syncState.reason === "seek") {
      try {
        video.currentTime = Math.max(0, targetTime);
      } catch {
        // no-op
      }
    }

    if (syncState.playing) {
      if (video.paused) video.play().catch(() => {});
    } else if (!video.paused) {
      video.pause();
    }
  });

  setHint(`同步漂移 ${drift.toFixed(2)}s`);
}

function sendChat() {
  if (!state.socket || !state.joined) {
    setHint("请先加入房间");
    return;
  }
  const text = refs.chatInput.value.trim();
  if (!text) return;
  state.socket.emit("chat:send", { text }, (ack) => {
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
  const input = fromFullscreen ? refs.fullscreenDanmakuInput : refs.danmakuInput;
  const text = input.value.trim();
  if (!text) return;
  state.socket.emit(
    "danmaku:send",
    {
      text,
      color: refs.danmakuColorInput.value,
      videoTime: refs.videoEl.currentTime || 0
    },
    (ack) => {
      if (!ack || !ack.ok) {
        setHint(`弹幕发送失败：${ack?.message || "未知错误"}`);
        return;
      }
      input.value = "";
    }
  );
}

async function toggleFullscreen() {
  if (document.fullscreenElement === refs.videoStage) {
    await document.exitFullscreen();
    return;
  }
  await refs.videoStage.requestFullscreen();
}

function handleFullscreenChange() {
  const opened = document.fullscreenElement === refs.videoStage;
  refs.fullscreenDanmakuBar.classList.toggle("hidden", !opened);
  if (opened) refs.fullscreenDanmakuInput.focus();
}

function joinCurrentRoom() {
  if (!state.socket) return;
  state.socket.emit("room:join", { roomId: state.roomId, nickname: state.nickname }, (ack) => {
    if (!ack || !ack.ok) {
      setHint(`加入失败：${ack?.message || "未知错误"}`);
      return;
    }
    state.joined = true;
    updateRoomHeader();
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
      setHint("已成为主控");
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

  refs.playToggleBtn.addEventListener("click", () => {
    if (!state.media?.fileId) return;
    if (refs.videoEl.paused) {
      refs.videoEl.play().catch(() => {});
      return;
    }
    refs.videoEl.pause();
  });

  refs.progressRange.addEventListener("pointerdown", () => {
    state.draggingProgress = true;
  });
  refs.progressRange.addEventListener("pointerup", () => {
    state.draggingProgress = false;
  });
  refs.progressRange.addEventListener("input", () => {
    const duration = refs.videoEl.duration || 0;
    if (duration <= 0) return;
    const target = (Number(refs.progressRange.value) / 1000) * duration;
    refs.currentTimeLabel.textContent = formatClock(target);
  });
  refs.progressRange.addEventListener("change", () => {
    const duration = refs.videoEl.duration || 0;
    if (duration <= 0) return;
    const target = (Number(refs.progressRange.value) / 1000) * duration;
    refs.videoEl.currentTime = target;
    emitSync("seek");
  });

  refs.rateBtn.addEventListener("click", () => {
    const current = refs.videoEl.playbackRate || 1;
    const idx = RATE_STEPS.findIndex((item) => Math.abs(item - current) < 0.01);
    const next = RATE_STEPS[(idx + 1 + RATE_STEPS.length) % RATE_STEPS.length];
    refs.videoEl.playbackRate = next;
    updateRateButton();
    emitSync("ratechange");
  });

  refs.volumeRange.addEventListener("input", () => {
    refs.videoEl.volume = Number(refs.volumeRange.value);
    if (refs.videoEl.volume > 0 && refs.videoEl.muted) {
      refs.videoEl.muted = false;
    }
  });
  refs.muteBtn.addEventListener("click", () => {
    refs.videoEl.muted = !refs.videoEl.muted;
    updateMuteButton();
  });

  refs.fullscreenBtn.addEventListener("click", () => {
    toggleFullscreen().catch(() => {});
  });
  refs.fullscreenExitBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  });

  refs.chatSendBtn.addEventListener("click", sendChat);
  refs.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendChat();
  });

  refs.sendDanmakuBtn.addEventListener("click", () => sendDanmaku(false));
  refs.sendDanmakuBtn2.addEventListener("click", () => sendDanmaku(false));
  refs.fullscreenDanmakuSendBtn.addEventListener("click", () => sendDanmaku(true));
  refs.danmakuInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendDanmaku(false);
  });
  refs.fullscreenDanmakuInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendDanmaku(true);
  });

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

  document.addEventListener("fullscreenchange", handleFullscreenChange);
}

function bindVideoEvents() {
  refs.videoEl.addEventListener("click", () => {
    if (refs.videoEl.paused) {
      refs.videoEl.play().catch(() => {});
      return;
    }
    refs.videoEl.pause();
  });
  refs.videoEl.addEventListener("play", () => {
    updatePlayButton();
    emitSync("play");
  });
  refs.videoEl.addEventListener("pause", () => {
    updatePlayButton();
    emitSync("pause");
  });
  refs.videoEl.addEventListener("timeupdate", () => {
    setControlTimeUI(refs.videoEl.currentTime || 0, refs.videoEl.duration || 0);
  });
  refs.videoEl.addEventListener("loadedmetadata", () => {
    setControlTimeUI(refs.videoEl.currentTime || 0, refs.videoEl.duration || 0);
    if (state.pendingSync) {
      applyRemoteSync(state.pendingSync, true);
      state.pendingSync = null;
    }
  });
  refs.videoEl.addEventListener("ratechange", () => {
    updateRateButton();
    emitSync("ratechange");
  });
  refs.videoEl.addEventListener("volumechange", () => {
    refs.volumeRange.value = String(refs.videoEl.volume);
    updateMuteButton();
  });
  refs.videoEl.addEventListener("seeked", () => {
    emitSync("seek");
  });
  refs.videoEl.addEventListener("error", () => {
    tryNextSourceAfterError();
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
    (snapshot.danmakuHistory || []).slice(-30).forEach(spawnDanmaku);

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
  updatePlayButton();
  updateMuteButton();
  updateRateButton();
  updateOverlayHint();

  bindActions();
  bindVideoEvents();

  try {
    const health = await fetchJson("/api/health");
    state.syncDriftThreshold = Number(health.syncDriftThreshold || 0.4);
  } catch {
    // ignore
  }

  try {
    const cfg = await fetchJson("/api/cx/config");
    state.rootFolderId = String(cfg?.config?.rootFolderId || "-1");
    state.folderStack = [{ id: state.rootFolderId, name: "根目录" }];
    refreshFolderPathText();
    await loadFolder(state.rootFolderId);
  } catch (error) {
    refs.fileList.innerHTML = `<div class="hint">初始化超星配置失败：${error.message}</div>`;
  }

  initSocket();

  state.heartbeatTimer = setInterval(() => {
    if (!state.joined || !state.media || !isController()) return;
    if (refs.videoEl.paused) return;
    emitSync("heartbeat");
  }, 1000);
}

bootstrap();
