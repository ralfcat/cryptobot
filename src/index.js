import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { VersionedTransaction, LAMPORTS_PER_SOL, PublicKey, SendTransactionError } from "@solana/web3.js";
import config from "./config.js";
import {
  createConnection,
  getSolBalance,
  getMintInfo,
  getTopHoldersPct,
  getAtaRentLamports,
  getTokenBalanceRaw,
} from "./solana.js";
import { loadKeypair } from "./wallet.js";
import { getTrendingTokens, getOHLCV, getTokenOverview, getTokenSecurity } from "./birdeye.js";
import { getLatestBoosts, getLatestProfiles, getTokenPairs } from "./dexscreener.js";
import { computeMomentum, computeSignal, computeVolatility, normalizeCandles, volumeLastMinutes } from "./strategy.js";
import { getQuote, getSwapTx, getPriceImpactPct } from "./jupiter.js";
import { loadState, saveState } from "./state.js";
import { sleep, nowMs, pctChange } from "./utils.js";
import { startServer } from "./server.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const LOOP_MS = 5000;
const SOL_PRICE_TTL_MS = 15000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tradesPath = path.join(__dirname, "..", "trades.jsonl");
const tradesCsvPath = path.join(__dirname, "..", "trades.csv");

const VALID_MODES = new Set(["sharp", "simulator"]);

function normalizeMode(value) {
  const mode = String(value || "").toLowerCase();
  return VALID_MODES.has(mode) ? mode : "sharp";
}

function parseMode(value) {
  const mode = String(value || "").toLowerCase();
  return VALID_MODES.has(mode) ? mode : null;
}

let currentMode = normalizeMode(config.mode);

const ui = {
  status: "starting",
  lastAction: "Starting bot",
  mode: currentMode,
  balances: { sol: 0, solUsd: 0, totalUsd: 0 },
  position: null,
  rules: {
    stopLossPct: config.stopLossPct,
    takeProfitPct: config.takeProfitPct,
    exitSoftMinutes: config.exitSoftMinutes,
    exitHardMinutes: config.exitHardMinutes,
  },
  cooldown: { minutes: config.tradeCooldownMinutes, nextEntryMs: 0, remainingSec: 0 },
  logs: [],
  trades: [],
  updatedAt: nowMs(),
};

let uiServer = null;
let lastUiUpdateMs = 0;
let lastScanMs = 0;
let cachedSolUsd = 0;
let cachedSolUsdAt = 0;
let holdersCheckUnavailable = false;
let manualExitRequested = false;
let manualExitRequestedAt = 0;
let birdeyeBlockedUntilMs = 0;

function isSimulatorMode() {
  return currentMode === "simulator";
}

function broadcastUi(patch = {}) {
  Object.assign(ui, patch);
  ui.updatedAt = nowMs();
  if (uiServer) uiServer.broadcast(ui);
}

function pushLog(level, msg) {
  const entry = { t: nowMs(), level, msg };
  ui.logs.push(entry);
  if (ui.logs.length > 200) ui.logs.shift();
  ui.lastAction = msg;
  if (level === "error") console.error(msg);
  else console.log(msg);
  broadcastUi();
}

function pushTrade(entry) {
  const record = { t: nowMs(), ...entry };
  ui.trades.push(record);
  if (ui.trades.length > 200) ui.trades.shift();
  fs.appendFileSync(tradesPath, `${JSON.stringify(record)}\n`);
  appendTradeCsv(record);
  broadcastUi();
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function appendTradeCsv(record) {
  const headers = ["timestamp", "side", "mint", "pnlPct", "profitUsd", "sig", "reason"];
  const exists = fs.existsSync(tradesCsvPath);
  if (!exists || fs.statSync(tradesCsvPath).size === 0) {
    fs.appendFileSync(tradesCsvPath, `${headers.join(",")}\n`);
  }
  const row = [
    new Date(record.t).toISOString(),
    record.side ?? "",
    record.mint ?? "",
    record.pnlPct ?? "",
    record.profitUsd ?? "",
    record.sig ?? "",
    record.reason ?? "",
  ].map(csvEscape);
  fs.appendFileSync(tradesCsvPath, `${row.join(",")}\n`);
}

async function logSendTransactionError(err, connection) {
  const isSendTxError = err instanceof SendTransactionError || typeof err?.getLogs === "function";
  if (!isSendTxError) return;
  try {
    const logs = await err.getLogs(connection);
    if (Array.isArray(logs) && logs.length) {
      pushLog("error", `Transaction logs:\n${logs.join("\n")}`);
    }
  } catch (logErr) {
    pushLog("error", `Failed to fetch transaction logs: ${logErr?.message || String(logErr)}`);
  }
}

function requireConfig() {
  if (!config.rpcUrl) throw new Error("RPC_URL is required.");
  if (!config.birdeyeApiKey && config.dataProvider === "birdeye") {
    throw new Error("BIRDEYE_API_KEY is required for Birdeye mode.");
  }
  if (!config.jupApiKey) throw new Error("JUP_API_KEY is required.");
}

function getCooldown(state) {
  const nextEntryMs = state.lastTradeTimeMs
    ? state.lastTradeTimeMs + config.tradeCooldownMinutes * 60 * 1000
    : 0;
  const remainingMs = nextEntryMs ? Math.max(0, nextEntryMs - nowMs()) : 0;
  return {
    minutes: config.tradeCooldownMinutes,
    nextEntryMs,
    remainingSec: Math.ceil(remainingMs / 1000),
  };
}

async function getSolUsdPrice() {
  const quote = await getQuote({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amount: LAMPORTS_PER_SOL,
    swapMode: "ExactIn",
    slippageBps: 50,
  });
  const out = Number(quote?.outAmount || 0);
  return out / 1_000_000;
}

async function getSolUsdPriceCached() {
  const now = nowMs();
  if (!cachedSolUsd || now - cachedSolUsdAt > SOL_PRICE_TTL_MS) {
    cachedSolUsd = await getSolUsdPrice();
    cachedSolUsdAt = now;
  }
  return cachedSolUsd;
}

function parseTrendingList(data) {
  const list = data?.items || data?.tokens || data?.data?.items || data?.data?.tokens || [];
  return list;
}

function tokenAddress(item) {
  return item?.address || item?.tokenAddress || item?.token_address || item?.mint || item?.tokenMint;
}

function tokenName(item) {
  return item?.symbol || item?.name || item?.tokenName || "";
}

function metric(item, keys, fallback = null) {
  for (const key of keys) {
    const v = item?.[key];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return fallback;
}

function shouldTakeProfit(pnlPct, profitUsd) {
  if (config.takeProfitPct > 0 && pnlPct >= config.takeProfitPct) return true;
  if (config.takeProfitUsd > 0 && profitUsd >= config.takeProfitUsd) return true;
  return false;
}

function isHoldersUnavailableError(err) {
  const msg = err?.message || String(err || "");
  return msg.includes("Too many accounts requested");
}

function isInvalidMintError(err) {
  const msg = err?.message || String(err || "");
  const name = err?.name || "";
  return msg.includes("TokenInvalidAccountOwnerError") || name.includes("TokenInvalidAccountOwnerError");
}

function isBirdeyeQuotaError(err) {
  const msg = err?.message || String(err || "");
  return msg.includes("Compute units usage limit exceeded");
}

async function adjustTradeLamportsForAtaRent(connection, owner, mint, tradeLamports) {
  const rentLamports = await getAtaRentLamports(connection, owner, new PublicKey(mint));
  if (!rentLamports) return tradeLamports;
  const adjusted = tradeLamports - rentLamports;
  const rentSol = rentLamports / LAMPORTS_PER_SOL;
  if (adjusted <= 0) {
    throw new Error(`Not enough SOL after reserving ${rentSol.toFixed(4)} for ATA rent.`);
  }
  pushLog("info", `Reserving ${rentSol.toFixed(4)} SOL for ATA rent.`);
  return adjusted;
}

async function pickCandidateBirdeye(connection, tradeLamports) {
  const data = await getTrendingTokens(config.trendingLimit);
  const list = parseTrendingList(data);
  const scanList =
    config.candidateLimit && config.candidateLimit > 0 ? list.slice(0, config.candidateLimit) : list;
  const candidates = [];
  const volatilityOnlyCandidates = [];
  const relaxedMomentumMinPctShort = 0;
  const relaxedMomentumMinPctLong = 0;
  const stats = {
    total: scanList.length,
    noMint: 0,
    solMint: 0,
    liquidityLow: 0,
    vol24hLow: 0,
    scam: 0,
    invalidMint: 0,
    authority: 0,
    holdersTooHigh: 0,
    holdersError: 0,
    ohlcvShort: 0,
    vol15mLow: 0,
    volatilityBad: 0,
    volatilityLow: 0,
    signalFail: 0,
    momentumFail: 0,
    priceImpactHigh: 0,
  };

  for (const item of scanList) {
    const mintAddr = tokenAddress(item);
    if (!mintAddr) {
      stats.noMint += 1;
      continue;
    }

    const address = mintAddr;
    const name = tokenName(item);
    if (address === SOL_MINT) {
      stats.solMint += 1;
      continue;
    }

    let overview = null;
    let security = null;

    try {
      overview = await getTokenOverview(address);
    } catch {
      overview = null;
    }

    try {
      security = await getTokenSecurity(address);
    } catch {
      security = null;
    }

    const liquidityUsd = Number(metric(overview, ["liquidity", "liquidityUSD", "liquidityUsd"], 0));
    const vol24hUsd = Number(metric(overview, ["volume24hUSD", "volume24hUsd", "v24hUSD"], 0));

    if (liquidityUsd && liquidityUsd < config.minLiquidityUsd) {
      stats.liquidityLow += 1;
      continue;
    }
    if (vol24hUsd && vol24hUsd < config.minVol24hUsd) {
      stats.vol24hLow += 1;
      continue;
    }

    if (security?.isScam === true || security?.is_honeypot === true) {
      stats.scam += 1;
      continue;
    }

    const mintPub = new PublicKey(address);
    let mintInfo = null;
    try {
      mintInfo = await getMintInfo(connection, mintPub);
    } catch (err) {
      if (isInvalidMintError(err)) {
        stats.invalidMint += 1;
        continue;
      }
      throw err;
    }
    if (mintInfo.mintAuthority || mintInfo.freezeAuthority) {
      stats.authority += 1;
      continue;
    }

    if (config.maxTop10Pct > 0 && config.maxTop10Pct < 100 && !holdersCheckUnavailable) {
      const holders = await getTopHoldersPct(connection, mintPub, 10);
      if (holders.error) {
        if (isHoldersUnavailableError(holders.error)) {
          if (!holdersCheckUnavailable) {
            holdersCheckUnavailable = true;
            pushLog(
              "warn",
              "RPC cannot return token largest accounts; skipping holder concentration filter."
            );
          }
        } else {
          // Unknown holders error; skip this token quietly.
          stats.holdersError += 1;
          continue;
        }
      } else if (holders.pct !== null && holders.pct > config.maxTop10Pct) {
        stats.holdersTooHigh += 1;
        continue;
      }
    }

    const ohlcvRaw = await getOHLCV(address, "1m", 60);
    const candles = normalizeCandles(ohlcvRaw);
    if (candles.length < 25) {
      stats.ohlcvShort += 1;
      continue;
    }

    const vol15m = volumeLastMinutes(candles, 15);
    if (config.minVol15mUsd && vol15m < config.minVol15mUsd) {
      stats.vol15mLow += 1;
      continue;
    }

    const volatility = computeVolatility(candles, config.flashWindowMinutes);
    if (!volatility.ok) {
      stats.volatilityBad += 1;
      continue;
    }
    if (config.minVolatilityPct && volatility.rangePct < config.minVolatilityPct) {
      stats.volatilityLow += 1;
      continue;
    }

    let signal = null;
    let momentum = null;
    let momentumRelaxedOk = false;
    let entryOk = false;
    if (config.momentumMode) {
      momentum = computeMomentum(candles);
      if (!momentum.ok && momentum.reason === "not_enough_candles") continue;
      if (Number.isFinite(momentum.pctShort) && Number.isFinite(momentum.pctLong)) {
        momentumRelaxedOk =
          momentum.pctShort >= relaxedMomentumMinPctShort && momentum.pctLong >= relaxedMomentumMinPctLong;
      }
      entryOk = momentum.ok;
    } else {
      signal = computeSignal(candles);
      entryOk = signal.ok;
    }
    if (!entryOk) {
      if (config.momentumMode) stats.momentumFail += 1;
      else stats.signalFail += 1;
    }

    const quote = await getQuote({
      inputMint: SOL_MINT,
      outputMint: address,
      amount: tradeLamports,
      swapMode: "ExactIn",
      slippageBps: config.maxSlippageBps,
      restrictIntermediateTokens: true,
    });
    const priceImpactPct = getPriceImpactPct(quote);
    if (priceImpactPct !== null && priceImpactPct > config.maxPriceImpactPct) {
      stats.priceImpactHigh += 1;
      continue;
    }

    const baseScore = config.momentumMode ? momentum?.score ?? 0 : signal?.score ?? 0;
    const volatilityScore = config.volatilityWeight * volatility.rangePct + volatility.chopPct;
    const score =
      baseScore +
      volatilityScore +
      (priceImpactPct !== null ? (config.maxPriceImpactPct - priceImpactPct) / 2 : 0);

    const targetList = entryOk
      ? candidates
      : config.momentumMode && momentumRelaxedOk
        ? relaxedCandidates
        : volatilityOnlyCandidates;
    targetList.push({
      address,
      name,
      score,
      quote,
      signal,
      momentum,
      volatility,
      priceImpactPct,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) return candidates[0];
  relaxedCandidates.sort((a, b) => b.score - a.score);
  if (relaxedCandidates[0]) {
    pushLog(
      "warn",
      "No strict momentum candidates. Using relaxed momentum thresholds (>= 0%) for this scan."
    );
    return relaxedCandidates[0];
  }
  volatilityOnlyCandidates.sort((a, b) => b.score - a.score);
  if (volatilityOnlyCandidates[0]) {
    pushLog("warn", "No signal candidates. Using volatility-first selection for this scan.");
    return volatilityOnlyCandidates[0];
  }
  if (!list.length) {
    pushLog("warn", "Trending list is empty. Check Birdeye API key and rate limits.");
  } else {
    pushLog(
      "warn",
      `Filter stats: total ${stats.total} | lowLiq ${stats.liquidityLow} lowVol24 ${stats.vol24hLow} lowVol15 ${stats.vol15mLow} lowVol ${stats.volatilityLow} badVol ${stats.volatilityBad} sigFail ${stats.signalFail} momFail ${stats.momentumFail} impact ${stats.priceImpactHigh} auth ${stats.authority} holders ${stats.holdersTooHigh} ohlcv ${stats.ohlcvShort}`
    );
  }
  return null;
}

function normalizeDexList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function dexVolume15m(pair) {
  const m5 = Number(pair?.volume?.m5);
  if (Number.isFinite(m5)) return m5 * 3;
  const h1 = Number(pair?.volume?.h1);
  if (Number.isFinite(h1)) return h1 / 4;
  return 0;
}

function dexPriceChange(pair) {
  const window = config.dexPriceChangeWindow || "h1";
  const pct = Number(pair?.priceChange?.[window]);
  return Number.isFinite(pct) ? pct : null;
}

async function pickCandidateDex(connection, tradeLamports) {
  const seedLimit = Math.max(1, Math.floor(config.dexSeedLimit || config.trendingLimit || 20));
  const seen = new Set();
  const seeds = [];

  try {
    const boosts = normalizeDexList(await getLatestBoosts());
    for (const item of boosts) {
      if (item?.chainId !== config.dexChainId) continue;
      const addr = item?.tokenAddress;
      const key = addr?.toLowerCase();
      if (!addr || seen.has(key)) continue;
      seen.add(key);
      seeds.push({ address: addr, symbol: item?.symbol, name: item?.name });
      if (seeds.length >= seedLimit) break;
    }
  } catch (err) {
    pushLog("warn", `DexScreener boosts unavailable: ${err?.message || err}`);
  }

  if (seeds.length < seedLimit) {
    try {
      const profiles = normalizeDexList(await getLatestProfiles());
      for (const item of profiles) {
        if (item?.chainId !== config.dexChainId) continue;
        const addr = item?.tokenAddress;
        const key = addr?.toLowerCase();
        if (!addr || seen.has(key)) continue;
        seen.add(key);
        seeds.push({ address: addr, symbol: item?.symbol, name: item?.name });
        if (seeds.length >= seedLimit) break;
      }
    } catch (err) {
      pushLog("warn", `DexScreener profiles unavailable: ${err?.message || err}`);
    }
  }

  if (!seeds.length) {
    pushLog("warn", "DexScreener seed list is empty.");
    return null;
  }

  const limitedSeeds =
    config.candidateLimit && config.candidateLimit > 0 ? seeds.slice(0, config.candidateLimit) : seeds;
  const addresses = limitedSeeds.map((item) => item.address);
  const pairs = await getTokenPairs(config.dexChainId, addresses);

  const bestByToken = new Map();
  for (const pair of pairs) {
    const baseAddr = pair?.baseToken?.address;
    if (!baseAddr) continue;
    const liquidityUsd = Number(pair?.liquidity?.usd || 0);
    const prev = bestByToken.get(baseAddr);
    if (!prev || liquidityUsd > (prev?.liquidity?.usd || 0)) {
      bestByToken.set(baseAddr, pair);
    }
  }

  const candidates = [];
  const relaxedCandidates = [];
  const stats = {
    total: bestByToken.size,
    noPair: 0,
    liquidityLow: 0,
    vol24hLow: 0,
    vol15mLow: 0,
    priceChangeLow: 0,
    authority: 0,
    holdersTooHigh: 0,
    holdersError: 0,
    invalidMint: 0,
    priceImpactHigh: 0,
  };

  for (const [address, pair] of bestByToken.entries()) {
    if (!pair) {
      stats.noPair += 1;
      continue;
    }

    const name = pair?.baseToken?.symbol || pair?.baseToken?.name || "";
    const liquidityUsd = Number(pair?.liquidity?.usd || 0);
    const vol24hUsd = Number(pair?.volume?.h24 || 0);
    const vol15mUsd = dexVolume15m(pair);

    if (liquidityUsd && liquidityUsd < config.minLiquidityUsd) {
      stats.liquidityLow += 1;
      continue;
    }
    if (vol24hUsd && vol24hUsd < config.minVol24hUsd) {
      stats.vol24hLow += 1;
      continue;
    }
    if (config.minVol15mUsd && vol15mUsd < config.minVol15mUsd) {
      stats.vol15mLow += 1;
      continue;
    }

    const priceChangePct = dexPriceChange(pair);
    if (config.dexMinPriceChangePct && (priceChangePct === null || priceChangePct < config.dexMinPriceChangePct)) {
      stats.priceChangeLow += 1;
      continue;
    }

    const mintPub = new PublicKey(address);
    let mintInfo = null;
    try {
      mintInfo = await getMintInfo(connection, mintPub);
    } catch (err) {
      if (isInvalidMintError(err)) {
        stats.invalidMint += 1;
        continue;
      }
      throw err;
    }
    if (mintInfo.mintAuthority || mintInfo.freezeAuthority) {
      stats.authority += 1;
      continue;
    }

    if (config.maxTop10Pct > 0 && config.maxTop10Pct < 100 && !holdersCheckUnavailable) {
      const holders = await getTopHoldersPct(connection, mintPub, 10);
      if (holders.error) {
        if (isHoldersUnavailableError(holders.error)) {
          if (!holdersCheckUnavailable) {
            holdersCheckUnavailable = true;
            pushLog("warn", "RPC cannot return token largest accounts; skipping holder concentration filter.");
          }
        } else {
          stats.holdersError += 1;
          continue;
        }
      } else if (holders.pct !== null && holders.pct > config.maxTop10Pct) {
        stats.holdersTooHigh += 1;
        continue;
      }
    }

    const quote = await getQuote({
      inputMint: SOL_MINT,
      outputMint: address,
      amount: tradeLamports,
      swapMode: "ExactIn",
      slippageBps: config.maxSlippageBps,
      restrictIntermediateTokens: true,
    });
    const priceImpactPct = getPriceImpactPct(quote);
    if (priceImpactPct !== null && priceImpactPct > config.maxPriceImpactPct) {
      stats.priceImpactHigh += 1;
      continue;
    }

    const baseScore = priceChangePct ?? 0;
    const volScore = Math.log10((vol24hUsd || 0) + 1) * 2;
    const liqScore = Math.log10((liquidityUsd || 0) + 1);
    const score =
      baseScore +
      volScore +
      liqScore +
      (priceImpactPct !== null ? (config.maxPriceImpactPct - priceImpactPct) / 2 : 0);

    const volatility = priceChangePct === null ? null : { ok: true, rangePct: Math.abs(priceChangePct), chopPct: 0 };
    const signal = config.momentumMode ? null : { ok: true, score: baseScore };
    const momentum = config.momentumMode
      ? { ok: true, score: baseScore, pctShort: priceChangePct ?? 0, pctLong: priceChangePct ?? 0 }
      : null;

    candidates.push({
      address,
      name,
      score,
      quote,
      signal,
      momentum,
      volatility,
      priceImpactPct,
      dexPair: pair,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) return candidates[0];

  pushLog(
    "warn",
    `DexScreener filter stats: total ${stats.total} | lowLiq ${stats.liquidityLow} lowVol24 ${stats.vol24hLow} lowVol15 ${stats.vol15mLow} lowChange ${stats.priceChangeLow} impact ${stats.priceImpactHigh} auth ${stats.authority} holders ${stats.holdersTooHigh}`
  );
  return null;
}

async function pickCandidate(connection, tradeLamports) {
  if (config.dataProvider === "dexscreener") {
    return pickCandidateDex(connection, tradeLamports);
  }

  if (config.dataProvider === "auto" && !config.birdeyeApiKey) {
    return pickCandidateDex(connection, tradeLamports);
  }

  if (config.dataProvider === "auto" && birdeyeBlockedUntilMs && nowMs() < birdeyeBlockedUntilMs) {
    return pickCandidateDex(connection, tradeLamports);
  }

  try {
    return await pickCandidateBirdeye(connection, tradeLamports);
  } catch (err) {
    if (config.dataProvider === "auto" && isBirdeyeQuotaError(err)) {
      const blockMinutes = Math.max(1, config.birdeyeBlockMinutes || 10);
      birdeyeBlockedUntilMs = nowMs() + blockMinutes * 60 * 1000;
      pushLog("warn", `Birdeye quota exceeded. Using DexScreener for ${blockMinutes} minutes.`);
      return pickCandidateDex(connection, tradeLamports);
    }
    throw err;
  }
}

async function sendSwap(connection, keypair, quoteResponse) {
  if (isSimulatorMode()) {
    const simulatedSig = `SIM-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    pushLog("info", `Simulated swap (no transaction sent): ${simulatedSig}`);
    return simulatedSig;
  }
  const swap = await getSwapTx(quoteResponse, keypair.publicKey.toBase58());
  const swapTxB64 = swap?.swapTransaction;
  if (!swapTxB64) throw new Error("Missing swapTransaction in response.");
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxB64, "base64"));
  tx.sign([keypair]);
  const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

async function enterPosition(connection, keypair, tradeLamports, candidate) {
  const adjustedLamports = await adjustTradeLamportsForAtaRent(
    connection,
    keypair.publicKey,
    candidate.address,
    tradeLamports
  );
  const freshQuote = await getQuote({
    inputMint: SOL_MINT,
    outputMint: candidate.address,
    amount: adjustedLamports,
    swapMode: "ExactIn",
    slippageBps: config.maxSlippageBps,
    restrictIntermediateTokens: true,
  });
  const priceImpactPct = getPriceImpactPct(freshQuote);
  if (priceImpactPct !== null && priceImpactPct > config.maxPriceImpactPct) {
    throw new Error(`Price impact too high: ${priceImpactPct.toFixed(2)}%`);
  }
  const sig = await sendSwap(connection, keypair, freshQuote);

  const outAmount = Number(freshQuote.outAmount || 0);
  const mintInfo = await getMintInfo(connection, new PublicKey(candidate.address));
  const tokenAmount = outAmount / 10 ** mintInfo.decimals;

  return {
    signature: sig,
    mint: candidate.address,
    tokenAmount,
    tokenDecimals: mintInfo.decimals,
    entryTimeMs: nowMs(),
    entrySol: adjustedLamports / LAMPORTS_PER_SOL,
  };
}

async function exitPosition(connection, keypair, position) {
  let amountRaw;
  if (isSimulatorMode()) {
    amountRaw = Math.floor(position.tokenAmount * 10 ** position.tokenDecimals);
  } else {
    amountRaw = await getTokenBalanceRaw(
      connection,
      keypair.publicKey,
      new PublicKey(position.mint)
    );
    if (amountRaw <= 0n) throw new Error("No token amount to sell.");
  }

  const quote = await getQuote({
    inputMint: position.mint,
    outputMint: SOL_MINT,
    amount: amountRaw.toString(),
    swapMode: "ExactIn",
    slippageBps: config.maxSlippageBps,
    restrictIntermediateTokens: true,
  });

  const sig = await sendSwap(connection, keypair, quote);
  return sig;
}

async function estimateTokenValueSol(position) {
  const amountRaw = Math.floor(position.tokenAmount * 10 ** position.tokenDecimals);
  const quote = await getQuote({
    inputMint: position.mint,
    outputMint: SOL_MINT,
    amount: amountRaw,
    swapMode: "ExactIn",
    slippageBps: config.maxSlippageBps,
  });
  const outSol = Number(quote.outAmount || 0) / LAMPORTS_PER_SOL;
  return { outSol, quote };
}

async function shouldExtendHold(position) {
  const ohlcvRaw = await getOHLCV(position.mint, "1m", 60);
  const candles = normalizeCandles(ohlcvRaw);
  if (candles.length < 25) return false;
  const signal = computeSignal(candles);
  return signal.trend;
}

async function run() {
  requireConfig();
  const connection = createConnection(config.rpcUrl);
  const keypair = loadKeypair();
  const state = loadState();

  const requestManualExit = () => {
    if (!state.position) return { ok: false, error: "no_position" };
    if (manualExitRequested) {
      return { ok: true, requested: true, mint: state.position.mint, alreadyQueued: true };
    }
    manualExitRequested = true;
    manualExitRequestedAt = nowMs();
    pushLog("warn", "Manual sell requested. Exiting on next loop.");
    return { ok: true, requested: true, mint: state.position.mint, queuedAt: manualExitRequestedAt };
  };

  const requestResetCooldown = () => {
    if (state.position) return { ok: false, error: "position_open" };
    const current = getCooldown(state);
    if (current.remainingSec <= 0) {
      return { ok: true, reset: false, remainingSec: 0 };
    }
    state.lastTradeTimeMs = 0;
    saveState(state);
    const updated = getCooldown(state);
    pushLog("warn", "Cooldown reset from UI.");
    broadcastUi({ cooldown: updated });
    return { ok: true, reset: true, remainingSec: updated.remainingSec };
  };

  const requestSetMode = (mode) => {
    const normalized = parseMode(mode);
    if (!normalized) return { ok: false, error: "invalid_mode" };
    if (currentMode === normalized) {
      return { ok: true, mode: currentMode, changed: false };
    }
    currentMode = normalized;
    broadcastUi({ mode: currentMode });
    pushLog("warn", `Mode switched to ${currentMode}.`);
    return { ok: true, mode: currentMode, changed: true };
  };

  uiServer = startServer({
    port: config.port,
    host: config.host,
    onSellNow: requestManualExit,
    onResetCooldown: requestResetCooldown,
    onSetMode: requestSetMode,
  });
  pushLog("info", `UI available at http://localhost:${config.port}`);

  while (true) {
    try {
      const now = nowMs();
      const cooldown = getCooldown(state);
      const shouldUpdateUi = now - lastUiUpdateMs >= config.uiRefreshSeconds * 1000;
      const shouldScan =
        !state.position &&
        cooldown.remainingSec <= 0 &&
        now - lastScanMs >= config.scanIntervalSeconds * 1000;

      let solBalance = null;
      let solUsd = null;
      if (shouldUpdateUi || shouldScan || state.position) {
        solBalance = await getSolBalance(connection, keypair.publicKey);
      }
      if (shouldUpdateUi || state.position || shouldScan) {
        solUsd = await getSolUsdPriceCached();
      }

      if (state.position) {
        const position = state.position;
        const heldMinutes = (now - position.entryTimeMs) / 60000;
        const timeStopHit = heldMinutes >= config.exitHardMinutes;
        const softStopHit = heldMinutes >= config.exitSoftMinutes;

        let outSol = null;
        let pnlPct = null;
        let profitUsd = null;
        let totalValueUsd = null;

        if (manualExitRequested) {
          pushLog("warn", "Manual sell triggered. Exiting now.");
          const valuation = await estimateTokenValueSol(position);
          outSol = valuation.outSol;
          pnlPct = pctChange(position.entrySol, outSol);
          const solUsdNow = solUsd ?? (await getSolUsdPriceCached());
          profitUsd = (outSol - position.entrySol) * solUsdNow;
          const sig = await exitPosition(connection, keypair, position);
          manualExitRequested = false;
          pushLog("info", `${isSimulatorMode() ? "Simulated" : "Exit"} tx: ${sig}`);
          pushTrade({
            side: "sell",
            mint: position.mint,
            pnlPct,
            profitUsd,
            sig,
            reason: isSimulatorMode() ? "manual_simulated" : "manual",
          });
          state.position = null;
          state.lastExitTimeMs = nowMs();
          saveState(state);
          continue;
        }

        if (shouldUpdateUi) {
          const valuation = await estimateTokenValueSol(position);
          outSol = valuation.outSol;
          pnlPct = pctChange(position.entrySol, outSol);
          profitUsd = (outSol - position.entrySol) * solUsd;
          totalValueUsd = (solBalance + outSol) * solUsd;

          broadcastUi({
            status: "holding",
            balances: { sol: solBalance, solUsd, totalUsd: totalValueUsd },
            position: {
              mint: position.mint,
              heldMinutes,
              pnlPct,
              estUsd: outSol * solUsd,
              estSol: outSol,
            },
            cooldown,
          });
          lastUiUpdateMs = now;
        }

        if (totalValueUsd !== null && totalValueUsd <= config.accountStopUsd) {
          pushLog("warn", "Account stop triggered. Exiting.");
          const sig = await exitPosition(connection, keypair, position);
          pushLog("info", `${isSimulatorMode() ? "Simulated" : "Exit"} tx: ${sig}`);
          pushTrade({
            side: "sell",
            mint: position.mint,
            pnlPct,
            profitUsd,
            sig,
            reason: isSimulatorMode() ? "account_stop_simulated" : "account_stop",
          });
          state.position = null;
          state.lastExitTimeMs = nowMs();
          saveState(state);
          continue;
        }

        if (pnlPct !== null && pnlPct <= -config.stopLossPct * 100) {
          pushLog("warn", "Stop loss triggered. Exiting.");
          const sig = await exitPosition(connection, keypair, position);
          pushLog("info", `${isSimulatorMode() ? "Simulated" : "Exit"} tx: ${sig}`);
          pushTrade({
            side: "sell",
            mint: position.mint,
            pnlPct,
            profitUsd,
            sig,
            reason: isSimulatorMode() ? "stop_loss_simulated" : "stop_loss",
          });
          state.position = null;
          state.lastExitTimeMs = nowMs();
          saveState(state);
          continue;
        }

        if (pnlPct !== null && profitUsd !== null && shouldTakeProfit(pnlPct, profitUsd)) {
          pushLog("info", "Take profit triggered. Exiting.");
          const sig = await exitPosition(connection, keypair, position);
          pushLog("info", `${isSimulatorMode() ? "Simulated" : "Exit"} tx: ${sig}`);
          pushTrade({
            side: "sell",
            mint: position.mint,
            pnlPct,
            profitUsd,
            sig,
            reason: isSimulatorMode() ? "take_profit_simulated" : "take_profit",
          });
          state.position = null;
          state.lastExitTimeMs = nowMs();
          saveState(state);
          continue;
        }

        if (timeStopHit) {
          pushLog("info", "Hard time stop. Exiting.");
          const sig = await exitPosition(connection, keypair, position);
          pushLog("info", `${isSimulatorMode() ? "Simulated" : "Exit"} tx: ${sig}`);
          pushTrade({
            side: "sell",
            mint: position.mint,
            pnlPct,
            profitUsd,
            sig,
            reason: isSimulatorMode() ? "hard_time_simulated" : "hard_time",
          });
          state.position = null;
          state.lastExitTimeMs = nowMs();
          saveState(state);
          continue;
        }

        if (softStopHit && shouldUpdateUi) {
          const canExtend = pnlPct !== null && pnlPct >= config.minProfitToExtendPct && (await shouldExtendHold(position));
          if (!canExtend) {
            pushLog("info", "Soft time stop. Exiting.");
            const sig = await exitPosition(connection, keypair, position);
            pushLog("info", `${isSimulatorMode() ? "Simulated" : "Exit"} tx: ${sig}`);
            pushTrade({
              side: "sell",
              mint: position.mint,
              pnlPct,
              profitUsd,
              sig,
              reason: isSimulatorMode() ? "soft_time_simulated" : "soft_time",
            });
            state.position = null;
            state.lastExitTimeMs = nowMs();
            saveState(state);
            continue;
          }
        }

        if (shouldUpdateUi && pnlPct !== null && totalValueUsd !== null) {
          pushLog(
            "info",
            `Holding ${position.mint} | pnl ${pnlPct.toFixed(2)}% | held ${heldMinutes.toFixed(1)}m | est $${totalValueUsd.toFixed(2)}`
          );
        }
      } else {
        if (birdeyeBlockedUntilMs && now < birdeyeBlockedUntilMs && config.dataProvider === "birdeye") {
          const remainingSec = Math.ceil((birdeyeBlockedUntilMs - now) / 1000);
          broadcastUi({
            status: "birdeye-cooldown",
            balances: {
              sol: solBalance ?? 0,
              solUsd: solUsd ?? 0,
              totalUsd: (solBalance ?? 0) * (solUsd ?? 0),
            },
            position: null,
            cooldown,
          });
          if (shouldUpdateUi) {
            pushLog("warn", `Birdeye quota exceeded. Pausing scans for ${remainingSec}s`);
            lastUiUpdateMs = now;
          }
          await sleep(LOOP_MS);
          continue;
        }

        if (cooldown.remainingSec > 0) {
          broadcastUi({
            status: "cooldown",
            balances: { sol: solBalance ?? 0, solUsd: solUsd ?? 0, totalUsd: (solBalance ?? 0) * (solUsd ?? 0) },
            position: null,
            cooldown,
          });
          if (shouldUpdateUi) {
            pushLog("info", `Cooldown active. Next entry in ${cooldown.remainingSec}s`);
            lastUiUpdateMs = now;
          }
          await sleep(LOOP_MS);
          continue;
        }

        if (!shouldScan) {
          if (shouldUpdateUi && solBalance !== null && solUsd !== null) {
            const totalUsd = solBalance * solUsd;
            broadcastUi({ status: "waiting", balances: { sol: solBalance, solUsd, totalUsd }, position: null, cooldown });
            lastUiUpdateMs = now;
          }
          await sleep(LOOP_MS);
          continue;
        }

        const totalUsd = solBalance * solUsd;
        const tradeSol = Math.max(0, solBalance - config.feeBufferSol);
        if (tradeSol <= 0) {
          pushLog("warn", "Not enough SOL after fee buffer.");
          await sleep(LOOP_MS);
          continue;
        }

        const tradeLamports = Math.floor(tradeSol * LAMPORTS_PER_SOL);
        broadcastUi({ status: "scanning", balances: { sol: solBalance, solUsd, totalUsd }, position: null, cooldown });
        pushLog("info", `Scanning candidates. SOL $${totalUsd.toFixed(2)} tradeSol ${tradeSol.toFixed(4)}`);

        lastScanMs = now;
        const candidate = await pickCandidate(connection, tradeLamports);
        if (!candidate) {
          pushLog("info", "No candidates found.");
        } else {
          const momentumNote = candidate.momentum
            ? ` | momentum ${candidate.momentum.pctShort.toFixed(2)}%/${candidate.momentum.pctLong.toFixed(2)}%`
            : "";
          const volatilityNote = candidate.volatility
            ? ` | vol ${candidate.volatility.rangePct.toFixed(2)}%`
            : "";
          pushLog(
            "info",
            `Entering ${candidate.name || candidate.address} impact ${candidate.priceImpactPct?.toFixed?.(2) ?? "?"}%${volatilityNote}${momentumNote}`
          );
          const position = await enterPosition(connection, keypair, tradeLamports, candidate);
          state.position = position;
          state.lastTradeTimeMs = nowMs();
          saveState(state);
          pushTrade({
            side: "buy",
            mint: position.mint,
            pnlPct: 0,
            profitUsd: 0,
            sig: position.signature,
            reason: isSimulatorMode() ? "entry_simulated" : "entry",
          });
          pushLog("info", `${isSimulatorMode() ? "Simulated" : "Entry"} tx: ${position.signature}`);
        }
      }
    } catch (err) {
      if (isBirdeyeQuotaError(err)) {
        const blockMinutes = Math.max(1, config.birdeyeBlockMinutes || 10);
        birdeyeBlockedUntilMs = nowMs() + blockMinutes * 60 * 1000;
        pushLog("warn", `Birdeye quota exceeded. Pausing scans for ${blockMinutes} minutes.`);
      } else {
        await logSendTransactionError(err, connection);
        pushLog("error", err?.message || String(err));
      }
    }

    await sleep(LOOP_MS);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
