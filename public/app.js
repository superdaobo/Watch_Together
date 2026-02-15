const socket = io({
  transports: ["websocket", "polling"]
});

const state = {
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
  hls: null,
  danmakuTracks: [],
  heartbeatTimer: null
};

const refs = {
  roomIdInput: document.getElementById("roomIdInput"),
  nicknameInput: document.getElementById("nicknameInput"),
  joinBtn: document.getElementById("joinBtn"),
  leaveBtn: document.getElementById("leaveBtn"),
  claimBtn: document.getElementById("claimBtn"),
  connectState: document.getElementById("connectState"),
  roomState: document.getElementById("roomState"),
  controllerState: document.getElementById("controllerState"),
  refreshFolderBtn: document.getElementById("refreshFolderBtn"),
  backFolderBtn: document.getElementById("backFolderBtn"),
  folderPathText: document.getElementById("folderPathText"),
  fileList: document.getElementById("fileList"),
  videoStage: document.getElementById("videoStage"),
  videoEl: document.getElementById("videoEl"),
  danmakuLayer: document.getElementById("danmakuLayer"),
  fullscreenBtn: document.getElementById("fullscreenBtn"),
  sendDanmakuBtn: document.getElementById("sendDanmakuBtn"),
  sendDanmakuBtn2: document.getElementById("sendDanmakuBtn2"),
  danmakuInput: document.getElementById("danmakuInput"),
  danmakuColorInput: document.getElementById("danmakuColorInput"),
  fullscreenDanmakuBar: document.getElementById("fullscreenDanmakuBar"),
  fullscreenDanmakuInput: document.getElementById("fullscreenDanmakuInput"),
  fullscreenDanmakuSendBtn: document.getElementById("fullscreenDanmakuSendBtn"),
  syncHint: document.getElementById("syncHint"),
  memberCount: document.getElementById("memberCount"),
  memberList: document.getElementById("memberList"),
  chatList: document.getElementById("chatList"),
  emojiRow: document.getElementById("emojiRow"),
  chatInput: document.getElementById("chatInput"),
  chatSendBtn: document.getElementById("chatSendBtn")
};

const EMOJI_LIST = ["😀", "😂", "😎", "🥳", "😭", "❤️", "👍", "🔥", "👀", "🎉"];

function isController() {
  return state.controllerId && state.selfId && state.controllerId === state.selfId;
}

function nowMs() {
  return Date.now();
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatBytes(bytes) {
  const num = Number(bytes || 0);
  if (!Number.isFinite(num) || num <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = num;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function renderStatus() {
  refs.roomState.textContent = state.joined ? `房间：${state.roomId}` : "未加入房间";
  refs.controllerState.textContent = state.controllerId
    ? `主控：${state.members.find((m) => m.socketId === state.controllerId)?.nickname || "未知"}`
    : "主控：--";
}

function withLocalBlock(task) {
  state.blockLocalUntil = performance.now() + 420;
  task();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    throw new Error(json.message || `请求失败 ${response.status}`);
  }
  return json;
}

function setupEmojiRow() {
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
}

function renderMembers() {
  refs.memberList.innerHTML = "";
  refs.memberCount.textContent = `在线 ${state.members.length}`;
  state.members.forEach((member) => {
    const div = document.createElement("div");
    div.className = `member-chip${member.socketId === state.controllerId ? " controller" : ""}`;
    div.textContent =
      member.nickname + (member.socketId === state.selfId ? "（我）" : "") + (member.socketId === state.controllerId ? " · 主控" : "");
    refs.memberList.appendChild(div);
  });
  renderStatus();
}

function appendChat(item) {
  const wrapper = document.createElement("div");
  wrapper.className = `chat-item${item.fromSocketId === state.selfId ? " me" : ""}`;

  const head = document.createElement("div");
  head.className = "chat-head";
  head.textContent = `${item.nickname} · ${formatTime(item.createdAt)}`;

  const body = document.createElement("div");
  body.className = "chat-body";
  body.textContent = item.text;

  wrapper.appendChild(head);
  wrapper.appendChild(body);
  refs.chatList.appendChild(wrapper);
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

function pickDanmakuTrack(trackCount, duration) {
  const now = performance.now();
  while (state.danmakuTracks.length < trackCount) {
    state.danmakuTracks.push(0);
  }

  let chosen = 0;
  let minValue = Number.POSITIVE_INFINITY;
  for (let i = 0; i < trackCount; i += 1) {
    const value = state.danmakuTracks[i];
    if (value <= now) {
      chosen = i;
      minValue = value;
      break;
    }
    if (value < minValue) {
      minValue = value;
      chosen = i;
    }
  }
  state.danmakuTracks[chosen] = now + duration * 0.72;
  return chosen;
}

function spawnDanmaku(item) {
  const layer = refs.danmakuLayer;
  if (!layer) return;
  const height = Math.max(layer.clientHeight, 160);
  const trackHeight = 34;
  const trackCount = Math.max(4, Math.floor(height / trackHeight) - 1);
  const duration = Math.max(6500, Math.min(13000, 8400 + item.text.length * 65));
  const trackIndex = pickDanmakuTrack(trackCount, duration);
  const top = 8 + trackIndex * trackHeight;

  const el = document.createElement("div");
  el.className = "danmaku-item";
  el.textContent = item.text;
  el.style.top = `${top}px`;
  el.style.color = item.color || "#ffffff";
  layer.appendChild(el);

  const startX = layer.clientWidth + 48;
  const endX = -Math.max(el.clientWidth + 60, 240);
  const animation = el.animate(
    [
      { transform: `translate3d(${startX}px,0,0)` },
      { transform: `translate3d(${endX}px,0,0)` }
    ],
    {
      duration,
      easing: "linear"
    }
  );
  animation.onfinish = () => {
    el.remove();
  };
}

async function loadFolder(folderId) {
  refs.fileList.innerHTML = '<div class="hint">加载目录中...</div>';
  try {
    const resp = await fetchJson(`/api/cx/list?folderId=${encodeURIComponent(folderId)}`);
    renderFolderItems(resp.items || []);
  } catch (error) {
    refs.fileList.innerHTML = `<div class="hint">目录加载失败：${error.message}</div>`;
  }
}

function currentFolder() {
  return state.folderStack[state.folderStack.length - 1] || { id: state.rootFolderId, name: "根目录" };
}

function refreshFolderPathText() {
  const pathText = "/" + state.folderStack.map((item) => item.name).join("/");
  refs.folderPathText.textContent = pathText.replace("//", "/");
}

function renderFolderItems(items) {
  refs.fileList.innerHTML = "";
  if (!items.length) {
    refs.fileList.innerHTML = '<div class="hint">此目录为空</div>';
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "file-item";
    const icon = item.itemType === "folder" ? "📁" : item.isVideo ? "🎬" : "📄";
    const title = document.createElement("div");
    title.innerHTML = `<strong>${icon} ${item.name}</strong>`;
    const meta = document.createElement("div");
    meta.className = "file-meta";
    meta.textContent = item.itemType === "folder" ? `目录 ID: ${item.id}` : `${formatBytes(item.size)} · fileId: ${item.fileId}`;
    const action = document.createElement("div");
    action.className = "file-meta";
    action.textContent = item.itemType === "folder" ? "进入" : item.isVideo ? "播放" : "非视频";
    row.appendChild(title);
    row.appendChild(action);
    row.appendChild(meta);

    row.addEventListener("click", async () => {
      if (item.itemType === "folder") {
        state.folderStack.push({ id: item.id, name: item.name });
        refreshFolderPathText();
        await loadFolder(item.id);
        return;
      }

      if (!item.isVideo) {
        refs.syncHint.textContent = "仅支持播放视频文件";
        return;
      }
      await playFromFileItem(item);
    });

    refs.fileList.appendChild(row);
  });
}

async function playFromFileItem(item) {
  refs.syncHint.textContent = "正在获取播放地址...";
  try {
    const data = await fetchJson(`/api/cx/link?fileId=${encodeURIComponent(item.fileId)}`);
    const media = {
      id: `${item.fileId}-${Date.now()}`,
      fileId: item.fileId,
      name: item.name,
      url: data.url,
      duration: data.duration || item.duration || 0
    };
    await setMedia(media, true);
    refs.syncHint.textContent = "视频已加载";
  } catch (error) {
    refs.syncHint.textContent = `播放失败：${error.message}`;
  }
}

function destroyHls() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
}

function attachVideoSource(url) {
  destroyHls();
  const video = refs.videoEl;
  const targetUrl = String(url || "");
  const isM3u8 = /\.m3u8($|\?)/i.test(targetUrl);

  if (isM3u8 && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({
      maxBufferLength: 30,
      backBufferLength: 10,
      lowLatencyMode: true
    });
    hls.loadSource(targetUrl);
    hls.attachMedia(video);
    state.hls = hls;
    return;
  }

  video.src = targetUrl;
}

async function setMedia(media, broadcast) {
  state.media = media;
  clearDanmakuLayer();
  attachVideoSource(media.url);
  refs.videoEl.load();
  refs.videoEl.currentTime = 0;

  if (broadcast && state.joined) {
    socket.emit("media:change", media, (ack) => {
      if (!ack || !ack.ok) {
        refs.syncHint.textContent = `切换视频失败：${ack?.message || "未知错误"}`;
      }
    });
  }
}

function emitSync(reason) {
  if (!state.joined || !state.media || !isController()) return;
  if (performance.now() < state.blockLocalUntil) return;
  const video = refs.videoEl;
  socket.emit("sync:update", {
    playing: !video.paused,
    currentTime: video.currentTime,
    playbackRate: video.playbackRate,
    reason
  });
}

function applyRemoteSync(syncState, forceSeek = false) {
  if (!state.media) {
    state.pendingSync = syncState;
    return;
  }
  if (!syncState) return;
  const video = refs.videoEl;
  const serverTime = Number(syncState.serverTime || nowMs());
  const localNow = nowMs();
  const elapsed = Math.max(0, (localNow - serverTime) / 1000);
  const target =
    Number(syncState.currentTime || 0) +
    (syncState.playing ? elapsed * Number(syncState.playbackRate || 1) : 0);
  const drift = Math.abs(video.currentTime - target);

  withLocalBlock(() => {
    if (Math.abs(video.playbackRate - Number(syncState.playbackRate || 1)) > 0.01) {
      video.playbackRate = Number(syncState.playbackRate || 1);
    }

    if (forceSeek || drift > state.syncDriftThreshold || syncState.reason === "seek") {
      try {
        video.currentTime = Math.max(0, target);
      } catch {
        // ignore
      }
    }

    if (syncState.playing) {
      if (video.paused) {
        video.play().catch(() => {});
      }
    } else if (!video.paused) {
      video.pause();
    }
  });

  refs.syncHint.textContent = `同步漂移 ${drift.toFixed(2)}s`;
}

function sendChat() {
  const text = refs.chatInput.value.trim();
  if (!text) return;
  socket.emit("chat:send", { text }, (ack) => {
    if (!ack || !ack.ok) {
      refs.syncHint.textContent = `消息发送失败：${ack?.message || "未知错误"}`;
      return;
    }
    refs.chatInput.value = "";
  });
}

function sendDanmaku(fromFullscreen = false) {
  const input = fromFullscreen ? refs.fullscreenDanmakuInput : refs.danmakuInput;
  const text = input.value.trim();
  if (!text) return;
  socket.emit(
    "danmaku:send",
    {
      text,
      color: refs.danmakuColorInput.value,
      videoTime: refs.videoEl.currentTime || 0
    },
    (ack) => {
      if (!ack || !ack.ok) {
        refs.syncHint.textContent = `弹幕发送失败：${ack?.message || "未知错误"}`;
        return;
      }
      input.value = "";
    }
  );
}

function handleFullscreenChange() {
  const fullscreen = document.fullscreenElement === refs.videoStage;
  refs.fullscreenDanmakuBar.classList.toggle("hidden", !fullscreen);
  if (fullscreen) {
    refs.fullscreenDanmakuInput.focus();
  }
}

async function joinRoom() {
  const roomId = refs.roomIdInput.value.trim();
  const nickname = refs.nicknameInput.value.trim() || "匿名用户";
  if (!roomId) {
    refs.syncHint.textContent = "请先填写房间号";
    return;
  }

  socket.emit("room:join", { roomId, nickname }, (ack) => {
    if (!ack || !ack.ok) {
      refs.syncHint.textContent = `加入失败：${ack?.message || "未知错误"}`;
      return;
    }
    state.joined = true;
    state.roomId = roomId;
    state.nickname = nickname;
    renderStatus();
  });
}

function leaveRoom() {
  socket.emit("room:leave");
  state.joined = false;
  state.roomId = "";
  state.controllerId = "";
  state.members = [];
  renderMembers();
}

function bindDomEvents() {
  refs.joinBtn.addEventListener("click", joinRoom);
  refs.leaveBtn.addEventListener("click", leaveRoom);
  refs.claimBtn.addEventListener("click", () => {
    socket.emit("controller:claim", (ack) => {
      if (!ack || !ack.ok) {
        refs.syncHint.textContent = `抢主控失败：${ack?.message || "未知错误"}`;
      }
    });
  });
  refs.refreshFolderBtn.addEventListener("click", () => {
    loadFolder(currentFolder().id);
  });
  refs.backFolderBtn.addEventListener("click", () => {
    if (state.folderStack.length <= 1) {
      refs.syncHint.textContent = "已经在根目录";
      return;
    }
    state.folderStack.pop();
    refreshFolderPathText();
    loadFolder(currentFolder().id);
  });
  refs.fullscreenBtn.addEventListener("click", async () => {
    if (document.fullscreenElement === refs.videoStage) {
      await document.exitFullscreen();
      return;
    }
    await refs.videoStage.requestFullscreen();
  });
  refs.sendDanmakuBtn.addEventListener("click", () => sendDanmaku(false));
  refs.sendDanmakuBtn2.addEventListener("click", () => sendDanmaku(false));
  refs.fullscreenDanmakuSendBtn.addEventListener("click", () => sendDanmaku(true));
  refs.chatSendBtn.addEventListener("click", sendChat);
  refs.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      sendChat();
    }
  });
  refs.danmakuInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      sendDanmaku(false);
    }
  });
  refs.fullscreenDanmakuInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      sendDanmaku(true);
    }
  });
  document.addEventListener("fullscreenchange", handleFullscreenChange);

  refs.videoEl.addEventListener("play", () => emitSync("play"));
  refs.videoEl.addEventListener("pause", () => emitSync("pause"));
  refs.videoEl.addEventListener("seeked", () => emitSync("seek"));
  refs.videoEl.addEventListener("ratechange", () => emitSync("ratechange"));
  refs.videoEl.addEventListener("loadedmetadata", () => {
    if (state.pendingSync) {
      applyRemoteSync(state.pendingSync, true);
      state.pendingSync = null;
    }
  });
}

function bindSocketEvents() {
  socket.on("connect", () => {
    refs.connectState.textContent = "已连接";
  });

  socket.on("disconnect", () => {
    refs.connectState.textContent = "已断开";
  });

  socket.on("room:welcome", async (snapshot) => {
    state.joined = true;
    state.selfId = snapshot.selfId;
    state.roomId = snapshot.roomId;
    state.controllerId = snapshot.controllerId;
    state.members = snapshot.members || [];
    renderMembers();
    resetChat(snapshot.chatHistory || []);
    (snapshot.danmakuHistory || []).slice(-30).forEach(spawnDanmaku);

    if (snapshot.media?.url) {
      await setMedia(snapshot.media, false);
      if (snapshot.syncState) {
        applyRemoteSync(snapshot.syncState, true);
      }
    }
  });

  socket.on("room:member_update", (payload) => {
    state.controllerId = payload.controllerId || "";
    state.members = payload.members || [];
    renderMembers();
  });

  socket.on("media:change", async (payload) => {
    if (!payload?.media?.url) return;
    await setMedia(payload.media, false);
    if (payload.syncState) {
      applyRemoteSync(payload.syncState, true);
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

async function bootstrap() {
  setupEmojiRow();
  bindDomEvents();
  bindSocketEvents();

  try {
    const info = await fetchJson("/api/health");
    state.syncDriftThreshold = Number(info.syncDriftThreshold || 0.4);
  } catch {
    // ignore
  }

  try {
    const cfg = await fetchJson("/api/cx/config");
    const root = cfg?.config?.rootFolderId || "-1";
    state.rootFolderId = String(root);
    state.folderStack = [{ id: state.rootFolderId, name: "根目录" }];
    refreshFolderPathText();
    await loadFolder(state.rootFolderId);
  } catch (error) {
    refs.fileList.innerHTML = `<div class="hint">初始化超星配置失败：${error.message}</div>`;
  }

  state.heartbeatTimer = setInterval(() => {
    if (!state.joined || !isController() || !state.media) return;
    if (refs.videoEl.readyState < 2) return;
    if (refs.videoEl.paused) return;
    emitSync("heartbeat");
  }, 1000);

  renderStatus();
}

bootstrap();
