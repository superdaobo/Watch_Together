require("dotenv").config();

const path = require("node:path");
const http = require("node:http");

const cors = require("cors");
const express = require("express");
const { Server } = require("socket.io");

const { ChaoxingClient } = require("./src/chaoxing-client");
const { createRoomHub } = require("./src/room-hub");

const PORT = Number(process.env.PORT || 3000);
const SYNC_DRIFT_THRESHOLD = Number(process.env.SYNC_DRIFT_THRESHOLD || 0.4);
const ROOM_CHAT_LIMIT = Number(process.env.ROOM_CHAT_LIMIT || 300);
const ROOM_DANMAKU_LIMIT = Number(process.env.ROOM_DANMAKU_LIMIT || 500);

function parseAdditionJson() {
  const raw = String(process.env.CX_ADDITION_JSON || "").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function buildCxConfig() {
  const addition = parseAdditionJson();
  return {
    userName: String(process.env.CX_USER_NAME || addition.user_name || ""),
    password: String(process.env.CX_PASSWORD || addition.password || ""),
    bbsid: String(process.env.CX_BBSID || addition.bbsid || ""),
    rootFolderId: String(process.env.CX_ROOT_FOLDER_ID || addition.root_folder_id || "-1"),
    cookie: String(process.env.CX_COOKIE || addition.cookie || "")
  };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const chaoxingClient = new ChaoxingClient(buildCxConfig());

createRoomHub(io, {
  chatLimit: ROOM_CHAT_LIMIT,
  danmakuLimit: ROOM_DANMAKU_LIMIT
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
    syncDriftThreshold: SYNC_DRIFT_THRESHOLD
  });
});

app.get("/api/cx/config", (_req, res) => {
  res.json({
    ok: true,
    config: chaoxingClient.getSafeConfig()
  });
});

app.post("/api/cx/reload-config", (req, res) => {
  const body = req.body || {};
  chaoxingClient.setRuntimeConfig({
    userName: typeof body.userName === "string" ? body.userName : undefined,
    password: typeof body.password === "string" ? body.password : undefined,
    bbsid: typeof body.bbsid === "string" ? body.bbsid : undefined,
    rootFolderId: typeof body.rootFolderId === "string" ? body.rootFolderId : undefined,
    cookie: typeof body.cookie === "string" ? body.cookie : undefined
  });
  res.json({
    ok: true,
    config: chaoxingClient.getSafeConfig()
  });
});

app.get("/api/cx/list", async (req, res) => {
  try {
    const folderId = String(req.query.folderId || chaoxingClient.rootFolderId || "-1");
    const data = await chaoxingClient.listFolder(folderId);
    res.json({
      ok: true,
      folderId: data.folderId,
      items: data.items
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message || "读取目录失败"
    });
  }
});

app.get("/api/cx/link", async (req, res) => {
  try {
    const fileId = String(req.query.fileId || "").trim();
    if (!fileId) {
      res.status(400).json({
        ok: false,
        message: "fileId 不能为空"
      });
      return;
    }
    const link = await chaoxingClient.getPlayableLink(fileId);
    res.json({
      ok: true,
      fileId,
      ...link
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message || "获取播放地址失败"
    });
  }
});

app.use((err, _req, res, _next) => {
  res.status(500).json({
    ok: false,
    message: err?.message || "服务器异常"
  });
});

server.listen(PORT, () => {
  console.log(`sync video server listening on http://0.0.0.0:${PORT}`);
});
