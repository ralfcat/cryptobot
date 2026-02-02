import fetch from "node-fetch";
import config from "./config.js";

function headers() {
  const h = { "Content-Type": "application/json" };
  if (config.jupApiKey) h["x-api-key"] = config.jupApiKey;
  return h;
}

function asPercent(pct) {
  if (pct === null || pct === undefined) return null;
  const n = Number(pct);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n;
}

export async function getQuote(params) {
  const url = new URL(`${config.jupBaseUrl}/quote`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jupiter quote failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  return json;
}

export async function getSwapTx(quoteResponse, userPublicKey) {
  const body = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: "auto",
  };
  const res = await fetch(`${config.jupBaseUrl}/swap`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jupiter swap failed: ${res.status} ${text}`);
  }
  return res.json();
}

export function getPriceImpactPct(quote) {
  return asPercent(quote?.priceImpactPct ?? quote?.priceImpactPct);
}
