const crypto = require("node:crypto");

function randomId() {
  return crypto.randomBytes(8).toString("hex");
}

function now() {
  return Date.now();
}

function clampNumber(input, min, max, fallback) {
  const num = Number(input);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

function cleanText(input, maxLength) {
  const text = String(input || "").trim();
  if (!text) {
    return "";
  }
  return text.slice(0, maxLength);
}

function pushWithLimit(list, value, limit) {
  list.push(value);
  while (list.length > limit) {
    list.shift();
  }
}

function sanitizeColor(input) {
  const raw = String(input || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
    return raw;
  }
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    return raw;
  }
  return "#ffffff";
}

function createDefaultState() {
  return {
    playing: false,
    currentTime: 0,
    playbackRate: 1,
    serverTime: now(),
    reason: "init"
  };
}

function createRoomHub(io, options = {}) {
  const rooms = new Map();
  const chatLimit = clampNumber(options.chatLimit, 20, 5000, 300);
  const danmakuLimit = clampNumber(options.danmakuLimit, 20, 5000, 500);

  function getOrCreateRoom(roomId) {
    if (rooms.has(roomId)) {
      return rooms.get(roomId);
    }
    const room = {
      roomId,
      members: new Map(),
      controllerId: "",
      media: null,
      syncState: createDefaultState(),
      chatHistory: [],
      danmakuHistory: []
    };
    rooms.set(roomId, room);
    return room;
  }

  function getMemberList(room) {
    return Array.from(room.members.values()).sort((a, b) => a.joinedAt - b.joinedAt);
  }

  function emitRoomMeta(roomId) {
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }
    io.to(roomId).emit("room:member_update", {
      roomId,
      controllerId: room.controllerId,
      members: getMemberList(room),
      serverTime: now()
    });
  }

  function leaveRoom(socket) {
    const joinedRoomId = socket.data.roomId;
    if (!joinedRoomId) {
      return;
    }
    const room = rooms.get(joinedRoomId);
    if (!room) {
      socket.data.roomId = "";
      return;
    }

    room.members.delete(socket.id);
    socket.leave(joinedRoomId);
    socket.data.roomId = "";

    if (room.controllerId === socket.id) {
      const next = getMemberList(room)[0];
      room.controllerId = next ? next.socketId : "";
    }

    if (room.members.size === 0) {
      rooms.delete(joinedRoomId);
      return;
    }
    emitRoomMeta(joinedRoomId);
  }

  io.on("connection", (socket) => {
    socket.data.roomId = "";
    socket.data.nickname = "";

    socket.on("room:join", (payload = {}, ack) => {
      try {
        const roomId = cleanText(payload.roomId, 64);
        const nickname = cleanText(payload.nickname, 40) || "匿名用户";
        if (!roomId) {
          throw new Error("roomId 不能为空");
        }

        leaveRoom(socket);

        const room = getOrCreateRoom(roomId);
        const member = {
          socketId: socket.id,
          nickname,
          joinedAt: now()
        };
        room.members.set(socket.id, member);
        if (!room.controllerId) {
          room.controllerId = socket.id;
        }

        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.nickname = nickname;

        const snapshot = {
          selfId: socket.id,
          roomId,
          controllerId: room.controllerId,
          members: getMemberList(room),
          media: room.media,
          syncState: room.syncState,
          chatHistory: room.chatHistory,
          danmakuHistory: room.danmakuHistory,
          serverTime: now()
        };

        socket.emit("room:welcome", snapshot);
        emitRoomMeta(roomId);
        if (typeof ack === "function") {
          ack({ ok: true, snapshot });
        }
      } catch (error) {
        if (typeof ack === "function") {
          ack({ ok: false, message: error.message });
        }
      }
    });

    socket.on("room:leave", () => {
      leaveRoom(socket);
    });

    socket.on("controller:claim", (ack) => {
      const roomId = socket.data.roomId;
      if (!roomId) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "尚未加入房间" });
        }
        return;
      }
      const room = rooms.get(roomId);
      if (!room) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "房间不存在" });
        }
        return;
      }
      room.controllerId = socket.id;
      emitRoomMeta(roomId);
      if (typeof ack === "function") {
        ack({ ok: true });
      }
    });

    socket.on("media:change", (payload = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "尚未加入房间" });
        }
        return;
      }
      const room = rooms.get(roomId);
      if (!room) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "房间不存在" });
        }
        return;
      }
      if (room.controllerId && room.controllerId !== socket.id) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "只有主控可以切换视频" });
        }
        return;
      }

      const media = {
        id: cleanText(payload.id, 120) || randomId(),
        name: cleanText(payload.name, 200),
        fileId: cleanText(payload.fileId, 120),
        url: cleanText(payload.url, 5000),
        duration: clampNumber(payload.duration, 0, 864000, 0),
        changedBy: socket.data.nickname || "未知",
        changedAt: now()
      };
      if (!media.url) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "缺少可播放地址" });
        }
        return;
      }
      room.media = media;
      room.syncState = {
        playing: false,
        currentTime: 0,
        playbackRate: 1,
        serverTime: now(),
        reason: "media-change"
      };

      io.to(roomId).emit("media:change", {
        media: room.media,
        syncState: room.syncState,
        serverTime: now()
      });
      if (typeof ack === "function") {
        ack({ ok: true });
      }
    });

    socket.on("sync:update", (payload = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "尚未加入房间" });
        }
        return;
      }
      const room = rooms.get(roomId);
      if (!room) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "房间不存在" });
        }
        return;
      }
      if (room.controllerId && room.controllerId !== socket.id) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "只有主控可以同步进度" });
        }
        return;
      }
      if (!room.media) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "当前无视频" });
        }
        return;
      }

      room.syncState = {
        playing: Boolean(payload.playing),
        currentTime: clampNumber(payload.currentTime, 0, 864000, 0),
        playbackRate: clampNumber(payload.playbackRate, 0.25, 4, 1),
        reason: cleanText(payload.reason, 40) || "sync",
        serverTime: now()
      };

      socket.to(roomId).emit("sync:state", {
        ...room.syncState,
        mediaId: room.media.id,
        fromSocketId: socket.id
      });
      if (typeof ack === "function") {
        ack({ ok: true, serverTime: room.syncState.serverTime });
      }
    });

    socket.on("chat:send", (payload = {}, ack) => {
      const roomId = socket.data.roomId;
      const room = roomId ? rooms.get(roomId) : null;
      if (!room) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "尚未加入房间" });
        }
        return;
      }

      const text = cleanText(payload.text, 500);
      if (!text) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "消息不能为空" });
        }
        return;
      }

      const message = {
        id: randomId(),
        text,
        type: cleanText(payload.type, 20) || "text",
        fromSocketId: socket.id,
        nickname: socket.data.nickname || "匿名用户",
        createdAt: now()
      };
      pushWithLimit(room.chatHistory, message, chatLimit);
      io.to(roomId).emit("chat:new", message);
      if (typeof ack === "function") {
        ack({ ok: true });
      }
    });

    socket.on("danmaku:send", (payload = {}, ack) => {
      const roomId = socket.data.roomId;
      const room = roomId ? rooms.get(roomId) : null;
      if (!room) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "尚未加入房间" });
        }
        return;
      }

      const text = cleanText(payload.text, 80);
      if (!text) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "弹幕不能为空" });
        }
        return;
      }

      const item = {
        id: randomId(),
        text,
        color: sanitizeColor(payload.color),
        videoTime: clampNumber(payload.videoTime, 0, 864000, 0),
        fromSocketId: socket.id,
        nickname: socket.data.nickname || "匿名用户",
        createdAt: now()
      };
      pushWithLimit(room.danmakuHistory, item, danmakuLimit);
      io.to(roomId).emit("danmaku:new", item);
      if (typeof ack === "function") {
        ack({ ok: true });
      }
    });

    socket.on("disconnect", () => {
      leaveRoom(socket);
    });
  });
}

module.exports = {
  createRoomHub
};
