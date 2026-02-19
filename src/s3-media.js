const path = require("node:path");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const { S3Client, HeadObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { SignatureV4 } = require("@smithy/signature-v4");
const { HttpRequest } = require("@smithy/protocol-http");
const { Hash } = require("@smithy/hash-node");
const { NodeHttpHandler } = require("@smithy/node-http-handler");

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

function normalizePlayMode(rawMode) {
  const mode = String(rawMode || "").trim().toLowerCase();
  if (mode === "signed-header") return "signed-header";
  return "presigned-url";
}

function buildRegionCandidates(primaryRegion) {
  const fallback = ["us-east-1", "cn-north-1", "cn-east-1", "ap-southeast-1"];
  const primary = String(primaryRegion || "").trim() || "us-east-1";
  return [primary, ...fallback].filter((region, index, list) => region && list.indexOf(region) === index);
}

function buildQueryString(query = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    const encodedKey = encodeURIComponent(String(key));
    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${encodedKey}=${encodeURIComponent(String(item))}`);
      }
      continue;
    }
    parts.push(`${encodedKey}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

function createDnsLookupFallback() {
  const toLookupOptions = (rawOptions) => {
    if (typeof rawOptions === "number") {
      return { family: rawOptions };
    }
    if (!rawOptions || typeof rawOptions !== "object") {
      return {};
    }
    return { ...rawOptions };
  };

  const finishWithSingle = (done, lookupOptions, address, family) => {
    if (lookupOptions.all) {
      done(null, [{ address, family }]);
      return;
    }
    done(null, address, family);
  };

  const finishWithList = (done, lookupOptions, addresses, family) => {
    if (!Array.isArray(addresses) || addresses.length === 0) {
      done(new Error("DNS fallback returned empty address list"));
      return;
    }
    if (lookupOptions.all) {
      done(
        null,
        addresses.map((address) => ({ address, family }))
      );
      return;
    }
    done(null, addresses[0], family);
  };

  return (hostname, options, callback) => {
    let lookupOptions = options;
    let done = callback;
    if (typeof lookupOptions === "function") {
      done = lookupOptions;
      lookupOptions = {};
    }
    lookupOptions = toLookupOptions(lookupOptions);

    dns.lookup(hostname, lookupOptions, (lookupError, address, family) => {
      if (!lookupError) {
        if (lookupOptions.all) {
          done(null, address);
          return;
        }
        finishWithSingle(done, lookupOptions, address, family);
        return;
      }

      const resolve4 = (next) => {
        dns.resolve4(hostname, (resolve4Error, addresses4) => {
          if (!resolve4Error && Array.isArray(addresses4) && addresses4.length > 0) {
            finishWithList(done, lookupOptions, addresses4, 4);
            return;
          }
          next();
        });
      };

      const resolve6 = (next) => {
        dns.resolve6(hostname, (resolve6Error, addresses6) => {
          if (!resolve6Error && Array.isArray(addresses6) && addresses6.length > 0) {
            finishWithList(done, lookupOptions, addresses6, 6);
            return;
          }
          next();
        });
      };

      if (lookupOptions.family === 4) {
        resolve4(() => done(lookupError));
        return;
      }
      if (lookupOptions.family === 6) {
        resolve6(() => done(lookupError));
        return;
      }
      resolve4(() => {
        resolve6(() => {
          done(lookupError);
        });
      });
    });
  };
}

class S3MediaService {
  constructor(options = {}) {
    this.endpoint = ensureEndpoint(options.endpoint || "");
    this.bucket = String(options.bucket || "").trim();
    this.region = String(options.region || "us-east-1").trim();
    this.accessKeyId = String(options.accessKeyId || "").trim();
    this.secretAccessKey = String(options.secretAccessKey || "").trim();
    this.forcePathStyle = options.forcePathStyle !== false;
    this.playMode = normalizePlayMode(options.playMode);
    this.urlExpireSeconds = Number(options.urlExpireSeconds || 1800);
    this.maxKeys = Number(options.maxKeys || 1000);
    this.client = null;
    this.signers = new Map();
    this.endpointUrl = null;
    this.lookup = createDnsLookupFallback();
    this.httpAgent = new http.Agent({
      keepAlive: true,
      lookup: this.lookup
    });
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      lookup: this.lookup
    });
  }

  setRuntimeConfig(next = {}) {
    if (typeof next.endpoint === "string") this.endpoint = ensureEndpoint(next.endpoint);
    if (typeof next.bucket === "string") this.bucket = next.bucket.trim();
    if (typeof next.region === "string") this.region = next.region.trim() || "us-east-1";
    if (typeof next.accessKeyId === "string") this.accessKeyId = next.accessKeyId.trim();
    if (typeof next.secretAccessKey === "string") this.secretAccessKey = next.secretAccessKey.trim();
    if (typeof next.forcePathStyle === "boolean") this.forcePathStyle = next.forcePathStyle;
    if (typeof next.playMode === "string") this.playMode = normalizePlayMode(next.playMode);
    if (typeof next.urlExpireSeconds === "number" && Number.isFinite(next.urlExpireSeconds)) {
      this.urlExpireSeconds = Math.min(86400, Math.max(60, Math.floor(next.urlExpireSeconds)));
    }
    if (typeof next.maxKeys === "number" && Number.isFinite(next.maxKeys)) {
      this.maxKeys = Math.min(5000, Math.max(50, Math.floor(next.maxKeys)));
    }
    this.client = null;
    this.signers = new Map();
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
        requestHandler: new NodeHttpHandler({
          httpAgent: this.httpAgent,
          httpsAgent: this.httpsAgent,
          connectionTimeout: 10_000,
          socketTimeout: 120_000
        }),
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

  getSigner(regionOverride) {
    this.validateReady();
    const region = String(regionOverride || this.region || "us-east-1").trim() || "us-east-1";
    if (!this.signers.has(region)) {
      this.signers.set(
        region,
        new SignatureV4({
        service: "s3",
        region,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey
        },
        sha256: Hash.bind(null, "sha256"),
        // cstcloud 对 UTF-8 key 的兼容实现要求按已编码 path 进行签名
        uriEscapePath: false
        })
      );
    }
    return this.signers.get(region);
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

  buildProxyPlayUrl(fileId) {
    return `/api/cx/proxy/${encodeURIComponent(String(fileId || "").trim())}`;
  }

  async createPresignedObjectUrl(fileId, options = {}) {
    const key = String(fileId || "").trim();
    if (!key) {
      throw new Error("缺少 fileId");
    }
    const method = sanitizeMethod(options.method);
    if (method !== "GET") {
      throw new Error("预签名直连仅支持 GET 方法");
    }
    const region = String(options.region || this.region || "us-east-1").trim() || "us-east-1";
    const endpoint = this.getEndpointUrl();
    const expiresIn = Math.min(86400, Math.max(60, Math.floor(Number(options.expiresIn || this.urlExpireSeconds))));
    const request = new HttpRequest({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : undefined,
      method,
      path: this.buildObjectPath(key),
      query: {
        "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD"
      },
      headers: {
        host: endpoint.host
      }
    });
    const presigned = await this.getSigner(region).presign(request, { expiresIn });
    const queryString = buildQueryString(presigned.query || {});
    return queryString ? `${endpoint.origin}${presigned.path}?${queryString}` : `${endpoint.origin}${presigned.path}`;
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

  async buildPresignedCandidates(fileId) {
    const key = String(fileId || "").trim();
    if (!key) return [];
    const regionCandidates = buildRegionCandidates(this.region);
    const presignedUrls = [];
    for (const region of regionCandidates) {
      try {
        const url = await this.createPresignedObjectUrl(key, { method: "GET", region });
        if (url && !presignedUrls.includes(url)) {
          presignedUrls.push(url);
        }
      } catch {
        // ignore single-region sign failure and continue fallback
      }
    }
    return presignedUrls;
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
    const localBridgeUrl = this.buildLocalPlayUrl(key);
    const proxyUrl = this.buildProxyPlayUrl(key);
    let playUrl = localBridgeUrl;
    let candidateUrls = [localBridgeUrl, proxyUrl].filter(Boolean);
    if (this.playMode === "presigned-url") {
      const presignedUrls = await this.buildPresignedCandidates(key);
      if (!presignedUrls.length) {
        throw new Error("生成预签名播放地址失败");
      }
      if (proxyUrl && !presignedUrls.includes(proxyUrl)) {
        presignedUrls.push(proxyUrl);
      }
      if (localBridgeUrl && !presignedUrls.includes(localBridgeUrl)) {
        presignedUrls.push(localBridgeUrl);
      }
      playUrl = presignedUrls[0];
      candidateUrls = presignedUrls;
    } else {
      const presignedUrls = await this.buildPresignedCandidates(key);
      if (presignedUrls.length) {
        candidateUrls = [localBridgeUrl, proxyUrl, ...presignedUrls].filter(
          (url, index, list) => url && list.indexOf(url) === index
        );
      }
    }
    const directUrl = this.buildObjectUrl(key);

    return {
      url: playUrl,
      playUrl,
      directUrl,
      previewUrl: playUrl,
      downloadUrl: "",
      candidateUrls,
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
      playMode: this.playMode,
      hasCredentials: Boolean(this.accessKeyId && this.secretAccessKey)
    };
  }
}

module.exports = {
  S3MediaService
};
