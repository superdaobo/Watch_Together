const EMOJI_LIST = ["😀", "😂", "😎", "🥳", "😭", "❤️", "👍", "🔥", "👀", "🎉"];
const RATE_STEPS = [0.75, 1, 1.25, 1.5, 2];

const state = {
  authorized: false,
  socket: null,
  connected: false,
  joined: false,
  roomId: "",
  nickname: "",
  selfId: "",
  controllerId: "",
  members: [],
  lobbyRooms: [],
  rootFolderId: "-1",
  folderStack: [],
  media: null,
  pendingSync: null,
  blockLocalUntil: 0,
  syncDriftThreshold: 0.4,
  danmakuTracks: [],
  heartbeatTimer: null,
  draggingProgress: false
};

const refs = {
  accessGate: document.getElementById("accessGate"),
  appRoot: document.getElementById("appRoot"),
  accessPasswordInput: document.getElementById("accessPasswordInput"),
  accessEnterBtn: document.getElementById("accessEnterBtn"),
  gateHint: document.getElementById("gateHint"),
  connectState: document.getElementById("connectState"),
  roomState: document.getElementById("roomState"),
  controllerState: document.getElementById("controllerState"),
  refreshLobbyBtn: document.getElementById("refreshLobbyBtn"),
  nicknameInput: document.getElementById("nicknameInput"),
  randomNicknameBtn: document.getElementById("randomNicknameBtn"),
  roomIdInput: document.getElementById("roomIdInput"),
  randomRoomBtn: document.getElementById("randomRoomBtn"),
  quickCreateBtn: document.getElementById("quickCreateBtn"),
  joinBtn: document.getElementById("joinBtn"),
  leaveBtn: document.getElementById("leaveBtn"),
  claimBtn: document.getElementById("claimBtn"),
  lobbyRoomList: document.getElementById("lobbyRoomList"),
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
  if (!Number.isFinite(raw) || raw <= 0) {
    return "00:00";
  }
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
  if (!Number.isFinite(num) || num <= 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = num;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function setHint(text) {
  refs.syncHint.textContent = text;
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

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function generateRandomNickname() {
  const prefixList = ["星河", "晚风", "柠檬", "青柚", "山海", "橘猫", "浮光", "灯塔", "云雀", "鲸落"];
  const suffixList = ["同学", "队友", "观众", "玩家", "影迷", "用户", "学者", "探长", "漫游者", "旅人"];
  return `${randomFrom(prefixList)}${randomFrom(suffixList)}${Math.floor(Math.random() * 90 + 10)}`;
}

function generateRandomRoomId() {
  const segA = Math.random().toString(36).slice(2, 6);
  const segB = Math.floor(Math.random() * 900 + 100);
  return `room-${segA}-${segB}`;
}

function isController() {
  return Boolean(state.selfId && state.controllerId && state.selfId === state.controllerId);
}

function withLocalBlock(fn) {
  state.blockLocalUntil = performance.now() + 420;
  fn();
}

function updatePlayerOverlay() {
  const shouldShow = !state.media?.url;
  refs.playerOverlayHint.classList.toggle("hidden", !shouldShow);
}

function updateStatusLine() {
  refs.connectState.textContent = state.connected ? "已连接" : "未连接";
  refs.roomState.textContent = state.joined ? `房间：${state.roomId}` : "未加入房间";
  if (!state.controllerId) {
    refs.controllerState.textContent = "主控：--";
    return;
  }
  const controllerName = state.members.find((item) => item.socketId === state.controllerId)?.nickname || "未知";
  refs.controllerState.textContent = `主控：${controllerName}`;
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
  updateStatusLine();
}

function renderLobbyRooms() {
  refs.lobbyRoomList.innerHTML = "";
  if (!state.lobbyRooms.length) {
    refs.lobbyRoomList.innerHTML = '<div class="hint">当前暂无在线房间，点击“快速建房”开始。</div>';
    return;
  }

  state.lobbyRooms.forEach((room) => {
    const row = document.createElement("div");
    row.className = "lobby-item";
    const left = document.createElement("div");
    left.innerHTML = `<strong>${room.roomId}</strong><div class="hint">在线 ${room.onlineCount} · ${
      room.hasMedia ? `播放中：${room.mediaName || "未命名视频"}` : "暂无视频"
    }</div>`;
    const button = document.createElement("button");
    button.className = "btn ghost small";
    button.textContent = "加入";
    button.addEventListener("click", () => {
      refs.roomIdInput.value = room.roomId;
      joinRoom(room.roomId);
    });
    row.appendChild(left);
    row.appendChild(button);
    refs.lobbyRoomList.appendChild(row);
  });
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
    const actionText = item.itemType === "folder" ? "进入目录" : item.isVideo ? "点击播放" : "非视频文件";
    row.innerHTML = `
      <strong>${icon} ${item.name}</strong>
      <div class="file-meta">${actionText}</div>
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

  setHint("正在获取可播放流...");
  try {
    const result = await fetchJson(`/api/cx/link?fileId=${encodeURIComponent(fileItem.fileId)}`);
    const media = {
      id: `${fileItem.fileId}-${Date.now()}`,
      fileId: fileItem.fileId,
      name: fileItem.name,
      url: result.streamUrl,
      duration: Number(result.duration || fileItem.duration || 0)
    };
    await setMedia(media, true);
    setHint("视频已加载");
  } catch (error) {
    setHint(`加载失败：${error.message}`);
  }
}

function setControlTimeUI(current, duration) {
  refs.currentTimeLabel.textContent = formatClock(current);
  refs.durationLabel.textContent = formatClock(duration);
  if (!state.draggingProgress) {
    const ratio = duration > 0 ? current / duration : 0;
    refs.progressRange.value = String(Math.max(0, Math.min(1000, Math.round(ratio * 1000))));
  }
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

async function setMedia(media, broadcast) {
  state.media = media;
  clearDanmakuLayer();
  refs.videoEl.src = media.url;
  refs.videoEl.load();
  refs.videoEl.currentTime = 0;
  updatePlayerOverlay();
  setControlTimeUI(0, 0);
  updatePlayButton();

  if (broadcast && state.joined) {
    state.socket?.emit("media:change", media, (ack) => {
      if (!ack || !ack.ok) {
        setHint(`同步切换失败：${ack?.message || "未知错误"}`);
      }
    });
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
      if (video.paused) {
        video.play().catch(() => {});
      }
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

async function joinRoom(targetRoomId = "") {
  if (!state.socket) {
    setHint("连接尚未建立");
    return;
  }
  const roomId = (targetRoomId || refs.roomIdInput.value).trim();
  const nickname = refs.nicknameInput.value.trim() || generateRandomNickname();
  if (!roomId) {
    setHint("请先输入房间号");
    return;
  }

  refs.roomIdInput.value = roomId;
  refs.nicknameInput.value = nickname;
  localStorage.setItem("vo_nickname", nickname);
  localStorage.setItem("vo_room_id", roomId);

  state.socket.emit("room:join", { roomId, nickname }, (ack) => {
    if (!ack || !ack.ok) {
      setHint(`加入失败：${ack?.message || "未知错误"}`);
      return;
    }
    state.joined = true;
    state.roomId = roomId;
    state.nickname = nickname;
    updateStatusLine();
    setHint("已加入房间");
  });
}

function leaveRoom() {
  if (!state.socket) return;
  state.socket.emit("room:leave");
  state.joined = false;
  state.roomId = "";
  state.controllerId = "";
  state.members = [];
  renderMembers();
  setHint("已离开房间");
}

async function refreshLobbyByApi() {
  try {
    const data = await fetchJson("/api/lobby/rooms");
    state.lobbyRooms = data.rooms || [];
    renderLobbyRooms();
  } catch (error) {
    setHint(`大厅刷新失败：${error.message}`);
  }
}

function handleFullscreenChange() {
  const opened = document.fullscreenElement === refs.videoStage;
  refs.fullscreenDanmakuBar.classList.toggle("hidden", !opened);
  if (opened) {
    refs.fullscreenDanmakuInput.focus();
  }
}

async function toggleFullscreen() {
  if (document.fullscreenElement === refs.videoStage) {
    await document.exitFullscreen();
    return;
  }
  await refs.videoStage.requestFullscreen();
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
  refs.videoEl.addEventListener("ratechange", () => {
    updateRateButton();
    emitSync("ratechange");
  });
  refs.videoEl.addEventListener("volumechange", () => {
    refs.volumeRange.value = String(refs.videoEl.volume);
    updateMuteButton();
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
  refs.videoEl.addEventListener("seeked", () => {
    emitSync("seek");
  });
  refs.videoEl.addEventListener("ended", () => {
    emitSync("ended");
  });
}

function bindControls() {
  refs.playToggleBtn.addEventListener("click", () => {
    if (!state.media?.url) return;
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
}

function bindGateActions() {
  refs.accessEnterBtn.addEventListener("click", async () => {
    const password = refs.accessPasswordInput.value.trim();
    if (!password) {
      refs.gateHint.textContent = "请输入密码";
      return;
    }
    try {
      await fetchJson("/api/access/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      refs.accessPasswordInput.value = "";
      refs.gateHint.textContent = "验证成功，正在进入...";
      await unlockApp();
    } catch (error) {
      refs.gateHint.textContent = `验证失败：${error.message}`;
    }
  });

  refs.accessPasswordInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      refs.accessEnterBtn.click();
    }
  });
}

function bindTopActions() {
  refs.randomNicknameBtn.addEventListener("click", () => {
    refs.nicknameInput.value = generateRandomNickname();
  });
  refs.randomRoomBtn.addEventListener("click", () => {
    refs.roomIdInput.value = generateRandomRoomId();
  });
  refs.quickCreateBtn.addEventListener("click", async () => {
    if (!refs.nicknameInput.value.trim()) {
      refs.nicknameInput.value = generateRandomNickname();
    }
    refs.roomIdInput.value = generateRandomRoomId();
    await joinRoom(refs.roomIdInput.value);
  });
  refs.joinBtn.addEventListener("click", () => joinRoom());
  refs.leaveBtn.addEventListener("click", leaveRoom);
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
  refs.refreshLobbyBtn.addEventListener("click", refreshLobbyByApi);
}

function bindFileActions() {
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
}

function bindChatAndDanmakuActions() {
  refs.chatSendBtn.addEventListener("click", sendChat);
  refs.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendChat();
  });

  refs.sendDanmakuBtn.addEventListener("click", () => sendDanmaku(false));
  refs.sendDanmakuBtn2.addEventListener("click", () => sendDanmaku(false));
  refs.fullscreenDanmakuSendBtn.addEventListener("click", () => sendDanmaku(true));
  refs.fullscreenExitBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  });
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
}

function bindSocketEvents(socket) {
  socket.on("connect", () => {
    state.connected = true;
    updateStatusLine();
    socket.emit("lobby:get", (ack) => {
      if (ack?.ok) {
        state.lobbyRooms = ack.rooms || [];
        renderLobbyRooms();
      }
    });
  });

  socket.on("disconnect", () => {
    state.connected = false;
    updateStatusLine();
  });

  socket.on("connect_error", (error) => {
    if (String(error?.message || "").includes("UNAUTHORIZED")) {
      state.authorized = false;
      refs.appRoot.classList.add("hidden");
      refs.accessGate.classList.remove("hidden");
      refs.gateHint.textContent = "授权已失效，请重新输入密码";
      if (state.socket) {
        state.socket.disconnect();
        state.socket = null;
      }
    }
  });

  socket.on("lobby:update", (payload) => {
    state.lobbyRooms = payload?.rooms || [];
    renderLobbyRooms();
  });

  socket.on("room:welcome", async (snapshot) => {
    state.joined = true;
    state.selfId = snapshot.selfId || "";
    state.roomId = snapshot.roomId || "";
    state.controllerId = snapshot.controllerId || "";
    state.members = snapshot.members || [];
    renderMembers();
    resetChat(snapshot.chatHistory || []);
    clearDanmakuLayer();
    (snapshot.danmakuHistory || []).slice(-30).forEach(spawnDanmaku);

    if (snapshot.media?.url) {
      await setMedia(snapshot.media, false);
      if (snapshot.syncState) {
        applyRemoteSync(snapshot.syncState, true);
      }
    }
  });

  socket.on("room:member_update", (payload) => {
    state.controllerId = payload?.controllerId || "";
    state.members = payload?.members || [];
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

function initSocket() {
  if (state.socket) {
    return state.socket;
  }
  const socket = io({
    transports: ["websocket", "polling"],
    withCredentials: true
  });
  state.socket = socket;
  bindSocketEvents(socket);
  return socket;
}

async function initAfterUnlock() {
  const savedNickname = localStorage.getItem("vo_nickname") || generateRandomNickname();
  const savedRoomId = localStorage.getItem("vo_room_id") || generateRandomRoomId();
  refs.nicknameInput.value = savedNickname;
  refs.roomIdInput.value = savedRoomId;

  bindTopActions();
  bindFileActions();
  bindControls();
  bindVideoEvents();
  bindChatAndDanmakuActions();
  document.addEventListener("fullscreenchange", handleFullscreenChange);

  try {
    const health = await fetchJson("/api/health");
    state.syncDriftThreshold = Number(health.syncDriftThreshold || 0.4);
  } catch {
    // no-op
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
  await refreshLobbyByApi();
  updateStatusLine();
  updateMuteButton();
  updatePlayButton();
  updateRateButton();
  updatePlayerOverlay();

  state.heartbeatTimer = setInterval(() => {
    if (!state.joined || !state.media || !isController()) return;
    if (refs.videoEl.paused) return;
    emitSync("heartbeat");
  }, 1000);
}

async function unlockApp() {
  if (state.authorized) {
    return;
  }
  state.authorized = true;
  refs.accessGate.classList.add("hidden");
  refs.appRoot.classList.remove("hidden");
  await initAfterUnlock();
}

async function bootstrap() {
  bindGateActions();
  try {
    const status = await fetchJson("/api/access/status");
    if (status.authorized) {
      await unlockApp();
      return;
    }
    refs.accessGate.classList.remove("hidden");
    refs.appRoot.classList.add("hidden");
  } catch {
    refs.gateHint.textContent = "服务器不可用，请稍后重试";
  }
}

bootstrap();
