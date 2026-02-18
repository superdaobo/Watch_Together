const state = {
  authorized: false,
  socket: null,
  connected: false,
  rooms: []
};

const refs = {
  accessGate: document.getElementById("accessGate"),
  lobbyApp: document.getElementById("lobbyApp"),
  accessPasswordInput: document.getElementById("accessPasswordInput"),
  accessEnterBtn: document.getElementById("accessEnterBtn"),
  gateHint: document.getElementById("gateHint"),
  connectState: document.getElementById("connectState"),
  lobbyCountState: document.getElementById("lobbyCountState"),
  refreshLobbyBtn: document.getElementById("refreshLobbyBtn"),
  nicknameInput: document.getElementById("nicknameInput"),
  randomNicknameBtn: document.getElementById("randomNicknameBtn"),
  roomIdInput: document.getElementById("roomIdInput"),
  randomRoomBtn: document.getElementById("randomRoomBtn"),
  quickCreateBtn: document.getElementById("quickCreateBtn"),
  enterRoomBtn: document.getElementById("enterRoomBtn"),
  lobbyHint: document.getElementById("lobbyHint"),
  lobbyRoomList: document.getElementById("lobbyRoomList")
};

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function generateRandomNickname() {
  const prefix = ["星河", "晚风", "柠檬", "山海", "橘猫", "浮光", "灯塔", "云雀", "鲸落", "青柚"];
  const suffix = ["同学", "队友", "观众", "影迷", "旅人", "玩家", "探长", "学者"];
  return `${randomFrom(prefix)}${randomFrom(suffix)}${Math.floor(Math.random() * 90 + 10)}`;
}

function generateRandomRoomId() {
  return `room-${Math.random().toString(36).slice(2, 6)}-${Math.floor(Math.random() * 900 + 100)}`;
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

function updateStatus() {
  refs.connectState.textContent = state.connected ? "已连接" : "未连接";
  refs.lobbyCountState.textContent = `在线房间：${state.rooms.length}`;
}

function renderRooms() {
  refs.lobbyRoomList.innerHTML = "";
  if (!state.rooms.length) {
    refs.lobbyHint.textContent = "当前暂无在线房间，你可以快速建房。";
    updateStatus();
    return;
  }
  refs.lobbyHint.textContent = "点击房间可直接进入。";
  state.rooms.forEach((room) => {
    const row = document.createElement("div");
    row.className = "lobby-item";
    row.innerHTML = `
      <div>
        <strong>${room.roomId}</strong>
        <div class="hint">在线 ${room.onlineCount} · ${room.hasMedia ? `播放中：${room.mediaName || "未命名视频"}` : "暂无视频"}</div>
      </div>
    `;
    const enterBtn = document.createElement("button");
    enterBtn.className = "btn ghost small";
    enterBtn.textContent = "进入";
    enterBtn.addEventListener("click", () => {
      const nickname = refs.nicknameInput.value.trim() || generateRandomNickname();
      refs.nicknameInput.value = nickname;
      enterRoom(room.roomId, nickname);
    });
    row.appendChild(enterBtn);
    refs.lobbyRoomList.appendChild(row);
  });
  updateStatus();
}

async function refreshRooms() {
  try {
    const data = await fetchJson("/api/lobby/rooms");
    state.rooms = data.rooms || [];
    renderRooms();
  } catch (error) {
    refs.lobbyHint.textContent = `大厅刷新失败：${error.message}`;
  }
}

function enterRoom(roomId, nickname) {
  const room = String(roomId || "").trim();
  if (!room) {
    refs.lobbyHint.textContent = "请先输入房间号";
    return;
  }
  const nick = String(nickname || "").trim() || generateRandomNickname();
  localStorage.setItem("vo_nickname", nick);
  localStorage.setItem("vo_room_id", room);
  location.href = `/room.html?room=${encodeURIComponent(room)}&nick=${encodeURIComponent(nick)}`;
}

function bindActions() {
  refs.randomNicknameBtn.addEventListener("click", () => {
    refs.nicknameInput.value = generateRandomNickname();
  });
  refs.randomRoomBtn.addEventListener("click", () => {
    refs.roomIdInput.value = generateRandomRoomId();
  });
  refs.quickCreateBtn.addEventListener("click", () => {
    if (!refs.nicknameInput.value.trim()) {
      refs.nicknameInput.value = generateRandomNickname();
    }
    refs.roomIdInput.value = generateRandomRoomId();
    enterRoom(refs.roomIdInput.value, refs.nicknameInput.value);
  });
  refs.enterRoomBtn.addEventListener("click", () => {
    enterRoom(refs.roomIdInput.value, refs.nicknameInput.value);
  });
  refs.refreshLobbyBtn.addEventListener("click", refreshRooms);
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
    updateStatus();
    socket.emit("lobby:get", (ack) => {
      if (ack?.ok) {
        state.rooms = ack.rooms || [];
        renderRooms();
      }
    });
  });

  socket.on("disconnect", () => {
    state.connected = false;
    updateStatus();
  });

  socket.on("lobby:update", (payload) => {
    state.rooms = payload?.rooms || [];
    renderRooms();
  });

  socket.on("connect_error", (error) => {
    if (String(error?.message || "").includes("UNAUTHORIZED")) {
      state.authorized = false;
      refs.lobbyApp.classList.add("hidden");
      refs.accessGate.classList.remove("hidden");
      refs.gateHint.textContent = "授权已失效，请重新输入密码";
      socket.close();
      state.socket = null;
    }
  });
}

async function unlockLobby() {
  if (state.authorized) return;
  state.authorized = true;
  refs.accessGate.classList.add("hidden");
  refs.lobbyApp.classList.remove("hidden");
  refs.nicknameInput.value = localStorage.getItem("vo_nickname") || generateRandomNickname();
  refs.roomIdInput.value = localStorage.getItem("vo_room_id") || generateRandomRoomId();
  bindActions();
  initSocket();
  await refreshRooms();
}

function bindGate() {
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
      refs.gateHint.textContent = "验证成功，正在进入大厅...";
      refs.accessPasswordInput.value = "";
      await unlockLobby();
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

async function bootstrap() {
  bindGate();
  try {
    const status = await fetchJson("/api/access/status");
    if (status.authorized) {
      await unlockLobby();
      return;
    }
    refs.accessGate.classList.remove("hidden");
    refs.lobbyApp.classList.add("hidden");
  } catch {
    refs.gateHint.textContent = "服务器不可用，请稍后重试";
  }
}

bootstrap();
