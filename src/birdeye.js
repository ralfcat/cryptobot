import fetch from "node-fetch";
import config from "./config.js";
import { nowSec, nowMs, sleep } from "./utils.js";

const BASE = "https://public-api.birdeye.so";
let lastRequestMs = 0;
const cache = new Map();
const inflight = new Map();

function buildUrl(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of entries) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function headers() {
  return {
    "x-chain": "solana",
    "X-API-KEY": config.birdeyeApiKey,
  };
}

async function birdeyeGet(path, params = {}) {
  const url = buildUrl(path, params);
  const now = nowMs();
  const cacheTtlMs = Math.max(0, config.birdeyeCacheTtlMs || 0);
  if (cacheTtlMs > 0) {
    const cached = cache.get(url);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
    if (inflight.has(url)) {
      return inflight.get(url);
    }
  }

  const request = (async () => {
    const maxRetries = Math.max(0, Math.floor(config.birdeyeMaxRetries || 0));
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const minInterval = config.birdeyeMinIntervalMs || 0;
      if (minInterval > 0) {
        const wait = Math.max(0, lastRequestMs + minInterval - nowMs());
        if (wait > 0) await sleep(wait);
        lastRequestMs = nowMs();
      }

      const res = await fetch(url, { headers: headers() });
      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after") || 0);
        const backoff =
          retryAfter > 0
            ? retryAfter * 1000
            : Math.min((config.birdeyeRetryBaseMs || 500) * 2 ** attempt, config.birdeyeRetryMaxMs || 5000);
        await sleep(backoff);
        continue;
      }

    if (!res.ok) {
      const text = await res.text();
      if (cacheTtlMs > 0) {
        const cached = cache.get(url);
        if (cached?.data && text.includes("Compute units usage limit exceeded")) {
          return cached.data;
        }
      }
      throw new Error(`Birdeye error ${res.status}: ${text}`);
    }
      const json = await res.json();
      if (json?.success === false) {
        throw new Error(`Birdeye error: ${JSON.stringify(json)}`);
      }
      const data = json?.data ?? json;
      if (cacheTtlMs > 0) {
        cache.set(url, { data, expiresAt: nowMs() + cacheTtlMs });
      }
      return data;
    }
    throw new Error("Birdeye error: retries exhausted.");
  })();

  if (cacheTtlMs > 0) {
    inflight.set(url, request);
    try {
      return await request;
    } finally {
      inflight.delete(url);
    }
  }
  return request;
}

export async function getTrendingTokens(limit = 20) {
  const safeLimit = Math.min(20, Math.max(1, Math.floor(Number(limit) || 20)));
  return birdeyeGet("/defi/token_trending", {
    sort_by: "volume24hUSD",
    sort_type: "desc",
    offset: 0,
    limit: safeLimit,
  });
}

export async function getOHLCV(address, type = "1m", minutes = 60) {
  const now = nowSec();
  const from = now - minutes * 60;
  return birdeyeGet("/defi/ohlcv", {
    address,
    type,
    type_in_time: type,
    time_from: from,
    time_to: now,
  });
}

export async function getTokenOverview(address) {
  return birdeyeGet("/defi/token_overview", { address });
}

export async function getTokenSecurity(address) {
  return birdeyeGet("/defi/token_security", { address });
}
