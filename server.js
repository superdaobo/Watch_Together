require("dotenv").config();

const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");

const cors = require("cors");
const express = require("express");
const { Server } = require("socket.io");
const { GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");

const { createRoomHub } = require("./src/room-hub");
const { S3MediaService } = require("./src/s3-media");

const PORT = Number(process.env.PORT || 3000);
const ACCESS_COOKIE_NAME = "vo_access";
const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
const APP_ACCESS_PASSWORD = String(process.env.APP_ACCESS_PASSWORD || "520");
const SYNC_DRIFT_THRESHOLD = Number(process.env.SYNC_DRIFT_THRESHOLD || 0.4);
const ROOM_CHAT_LIMIT = Number(process.env.ROOM_CHAT_LIMIT || 300);
const ROOM_DANMAKU_LIMIT = Number(process.env.ROOM_DANMAKU_LIMIT || 500);

const accessSessions = new Map();

function parseCookieHeader(rawCookieHeader = "") {
  return String(rawCookieHeader)
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const idx = part.indexOf("=");
      if (idx <= 0) return acc;
      const key = part.slice(0, idx).trim();
      const value = decodeURIComponent(part.slice(idx + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

function readAccessTokenFromRequest(req) {
  const cookies = parseCookieHeader(req.headers.cookie || "");
  return String(cookies[ACCESS_COOKIE_NAME] || "");
}

function clearExpiredSessions() {
  const current = Date.now();
  for (const [token, meta] of accessSessions.entries()) {
    if (!meta || meta.expiresAt <= current) {
      accessSessions.delete(token);
    }
  }
}

function hasValidAccessToken(token) {
  if (!token) return false;
  clearExpiredSessions();
  const meta = accessSessions.get(token);
  return Boolean(meta && meta.expiresAt > Date.now());
}

function touchAccessToken(token) {
  if (!hasValidAccessToken(token)) return false;
  accessSessions.set(token, { expiresAt: Date.now() + ACCESS_TTL_MS });
  return true;
}

function issueAccessToken() {
  const token = crypto.randomBytes(24).toString("hex");
  accessSessions.set(token, { expiresAt: Date.now() + ACCESS_TTL_MS });
  return token;
}

function writeAccessCookie(res, token) {
  const secure = process.env.NODE_ENV === "production";
  const parts = [
    `${ACCESS_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${Math.floor(ACCESS_TTL_MS / 1000)}`,
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAccessCookie(res) {
  const secure = process.env.NODE_ENV === "production";
  const parts = [`${ACCESS_COOKIE_NAME}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function requireAccess(req, res, next) {
  const token = readAccessTokenFromRequest(req);
  if (!hasValidAccessToken(token)) {
    res.status(401).json({
      ok: false,
      message: "未授权，请先输入访问密码"
    });
    return;
  }
  touchAccessToken(token);
  next();
}

function parseBoolean(input, fallback = true) {
  if (typeof input === "boolean") return input;
  const text = String(input || "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const mediaService = new S3MediaService({
  endpoint: process.env.S3_ENDPOINT || "https://s3.cstcloud.cn",
  bucket: process.env.S3_BUCKET || "45d9d363becd4f38b6d19392e7536e52",
  region: process.env.S3_REGION || "us-east-1",
  accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
  forcePathStyle: parseBoolean(process.env.S3_FORCE_PATH_STYLE, true),
  playMode: process.env.S3_PLAY_MODE || "signed-header",
  urlExpireSeconds: Number(process.env.S3_URL_EXPIRE_SECONDS || 1800),
  maxKeys: Number(process.env.S3_MAX_KEYS || 1000)
});

function parseRangeHeader(rawRange = "") {
  const value = String(rawRange || "").trim();
  if (!value) return "";
  if (/^bytes=\d*-\d*$/.test(value)) {
    return value;
  }
  return "";
}

function applyObjectHeaders(res, objectMeta = {}) {
  const contentType = String(objectMeta.ContentType || "").trim();
  const contentLength = Number(objectMeta.ContentLength || 0);
  const contentRange = String(objectMeta.ContentRange || "").trim();
  const eTag = String(objectMeta.ETag || "").trim();
  const cacheControl = String(objectMeta.CacheControl || "").trim();
  const lastModified = objectMeta.LastModified ? new Date(objectMeta.LastModified).toUTCString() : "";

  res.setHeader("Accept-Ranges", "bytes");
  if (contentType) res.setHeader("Content-Type", contentType);
  if (Number.isFinite(contentLength) && contentLength >= 0) {
    res.setHeader("Content-Length", String(contentLength));
  }
  if (contentRange) res.setHeader("Content-Range", contentRange);
  if (eTag) res.setHeader("ETag", eTag);
  if (cacheControl) res.setHeader("Cache-Control", cacheControl);
  if (lastModified) res.setHeader("Last-Modified", lastModified);
}

async function pipeSdkBody(body, res) {
  if (!body) {
    res.end();
    return;
  }
  if (typeof body.pipe === "function") {
    await new Promise((resolve, reject) => {
      body.on("error", reject);
      res.on("close", resolve);
      body.pipe(res);
    });
    return;
  }
  if (typeof body.transformToByteArray === "function") {
    const chunk = await body.transformToByteArray();
    res.end(Buffer.from(chunk));
    return;
  }
  if (Buffer.isBuffer(body) || typeof body === "string") {
    res.end(body);
    return;
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      res.write(chunk);
    }
    res.end();
    return;
  }
  res.end();
}

io.use((socket, next) => {
  const cookies = parseCookieHeader(socket.request.headers.cookie || "");
  const token = String(cookies[ACCESS_COOKIE_NAME] || "");
  if (!hasValidAccessToken(token)) {
    next(new Error("UNAUTHORIZED"));
    return;
  }
  touchAccessToken(token);
  next();
});

const roomHub = createRoomHub(io, {
  chatLimit: ROOM_CHAT_LIMIT,
  danmakuLimit: ROOM_DANMAKU_LIMIT
});

app.use(
  cors({
    origin: true,
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
    syncDriftThreshold: SYNC_DRIFT_THRESHOLD,
    dataSource: "s3"
  });
});

app.post("/api/access/login", (req, res) => {
  const password = String(req.body?.password || "");
  if (!password || password !== APP_ACCESS_PASSWORD) {
    res.status(401).json({
      ok: false,
      message: "密码错误"
    });
    return;
  }
  const token = issueAccessToken();
  writeAccessCookie(res, token);
  res.json({ ok: true });
});

app.get("/api/access/status", (req, res) => {
  const token = readAccessTokenFromRequest(req);
  const authorized = hasValidAccessToken(token);
  if (authorized) touchAccessToken(token);
  res.json({ ok: true, authorized });
});

app.post("/api/access/logout", (req, res) => {
  const token = readAccessTokenFromRequest(req);
  if (token) {
    accessSessions.delete(token);
  }
  clearAccessCookie(res);
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/access/")) {
    next();
    return;
  }
  requireAccess(req, res, next);
});

app.get("/api/lobby/rooms", (_req, res) => {
  res.json({
    ok: true,
    rooms: roomHub.getLobbyRooms(),
    serverTime: Date.now()
  });
});

app.get("/api/cx/config", (_req, res) => {
  res.json({
    ok: true,
    config: mediaService.getSafeConfig()
  });
});

app.post("/api/cx/reload-config", (req, res) => {
  const body = req.body || {};
  mediaService.setRuntimeConfig({
    endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
    bucket: typeof body.bucket === "string" ? body.bucket : undefined,
    region: typeof body.region === "string" ? body.region : undefined,
    accessKeyId: typeof body.accessKeyId === "string" ? body.accessKeyId : undefined,
    secretAccessKey: typeof body.secretAccessKey === "string" ? body.secretAccessKey : undefined,
    forcePathStyle: typeof body.forcePathStyle === "boolean" ? body.forcePathStyle : undefined,
    playMode: typeof body.playMode === "string" ? body.playMode : undefined,
    urlExpireSeconds: typeof body.urlExpireSeconds === "number" ? body.urlExpireSeconds : undefined,
    maxKeys: typeof body.maxKeys === "number" ? body.maxKeys : undefined
  });
  res.json({
    ok: true,
    config: mediaService.getSafeConfig()
  });
});

app.get("/api/cx/list", async (req, res) => {
  try {
    const folderId = String(req.query.folderId || "-1");
    const data = await mediaService.listFolder(folderId);
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
    const link = await mediaService.getPlayableLink(fileId);
    res.json({
      ok: true,
      fileId,
      duration: link.duration,
      fileStatus: link.fileStatus,
      url: link.url,
      playUrl: link.playUrl || link.url,
      directUrl: link.directUrl || "",
      previewUrl: link.previewUrl || "",
      downloadUrl: link.downloadUrl || "",
      candidateUrls: link.candidateUrls || [],
      contentLength: Number(link.contentLength || 0)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message || "获取播放地址失败"
    });
  }
});

app.get("/api/cx/proxy/:fileId", async (req, res) => {
  try {
    const fileId = decodeURIComponent(String(req.params.fileId || "").trim());
    if (!fileId) {
      res.status(400).json({
        ok: false,
        message: "fileId 不能为空"
      });
      return;
    }

    const client = mediaService.getClient();
    const range = parseRangeHeader(req.headers.range);
    const command = new GetObjectCommand({
      Bucket: mediaService.bucket,
      Key: fileId,
      Range: range || undefined
    });
    const object = await client.send(command);
    const statusCode = Number(object.$metadata?.httpStatusCode || (object.ContentRange ? 206 : 200));

    applyObjectHeaders(res, object);
    res.status(statusCode >= 200 && statusCode < 600 ? statusCode : 200);
    await pipeSdkBody(object.Body, res);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = Number(error?.$metadata?.httpStatusCode || 500);
    res.status(status >= 400 && status < 600 ? status : 500).json({
      ok: false,
      message: error?.name === "NoSuchKey" ? "文件不存在" : error?.message || "S3 代理播放失败"
    });
  }
});

app.head("/api/cx/proxy/:fileId", async (req, res) => {
  try {
    const fileId = decodeURIComponent(String(req.params.fileId || "").trim());
    if (!fileId) {
      res.status(400).end();
      return;
    }
    const client = mediaService.getClient();
    const object = await client.send(
      new HeadObjectCommand({
        Bucket: mediaService.bucket,
        Key: fileId
      })
    );
    applyObjectHeaders(res, object);
    res.status(200).end();
  } catch (error) {
    const status = Number(error?.$metadata?.httpStatusCode || 500);
    res.status(status >= 400 && status < 600 ? status : 500).end();
  }
});

app.post("/api/cx/sign", async (req, res) => {
  try {
    const fileId = String(req.body?.fileId || "").trim();
    const method = String(req.body?.method || "GET").trim().toUpperCase();
    const range = String(req.body?.range || "").trim();
    if (!fileId) {
      res.status(400).json({
        ok: false,
        message: "fileId 不能为空"
      });
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      res.status(400).json({
        ok: false,
        message: "method 仅支持 GET/HEAD"
      });
      return;
    }

    const signed = await mediaService.signObjectRequest(fileId, {
      method,
      range
    });

    res.json({
      ok: true,
      fileId,
      method: signed.method,
      url: signed.url,
      headers: signed.headers
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message || "生成签名失败"
    });
  }
});

app.get("/api/cx/first-video", async (_req, res) => {
  try {
    const item = await mediaService.getFirstVideo();
    res.json({
      ok: true,
      item
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message || "读取 S3 视频失败"
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
