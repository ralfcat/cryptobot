import fetch from "node-fetch";
import config from "./config.js";
import { nowMs, sleep } from "./utils.js";

const BASE = "https://api.dexscreener.com";
let lastRequestMs = 0;
const cache = new Map();
const inflight = new Map();

async function dexGet(path) {
  const url = `${BASE}${path}`;
  const cacheTtlMs = Math.max(0, config.dexCacheTtlMs || 0);
  const now = nowMs();

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
    const minInterval = Math.max(0, config.dexMinIntervalMs || 0);
    if (minInterval > 0) {
      const wait = Math.max(0, lastRequestMs + minInterval - nowMs());
      if (wait > 0) await sleep(wait);
      lastRequestMs = nowMs();
    }

    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DexScreener error ${res.status}: ${text}`);
    }
    const json = await res.json();
    if (cacheTtlMs > 0) {
      cache.set(url, { data: json, expiresAt: nowMs() + cacheTtlMs });
    }
    return json;
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

export async function getLatestBoosts() {
  return dexGet("/token-boosts/latest/v1");
}

export async function getLatestProfiles() {
  return dexGet("/token-profiles/latest/v1");
}

export async function getTokenPairs(chainId, addresses = []) {
  if (!addresses.length) return [];
  const chunkSize = 30;
  const pairs = [];
  for (let i = 0; i < addresses.length; i += chunkSize) {
    const chunk = addresses.slice(i, i + chunkSize);
    const path = `/tokens/v1/${chainId}/${chunk.join(",")}`;
    const data = await dexGet(path);
    if (Array.isArray(data)) {
      pairs.push(...data);
    } else if (data) {
      pairs.push(data);
    }
  }
  return pairs;
}
