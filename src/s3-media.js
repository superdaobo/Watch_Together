const path = require("node:path");
const { S3Client, HeadObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { SignatureV4 } = require("@smithy/signature-v4");
const { HttpRequest } = require("@smithy/protocol-http");
const { Hash } = require("@smithy/hash-node");

const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SIGNED_HEADER_ALLOW_LIST = new Set([
  "authorization",
  "x-amz-content-sha256",
  "x-amz-date",
  "x-amz-security-token",
  "range"
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".flv",
  ".m3u8",
  ".ts"
]);

function extname(filename) {
  return path.extname(String(filename || "")).toLowerCase();
}

function ensureEndpoint(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `https://${value}`;
}

function normalizeFolderPrefix(folderId) {
  const raw = String(folderId || "").trim();
  if (!raw || raw === "-1" || raw === "/") return "";
  const compact = raw.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!compact) return "";
  return `${compact}/`;
}

function folderIdFromPrefix(prefix) {
  const value = String(prefix || "").replace(/\/+$/, "");
  return value || "-1";
}

function encodeObjectKey(key) {
  return String(key || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function sanitizeMethod(rawMethod) {
  const method = String(rawMethod || "GET").trim().toUpperCase();
  if (method === "GET" || method === "HEAD") return method;
  return "GET";
}

function sanitizeRange(rawRange) {
  const value = String(rawRange || "").trim();
  if (!value) return "";
  if (/^bytes=\d*-\d*$/.test(value)) {
    return value;
  }
  return "";
}

class S3MediaService {
  constructor(options = {}) {
    this.endpoint = ensureEndpoint(options.endpoint || "");
    this.bucket = String(options.bucket || "").trim();
    this.region = String(options.region || "us-east-1").trim();
    this.accessKeyId = String(options.accessKeyId || "").trim();
    this.secretAccessKey = String(options.secretAccessKey || "").trim();
    this.forcePathStyle = options.forcePathStyle !== false;
    this.urlExpireSeconds = Number(options.urlExpireSeconds || 1800);
    this.maxKeys = Number(options.maxKeys || 1000);
    this.client = null;
    this.signer = null;
    this.endpointUrl = null;
  }

  setRuntimeConfig(next = {}) {
    if (typeof next.endpoint === "string") this.endpoint = ensureEndpoint(next.endpoint);
    if (typeof next.bucket === "string") this.bucket = next.bucket.trim();
    if (typeof next.region === "string") this.region = next.region.trim() || "us-east-1";
    if (typeof next.accessKeyId === "string") this.accessKeyId = next.accessKeyId.trim();
    if (typeof next.secretAccessKey === "string") this.secretAccessKey = next.secretAccessKey.trim();
    if (typeof next.forcePathStyle === "boolean") this.forcePathStyle = next.forcePathStyle;
    if (typeof next.urlExpireSeconds === "number" && Number.isFinite(next.urlExpireSeconds)) {
      this.urlExpireSeconds = Math.min(86400, Math.max(60, Math.floor(next.urlExpireSeconds)));
    }
    if (typeof next.maxKeys === "number" && Number.isFinite(next.maxKeys)) {
      this.maxKeys = Math.min(5000, Math.max(50, Math.floor(next.maxKeys)));
    }
    this.client = null;
    this.signer = null;
    this.endpointUrl = null;
  }

  validateReady() {
    if (!this.endpoint) throw new Error("缺少 S3_ENDPOINT");
    if (!this.bucket) throw new Error("缺少 S3_BUCKET");
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error("缺少 S3_ACCESS_KEY_ID 或 S3_SECRET_ACCESS_KEY");
    }
  }

  getClient() {
    this.validateReady();
    if (!this.client) {
      this.client = new S3Client({
        endpoint: this.endpoint,
        region: this.region || "us-east-1",
        forcePathStyle: this.forcePathStyle,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey
        }
      });
    }
    return this.client;
  }

  getEndpointUrl() {
    this.validateReady();
    if (!this.endpointUrl) {
      const normalized = this.endpoint.replace(/\/+$/, "");
      this.endpoint = normalized;
      this.endpointUrl = new URL(normalized);
    }
    return this.endpointUrl;
  }

  getSigner() {
    this.validateReady();
    if (!this.signer) {
      this.signer = new SignatureV4({
        service: "s3",
        region: this.region || "us-east-1",
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey
        },
        sha256: Hash.bind(null, "sha256"),
        // cstcloud 对 UTF-8 key 的兼容实现要求按已编码 path 进行签名
        uriEscapePath: false
      });
    }
    return this.signer;
  }

  buildObjectPath(fileId) {
    const key = String(fileId || "").trim();
    if (!key) throw new Error("缺少 fileId");
    return `/${this.bucket}/${encodeObjectKey(key)}`;
  }

  buildObjectUrl(fileId) {
    const endpoint = this.getEndpointUrl();
    return `${endpoint.origin}${this.buildObjectPath(fileId)}`;
  }

  buildLocalPlayUrl(fileId) {
    return `/s3-direct/${encodeURIComponent(String(fileId || "").trim())}`;
  }

  async signObjectRequest(fileId, options = {}) {
    const key = String(fileId || "").trim();
    if (!key) {
      throw new Error("缺少 fileId");
    }
    const method = sanitizeMethod(options.method);
    const range = sanitizeRange(options.range);
    const endpoint = this.getEndpointUrl();

    const requestHeaders = {
      host: endpoint.host,
      "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256
    };
    if (method === "GET" && range) {
      requestHeaders.range = range;
    }

    const signedRequest = await this.getSigner().sign(
      new HttpRequest({
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port ? Number(endpoint.port) : undefined,
        method,
        path: this.buildObjectPath(key),
        headers: requestHeaders
      })
    );

    const signedHeaders = {};
    for (const [headerName, headerValue] of Object.entries(signedRequest.headers || {})) {
      if (headerValue == null) continue;
      const lowerName = String(headerName).toLowerCase();
      if (!SIGNED_HEADER_ALLOW_LIST.has(lowerName)) continue;
      signedHeaders[lowerName] = String(headerValue);
    }
    if (method === "GET" && range && !signedHeaders.range) {
      signedHeaders.range = range;
    }

    return {
      method,
      url: `${endpoint.origin}${signedRequest.path}`,
      headers: signedHeaders
    };
  }

  async listFolder(folderId) {
    const prefix = normalizeFolderPrefix(folderId);
    const client = this.getClient();
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      Delimiter: "/",
      MaxKeys: this.maxKeys
    });
    const result = await client.send(command);

    const folders = (result.CommonPrefixes || [])
      .map((entry) => {
        const folderPrefix = String(entry.Prefix || "");
        const clean = folderPrefix.replace(/\/+$/, "");
        if (!clean || clean === prefix.replace(/\/+$/, "")) return null;
        const name = clean.split("/").pop() || clean;
        return {
          itemType: "folder",
          id: clean,
          parentId: folderIdFromPrefix(prefix),
          name,
          size: 0,
          fileId: "",
          objectId: "",
          duration: 0,
          modified: 0,
          isVideo: false
        };
      })
      .filter(Boolean);

    const files = (result.Contents || [])
      .map((obj) => {
        const key = String(obj.Key || "");
        if (!key || key.endsWith("/")) return null;
        if (prefix && !key.startsWith(prefix)) return null;
        const relative = prefix ? key.slice(prefix.length) : key;
        if (!relative || relative.includes("/")) return null;
        const size = Number(obj.Size || 0);
        const modified = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
        return {
          itemType: "file",
          id: key,
          parentId: folderIdFromPrefix(prefix),
          name: relative,
          size: Number.isFinite(size) ? size : 0,
          fileId: key,
          objectId: key,
          duration: 0,
          modified: Number.isFinite(modified) ? modified : 0,
          isVideo: VIDEO_EXTENSIONS.has(extname(relative))
        };
      })
      .filter(Boolean);

    const items = [...folders, ...files].sort((a, b) => {
      if (a.itemType !== b.itemType) {
        return a.itemType === "folder" ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });

    return {
      folderId: folderIdFromPrefix(prefix),
      items
    };
  }

  async getPlayableLink(fileId) {
    const key = String(fileId || "").trim();
    if (!key) {
      throw new Error("缺少 fileId");
    }

    const client = this.getClient();
    let contentLength = 0;
    try {
      const meta = await client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key
        })
      );
      contentLength = Number(meta.ContentLength || 0);
    } catch {
      // ignore head error, keep link generation
    }
    const playUrl = this.buildLocalPlayUrl(key);
    const directUrl = this.buildObjectUrl(key);

    return {
      url: playUrl,
      playUrl,
      directUrl,
      previewUrl: playUrl,
      downloadUrl: "",
      candidateUrls: [playUrl],
      duration: 0,
      fileStatus: "success",
      contentLength
    };
  }

  async getFirstVideo() {
    const client = this.getClient();
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      MaxKeys: this.maxKeys
    });
    const result = await client.send(command);
    const video = (result.Contents || []).find((obj) => {
      const key = String(obj.Key || "");
      return key && !key.endsWith("/") && VIDEO_EXTENSIONS.has(extname(key));
    });
    if (!video) return null;
    return {
      key: String(video.Key || ""),
      size: Number(video.Size || 0)
    };
  }

  getSafeConfig() {
    return {
      provider: "s3",
      endpoint: this.endpoint,
      bucket: this.bucket,
      region: this.region,
      forcePathStyle: this.forcePathStyle,
      rootFolderId: "-1",
      urlExpireSeconds: this.urlExpireSeconds,
      playMode: "signed-header",
      hasCredentials: Boolean(this.accessKeyId && this.secretAccessKey)
    };
  }
}

module.exports = {
  S3MediaService
};
