const DIRECT_PREFIX = "/s3-direct/";
const SIGN_ENDPOINT = "/api/cx/sign";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

function parseFileId(pathname) {
  if (!pathname.startsWith(DIRECT_PREFIX)) return "";
  const encoded = pathname.slice(DIRECT_PREFIX.length);
  if (!encoded) return "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

async function requestSignedHeaders(fileId, method, range) {
  const response = await fetch(SIGN_ENDPOINT, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      fileId,
      method,
      range
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || `sign failed: ${response.status}`);
  }
  return payload;
}

async function handleDirectRequest(request) {
  const requestUrl = new URL(request.url);
  const fileId = parseFileId(requestUrl.pathname);
  if (!fileId) {
    return new Response("invalid fileId", { status: 400 });
  }

  const method = String(request.method || "GET").toUpperCase() === "HEAD" ? "HEAD" : "GET";
  const range = method === "GET" ? String(request.headers.get("range") || "").trim() : "";

  try {
    const signed = await requestSignedHeaders(fileId, method, range);
    const upstreamHeaders = new Headers();
    for (const [headerName, headerValue] of Object.entries(signed.headers || {})) {
      if (headerValue == null || headerValue === "") continue;
      upstreamHeaders.set(headerName, String(headerValue));
    }
    if (method === "GET" && range && !upstreamHeaders.has("range")) {
      upstreamHeaders.set("range", range);
    }

    const upstream = await fetch(String(signed.url || ""), {
      method,
      mode: "cors",
      redirect: "follow",
      cache: "no-store",
      credentials: "omit",
      headers: upstreamHeaders
    });
    return upstream;
  } catch (error) {
    return new Response(String(error?.message || "s3 direct request failed"), {
      status: 502,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
}

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (!requestUrl.pathname.startsWith(DIRECT_PREFIX)) return;
  event.respondWith(handleDirectRequest(event.request));
});
