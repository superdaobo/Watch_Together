require("dotenv").config();

const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { Readable } = require("node:stream");

const cors = require("cors");
const express = require("express");
const { Server } = require("socket.io");

const { ChaoxingClient } = require("./src/chaoxing-client");
const { createRoomHub } = require("./src/room-hub");

const PORT = Number(process.env.PORT || 3000);
const ACCESS_COOKIE_NAME = "vo_access";
const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
const APP_ACCESS_PASSWORD = String(process.env.APP_ACCESS_PASSWORD || "520");
const SYNC_DRIFT_THRESHOLD = Number(process.env.SYNC_DRIFT_THRESHOLD || 0.4);
const ROOM_CHAT_LIMIT = Number(process.env.ROOM_CHAT_LIMIT || 300);
const ROOM_DANMAKU_LIMIT = Number(process.env.ROOM_DANMAKU_LIMIT || 500);
const RELAY_LINK_CACHE_MS = Number(process.env.CX_RELAY_LINK_CACHE_MS || 45000);
const RELAY_REFERER = String(process.env.CX_MEDIA_REFERER || "https://chaoxing.com/");
const RELAY_USER_AGENT = String(
  process.env.CX_MEDIA_UA ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
);

const accessSessions = new Map();
const relayLinkCache = new Map();

function isAllowedRelayUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return false;
  try {
    const parsed = new URL(input);
    const protocolOk = parsed.protocol === "https:" || parsed.protocol === "http:";
    const host = parsed.hostname.toLowerCase();
    const hostOk = host.endsWith(".cldisk.com") || host.endsWith(".chaoxing.com");
    return protocolOk && hostOk;
  } catch {
    return false;
  }
}

function pickRelayUrls(link, preferredIndex = 0) {
  const list = Array.isArray(link?.candidateUrls) ? link.candidateUrls : [];
  const unique = [];
  list.forEach((item) => {
    const target = String(item || "").trim();
    if (target && isAllowedRelayUrl(target) && !unique.includes(target)) {
      unique.push(target);
    }
  });
  const fallback = String(link?.url || "").trim();
  if (fallback && isAllowedRelayUrl(fallback) && !unique.includes(fallback)) {
    unique.push(fallback);
  }
  if (!unique.length) {
    return [];
  }
  const safeIndex = Number.isFinite(preferredIndex) ? Math.max(0, Math.floor(preferredIndex)) : 0;
  if (safeIndex <= 0 || safeIndex >= unique.length) {
    return unique;
  }
  return [unique[safeIndex], ...unique.filter((_, idx) => idx !== safeIndex)];
}

async function getPlayableLinkCached(fileId, forceRefresh = false) {
  const key = String(fileId || "").trim();
  if (!key) {
    throw new Error("fileId 涓嶈兘涓虹┖");
  }
  if (!forceRefresh) {
    const cache = relayLinkCache.get(key);
    if (cache && cache.expiresAt > Date.now()) {
      return cache.value;
    }
  }
  const value = await chaoxingClient.getPlayableLink(key);
  relayLinkCache.set(key, {
    value,
    expiresAt: Date.now() + RELAY_LINK_CACHE_MS
  });
  return value;
}

async function openRelayStream(urls, incomingRange = "") {
  const rangeValue = String(incomingRange || "").trim();
  const baseHeaders = {
    Accept: "*/*",
    Referer: RELAY_REFERER,
    "User-Agent": RELAY_USER_AGENT
  };
  if (rangeValue) {
    baseHeaders.Range = rangeValue;
  }

  for (const targetUrl of urls) {
    try {
      const response = await fetch(targetUrl, {
        method: "GET",
        headers: baseHeaders,
        redirect: "follow"
      });
      if (response.status >= 200 && response.status < 400) {
        return response;
      }
      if (response.body) {
        await response.body.cancel().catch(() => {});
      }
    } catch {
      // ignore and try next
    }
  }
  return null;
}

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

function parseAdditionJson() {
  const raw = String(process.env.CX_ADDITION_JSON || "").trim();
  if (!raw) return {};
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

const chaoxingClient = new ChaoxingClient(buildCxConfig());

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
    syncDriftThreshold: SYNC_DRIFT_THRESHOLD
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
  relayLinkCache.clear();
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
    const link = await getPlayableLinkCached(fileId);
    res.json({
      ok: true,
      fileId,
      duration: link.duration,
      fileStatus: link.fileStatus,
      url: link.url,
      previewUrl: link.previewUrl || "",
      downloadUrl: link.downloadUrl || "",
      candidateUrls: link.candidateUrls || []
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message || "获取播放地址失败"
    });
  }
});

app.get("/api/cx/relay", async (req, res) => {
  try {
    const fileId = String(req.query.fileId || "").trim();
    const sourceIndex = Number.parseInt(String(req.query.source || "0"), 10);
    if (!fileId) {
      res.status(400).json({
        ok: false,
        message: "fileId 涓嶈兘涓虹┖"
      });
      return;
    }

    const rangeHeader = String(req.headers.range || "").trim();
    const firstLink = await getPlayableLinkCached(fileId);
    let upstream = await openRelayStream(pickRelayUrls(firstLink, sourceIndex), rangeHeader);

    if (!upstream) {
      const refreshed = await getPlayableLinkCached(fileId, true);
      upstream = await openRelayStream(pickRelayUrls(refreshed, sourceIndex), rangeHeader);
    }

    if (!upstream || !upstream.body) {
      res.status(502).json({
        ok: false,
        message: "褰撳墠瑙嗛鏃犳硶寤虹珛鍏煎浼犺緭"
      });
      return;
    }

    res.status(upstream.status);
    const passHeaders = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "cache-control",
      "etag",
      "last-modified",
      "content-disposition"
    ];
    passHeaders.forEach((name) => {
      const value = upstream.headers.get(name);
      if (value) {
        res.setHeader(name, value);
      }
    });
    res.setHeader("x-video-relay", "1");

    const stream = Readable.fromWeb(upstream.body);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(502).end("relay stream error");
      } else {
        res.end();
      }
    });
    res.on("close", () => {
      stream.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message || "瑙嗛鍏煎浼犺緭澶辫触"
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
