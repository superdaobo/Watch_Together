const crypto = require("node:crypto");
const https = require("node:https");
const { URL } = require("node:url");

const CHA0XING_LOGIN_URL = "https://passport2.chaoxing.com/fanyalogin";
const GROUP_API_BASE = "https://groupweb.chaoxing.com";
const DOWNLOAD_API_BASE = "https://noteyd.chaoxing.com";
const REFERER = "https://chaoxing.com/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const AES_KEY = "u2oh6Vu^HWe4_AES";
const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".mov",
  ".m4v",
  ".avi",
  ".flv",
  ".m3u8",
  ".ts"
]);

function extname(filename) {
  const normalized = String(filename || "").trim();
  const idx = normalized.lastIndexOf(".");
  if (idx < 0) {
    return "";
  }
  return normalized.slice(idx).toLowerCase();
}

function encryptByAes(raw) {
  const key = Buffer.from(AES_KEY, "utf8");
  const iv = key.subarray(0, 16);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(String(raw || ""), "utf8"), cipher.final()]);
  return encrypted.toString("base64");
}

function parseSetCookie(setCookieHeaders) {
  if (!Array.isArray(setCookieHeaders)) {
    return "";
  }
  return setCookieHeaders.map((line) => String(line).split(";")[0]).join("; ");
}

function toQueryUrl(base, pathname, query = {}) {
  const url = new URL(pathname, base);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

class ChaoxingClient {
  constructor(options = {}) {
    this.userName = String(options.userName || "");
    this.password = String(options.password || "");
    this.bbsid = String(options.bbsid || "");
    this.rootFolderId = String(options.rootFolderId || "-1");
    this.cookie = String(options.cookie || "");
  }

  setRuntimeConfig(next = {}) {
    if (typeof next.userName === "string") this.userName = next.userName;
    if (typeof next.password === "string") this.password = next.password;
    if (typeof next.bbsid === "string") this.bbsid = next.bbsid;
    if (typeof next.rootFolderId === "string") this.rootFolderId = next.rootFolderId;
    if (typeof next.cookie === "string") this.cookie = next.cookie;
  }

  validateReady() {
    if (!this.bbsid) {
      throw new Error("缺少超星配置：CX_BBSID");
    }
    if (!this.cookie && (!this.userName || !this.password)) {
      throw new Error("缺少超星登录信息：请配置 CX_COOKIE 或 CX_USER_NAME/CX_PASSWORD");
    }
  }

  async ensureCookie() {
    if (this.cookie) {
      return this.cookie;
    }
    await this.login();
    return this.cookie;
  }

  async login() {
    if (!this.userName || !this.password) {
      throw new Error("无法登录超星：缺少用户名或密码");
    }
    const uname = encryptByAes(this.userName);
    const password = encryptByAes(this.password);
    const boundary = `----NodeBoundary${crypto.randomBytes(8).toString("hex")}`;
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="uname"\r\n\r\n${uname}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${password}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="t"\r\n\r\ntrue\r\n`,
      `--${boundary}--\r\n`
    ];
    const body = Buffer.from(parts.join(""), "utf8");

    const cookie = await new Promise((resolve, reject) => {
      const request = https.request(
        CHA0XING_LOGIN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": String(body.length),
            "User-Agent": USER_AGENT,
            Referer: REFERER
          }
        },
        (response) => {
          const setCookie = response.headers["set-cookie"];
          const merged = parseSetCookie(Array.isArray(setCookie) ? setCookie : []);
          response.resume();
          if (!merged) {
            reject(new Error("超星登录失败：未返回有效 Cookie"));
            return;
          }
          resolve(merged);
        }
      );
      request.on("error", reject);
      request.write(body);
      request.end();
    });

    this.cookie = cookie;
    return cookie;
  }

  async requestJson(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body
    });
    const text = await response.text();
    const json = parseJsonSafe(text);
    if (!response.ok) {
      throw new Error(`超星请求失败: HTTP ${response.status}`);
    }
    if (!json) {
      throw new Error("超星返回了非 JSON 响应");
    }
    return json;
  }

  async requestGroup(pathname, query = {}, retry = true) {
    this.validateReady();
    const cookie = await this.ensureCookie();
    const url = toQueryUrl(GROUP_API_BASE, pathname, query);
    try {
      return await this.requestJson(url, {
        method: "GET",
        headers: {
          Cookie: cookie,
          Accept: "application/json, text/plain, */*",
          Referer: REFERER,
          "User-Agent": USER_AGENT
        }
      });
    } catch (error) {
      if (retry && this.userName && this.password) {
        this.cookie = "";
        await this.login();
        return this.requestGroup(pathname, query, false);
      }
      throw error;
    }
  }

  async requestDownload(pathname, retry = true) {
    this.validateReady();
    const cookie = await this.ensureCookie();
    const url = toQueryUrl(DOWNLOAD_API_BASE, pathname, {});
    try {
      return await this.requestJson(url, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Accept: "application/json, text/plain, */*",
          Referer: REFERER,
          "User-Agent": USER_AGENT
        }
      });
    } catch (error) {
      if (retry && this.userName && this.password) {
        this.cookie = "";
        await this.login();
        return this.requestDownload(pathname, false);
      }
      throw error;
    }
  }

  async listFolder(folderId) {
    const targetFolderId = String(folderId || this.rootFolderId || "-1");
    const common = {
      bbsid: this.bbsid,
      folderId: targetFolderId
    };
    const folderResp = await this.requestGroup("/pc/resource/getResourceList", {
      ...common,
      recType: "1"
    });
    const fileResp = await this.requestGroup("/pc/resource/getResourceList", {
      ...common,
      recType: "2"
    });

    if (Number(folderResp.result) !== 1 || Number(fileResp.result) !== 1) {
      const reason = folderResp.msg || fileResp.msg || "未知错误";
      throw new Error(`读取目录失败: ${reason}`);
    }

    const folders = Array.isArray(folderResp.list) ? folderResp.list : [];
    const files = Array.isArray(fileResp.list) ? fileResp.list : [];

    const normalizedFolders = folders
      .map((item) => {
        const folderName = item?.content?.folderName || `folder-${item?.id ?? ""}`;
        const modified = Number(item?.inserttime || 0);
        return {
          itemType: "folder",
          id: String(item?.id ?? ""),
          parentId: String(item?.content?.pid ?? targetFolderId),
          name: folderName,
          size: 0,
          fileId: "",
          objectId: "",
          duration: 0,
          modified,
          isVideo: false
        };
      })
      .filter((item) => item.id);

    const normalizedFiles = files
      .map((item) => {
        const content = item?.content || {};
        const name = content.name || `file-${item?.id ?? ""}`;
        const fileId = String(content.fileId || content.objectId || "");
        const modified = Number(content.uploadDate || item?.inserttime || 0);
        const size = Number(content.size || 0);
        return {
          itemType: "file",
          id: String(item?.id ?? ""),
          parentId: String(content.pid ?? targetFolderId),
          name,
          size: Number.isFinite(size) ? size : 0,
          fileId,
          objectId: String(content.objectId || ""),
          duration: Number(content.duration || 0),
          modified,
          isVideo: VIDEO_EXTENSIONS.has(extname(name))
        };
      })
      .filter((item) => item.id && item.fileId);

    const items = [...normalizedFolders, ...normalizedFiles].sort((a, b) => {
      if (a.itemType !== b.itemType) {
        return a.itemType === "folder" ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });

    return {
      folderId: targetFolderId,
      items
    };
  }

  async getPlayableLink(fileId) {
    const normalized = String(fileId || "").trim();
    if (!normalized) {
      throw new Error("缺少 fileId");
    }
    const payload = await this.requestDownload(`/screen/note_note/files/status/${normalized}`);
    const download = payload.download || payload.url || "";
    if (!download) {
      throw new Error(`获取播放链接失败: ${payload.msg || "无可用下载地址"}`);
    }
    return {
      url: download,
      duration: Number(payload.duration || 0),
      fileStatus: payload.fileStatus || "",
      requiresCookie: false
    };
  }

  async getPlaybackHeaders(rangeHeaderValue = "") {
    this.validateReady();
    const cookie = await this.ensureCookie();
    const headers = {
      Accept: "*/*",
      Referer: REFERER,
      "User-Agent": USER_AGENT,
      Cookie: cookie
    };
    if (rangeHeaderValue) {
      headers.Range = String(rangeHeaderValue);
    }
    return headers;
  }

  getSafeConfig() {
    return {
      bbsid: this.bbsid,
      rootFolderId: this.rootFolderId,
      hasCookie: Boolean(this.cookie),
      hasAccount: Boolean(this.userName && this.password)
    };
  }
}

module.exports = {
  ChaoxingClient
};
