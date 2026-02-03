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
import { appendRugPullSample, computeRugPullRisk } from "./rugpull.js";
import { loadState, saveState } from "./state.js";
import { sleep, nowMs, pctChange } from "./utils.js";
import { startServer } from "./server.js";
import { logStructured } from "./logger.js";
import {
  initMetrics,
  recordError,
  recordTrade,
  setBalances,
  setOpenPositions,
  getMetricsRegister,
} from "./metrics.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const LOOP_MS = 5000;
const SOL_PRICE_TTL_MS = 15000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tradesPath = path.join(__dirname, "..", "trades.jsonl");
const tradesCsvPath = path.join(__dirname, "..", "trades.csv");
const trainingEventsPath = path.join(__dirname, "..", "training_events.jsonl");

const VALID_MODES = new Set(["sharp", "simulator"]);

function normalizeMode(value) {
  const mode = String(value || "").toLowerCase();
  return VALID_MODES.has(mode) ? mode : "sharp";
}

function parseMode(value) {
  const mode = String(value || "").toLowerCase();
  return VALID_MODES.has(mode) ? mode : null;
}

const initialMode = config.simulatorMode ? "simulator" : config.mode;
let currentMode = normalizeMode(initialMode);

const ui = {
  status: "starting",
  lastAction: "Starting bot",
  mode: currentMode,
  balances: { sol: 0, solUsd: 0, totalUsd: 0 },
  position: null,
  positions: [],
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
const appendQueue = [];
let appendFlushTimer = null;
let appendFlushing = false;

function isSimulatorMode() {
  return currentMode === "simulator";
}

function broadcastUi(patch = {}) {
  const next = { ...patch };
  if (next.status) next.status = formatStatus(next.status);
  Object.assign(ui, next);
  ui.updatedAt = nowMs();
  if (uiServer) uiServer.broadcast(ui);
}

function pushLog(level, msg) {
  const prefix = isSimulatorMode() ? "[SIM] " : "";
  const text = msg.startsWith(prefix) ? msg : `${prefix}${msg}`;
  const entry = { t: nowMs(), level, msg: text };
  ui.logs.push(entry);
  if (ui.logs.length > 200) ui.logs.shift();
  ui.lastAction = text;
  if (level === "error") console.error(text);
  else console.log(text);
  logStructured({ level, event: "log", message: text });
  broadcastUi();
}

function pushTrade(entry) {
  const record = { t: nowMs(), ...entry };
  ui.trades.push(record);
  if (ui.trades.length > 200) ui.trades.shift();
  enqueueAppend(tradesPath, `${JSON.stringify(record)}\n`);
  appendTradeCsv(record);
  recordTrade(record.side);
  logStructured({ level: "info", event: "trade", message: record.reason || "trade", trade: record });
  broadcastUi();
}

function pushTrainingEvent(entry) {
  const record = { t: nowMs(), ...entry };
  enqueueAppend(trainingEventsPath, `${JSON.stringify(record)}\n`);
}

function buildDecisionMetadata(reason, cooldown) {
  return {
    reason,
    cooldown,
    thresholds: {
      stopLossPct: config.stopLossPct,
      takeProfitPct: config.takeProfitPct,
      takeProfitUsd: config.takeProfitUsd,
      exitSoftMinutes: config.exitSoftMinutes,
      exitHardMinutes: config.exitHardMinutes,
      minProfitToExtendPct: config.minProfitToExtendPct,
      rsiLow: config.rsiLow,
      emaFast: config.emaFast,
      emaSlow: config.emaSlow,
      bollPeriod: config.bollPeriod,
      bollStd: config.bollStd,
      volSpikeMult: config.volSpikeMult,
      minLiquidityUsd: config.minLiquidityUsd,
      minVol24hUsd: config.minVol24hUsd,
      minVol15mUsd: config.minVol15mUsd,
      minVolatilityPct: config.minVolatilityPct,
      maxPriceImpactPct: config.maxPriceImpactPct,
      maxTop10Pct: config.maxTop10Pct,
      momentumMode: config.momentumMode,
      momentumMinPctShort: config.momentumMinPctShort,
      momentumMinPctLong: config.momentumMinPctLong,
      momentumWeightShort: config.momentumWeightShort,
      momentumWeightLong: config.momentumWeightLong,
      flashWindowMinutes: config.flashWindowMinutes,
      dexPriceChangeWindow: config.dexPriceChangeWindow,
      dexMinPriceChangePct: config.dexMinPriceChangePct,
    },
  };
}

function buildEntrySnapshot(candidate) {
  if (!candidate) return null;
  return {
    provider: candidate.provider,
    address: candidate.address,
    name: candidate.name,
    score: candidate.score,
    signal: candidate.signal,
    momentum: candidate.momentum,
    volatility: candidate.volatility,
    priceImpactPct: candidate.priceImpactPct,
    liquidityUsd: candidate.liquidityUsd ?? null,
    volume: {
      vol24hUsd: candidate.vol24hUsd ?? null,
      vol15mUsd: candidate.vol15mUsd ?? null,
    },
    holdersPct: candidate.holdersPct ?? null,
    marketContext: candidate.marketContext ?? null,
  };
}

function buildTrainingEvent({
  event,
  side,
  mint,
  sig,
  pnlPct,
  profitUsd,
  heldMinutes,
  decision,
  entrySnapshot,
}) {
  return {
    event,
    side,
    mint,
    sig,
    pnlPct,
    profitUsd,
    heldMinutes,
    decision,
    entrySnapshot,
  };
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
    enqueueAppend(tradesCsvPath, `${headers.join(",")}\n`);
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
  enqueueAppend(tradesCsvPath, `${row.join(",")}\n`);
}

function enqueueAppend(filePath, payload) {
  appendQueue.push({ filePath, payload });
  scheduleAppendFlush();
}

function scheduleAppendFlush() {
  if (appendFlushTimer) return;
  appendFlushTimer = setTimeout(() => {
    appendFlushTimer = null;
    void flushAppendQueue();
  }, 25);
}

async function flushAppendQueue() {
  if (appendFlushing) return;
  appendFlushing = true;
  try {
    while (appendQueue.length) {
      const { filePath, payload } = appendQueue.shift();
      try {
        await fs.promises.appendFile(filePath, payload);
      } catch (err) {
        console.error(`Failed to append to ${filePath}: ${err?.message || String(err)}`);
      }
    }
  } finally {
    appendFlushing = false;
    if (appendQueue.length) scheduleAppendFlush();
  }
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
  const relaxedCandidates = [];
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
    rugRiskHigh: 0,
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
    let holdersPct = null;

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
      } else {
        holdersPct = holders.pct;
        if (holders.pct !== null && holders.pct > config.maxTop10Pct) {
          stats.holdersTooHigh += 1;
          continue;
        }
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

    const rugRisk = computeRugPullRisk({ overview, security, mintInfo, holdersPct });
    if (config.rugRiskMaxScore >= 0 && rugRisk.score > config.rugRiskMaxScore) {
      stats.rugRiskHigh += 1;
      continue;
    }

    const baseScore = config.momentumMode ? momentum?.score ?? 0 : signal?.score ?? 0;
    const volatilityScore = config.volatilityWeight * volatility.rangePct + volatility.chopPct;
    const rugRiskPenalty = Math.max(0, config.rugRiskWeight || 0) * rugRisk.score;
    const score =
      baseScore +
      volatilityScore +
      (priceImpactPct !== null ? (config.maxPriceImpactPct - priceImpactPct) / 2 : 0) -
      rugRiskPenalty;

    const targetList = entryOk
      ? candidates
      : config.momentumMode && momentumRelaxedOk
        ? relaxedCandidates
        : volatilityOnlyCandidates;
    appendRugPullSample({
      source: "birdeye",
      address,
      name,
      entryOk,
      score,
      rugRisk,
      priceImpactPct,
      signal,
      momentum,
      volatility,
    });
    targetList.push({
      address,
      name,
      score,
      quote,
      signal,
      momentum,
      volatility,
      priceImpactPct,
      rugRisk,
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
      `Filter stats: total ${stats.total} | lowLiq ${stats.liquidityLow} lowVol24 ${stats.vol24hLow} lowVol15 ${stats.vol15mLow} lowVol ${stats.volatilityLow} badVol ${stats.volatilityBad} sigFail ${stats.signalFail} momFail ${stats.momentumFail} impact ${stats.priceImpactHigh} rugRisk ${stats.rugRiskHigh} auth ${stats.authority} holders ${stats.holdersTooHigh} ohlcv ${stats.ohlcvShort}`
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
    rugRiskHigh: 0,
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
    let holdersPct = null;

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
      } else {
        holdersPct = holders.pct;
        if (holders.pct !== null && holders.pct > config.maxTop10Pct) {
          stats.holdersTooHigh += 1;
          continue;
        }
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

    const overview = {
      liquidityUSD: liquidityUsd,
      volume24hUSD: vol24hUsd,
    };
    const rugRisk = computeRugPullRisk({ overview, mintInfo, holdersPct });
    if (config.rugRiskMaxScore >= 0 && rugRisk.score > config.rugRiskMaxScore) {
      stats.rugRiskHigh += 1;
      continue;
    }

    const baseScore = priceChangePct ?? 0;
    const volScore = Math.log10((vol24hUsd || 0) + 1) * 2;
    const liqScore = Math.log10((liquidityUsd || 0) + 1);
    const rugRiskPenalty = Math.max(0, config.rugRiskWeight || 0) * rugRisk.score;
    const score =
      baseScore +
      volScore +
      liqScore +
      (priceImpactPct !== null ? (config.maxPriceImpactPct - priceImpactPct) / 2 : 0) -
      rugRiskPenalty;

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
      rugRisk,
    });
    appendRugPullSample({
      source: "dexscreener",
      address,
      name,
      entryOk: true,
      score,
      rugRisk,
      priceImpactPct,
      signal,
      momentum,
      volatility,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) return candidates[0];

  pushLog(
    "warn",
    `DexScreener filter stats: total ${stats.total} | lowLiq ${stats.liquidityLow} lowVol24 ${stats.vol24hLow} lowVol15 ${stats.vol15mLow} lowChange ${stats.priceChangeLow} impact ${stats.priceImpactHigh} rugRisk ${stats.rugRiskHigh} auth ${stats.authority} holders ${stats.holdersTooHigh}`
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

async function enterPosition(connection, keypair, tradeLamports, candidate, { simulate = false } = {}) {
  const adjustedLamports = simulate
    ? tradeLamports
    : await adjustTradeLamportsForAtaRent(connection, keypair.publicKey, candidate.address, tradeLamports);
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
  const sig = simulate ? `sim-${nowMs()}` : await sendSwap(connection, keypair, freshQuote);

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
  const outSol = Number(quote.outAmount || 0) / LAMPORTS_PER_SOL;
  return { sig, outSol, quote };
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

function buildPositionSummary(position, { heldMinutes, pnlPct, estUsd, estSol } = {}) {
  return {
    id: position.id,
    mint: position.mint,
    heldMinutes,
    pnlPct,
    estUsd,
    estSol,
  };
}

async function run() {
  requireConfig();
  initMetrics();
  const connection = createConnection(config.rpcUrl);
  const state = loadState();
  let keypair = null;

  const getActivePositions = () => (isSimulator ? state.simPositions : state.positions);
  const setActivePositions = (value) => {
    if (isSimulator) state.simPositions = value;
    else state.positions = value;
  };

  const ensureNumber = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
  state.simBalanceSol = ensureNumber(state.simBalanceSol, 0);
  state.simBalanceUsd = ensureNumber(state.simBalanceUsd, 0);
  const applySimExit = (outSol, solUsdNow) => {
    if (!isSimulator) return;
    const updatedSol = ensureNumber(state.simBalanceSol, 0) + ensureNumber(outSol, 0);
    state.simBalanceSol = Math.max(0, updatedSol);
    state.simBalanceUsd = state.simBalanceSol * ensureNumber(solUsdNow, 0);
  };

  const normalizedPositions = getActivePositions().map((pos, idx) => ({
    ...pos,
    id: pos.id || `pos-${nowMs()}-${idx}`,
  }));
  setActivePositions(normalizedPositions);
  state.position = normalizedPositions[0] ?? null;
  state.simPosition = normalizedPositions[0] ?? null;

  const resolveSimulatorStartBalance = async () => {
    if (config.simulatorStartSol > 0) return config.simulatorStartSol;
    if (config.simulatorStartUsd > 0) {
      const solUsd = await getSolUsdPriceCached();
      if (solUsd > 0) return config.simulatorStartUsd / solUsd;
    }
    return 0;
  };

  const ensureSimulatorBalance = async () => {
    if (!isSimulatorMode() || state.simBalanceSol > 0) return;
    const startSol = await resolveSimulatorStartBalance();
    if (startSol <= 0) return;
    state.simBalanceSol = startSol;
    const solUsd = await getSolUsdPriceCached();
    state.simBalanceUsd = state.simBalanceSol * solUsd;
    saveState(state);
    pushLog("info", `Simulator balance initialized to ${state.simBalanceSol.toFixed(4)} SOL.`);
  };

  await ensureSimulatorBalance();

  if (!isSimulator && keypair) {
    await reconcilePositionWithChain(connection, state, keypair);
  }

  const requestManualExit = () => {
    if (!getActivePositions().length) return { ok: false, error: "no_position" };
    if (manualExitRequested) {
      return { ok: true, requested: true, alreadyQueued: true };
    }
    manualExitRequested = true;
    manualExitRequestedAt = nowMs();
    pushLog("warn", "Manual sell requested. Exiting positions on next loop.");
    return { ok: true, requested: true, queuedAt: manualExitRequestedAt };
  };

  const requestResetCooldown = () => {
    if (getActivePositions().length) return { ok: false, error: "position_open" };
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

  const buildStats = () => ({
    status: ui.status,
    mode: ui.mode,
    balances: ui.balances,
    positions: ui.positions,
    lastAction: ui.lastAction,
    trades: ui.trades.slice(-50),
  });

  uiServer = startServer({
    port: config.port,
    host: config.host,
    onSellNow: requestManualExit,
    onResetCooldown: requestResetCooldown,
    onSetMode: requestSetMode,
    onGetStats: buildStats,
    metricsEnabled: config.metricsEnabled,
    metricsPath: config.metricsPath,
    metricsRegister: getMetricsRegister(),
    statsApiKey: config.statsApiKey,
  });
  pushLog("info", `UI available at http://localhost:${config.port}`);

  while (true) {
    try {
      const now = nowMs();
      await ensureSimulatorBalance();
      const simulatorActive = isSimulatorMode();
      const cooldown = getCooldown(state);
      const shouldUpdateUi = now - lastUiUpdateMs >= config.uiRefreshSeconds * 1000;
      const positions = getActivePositions();
      const shouldScan =
        positions.length < config.maxOpenPositions &&
        cooldown.remainingSec <= 0 &&
        now - lastScanMs >= config.scanIntervalSeconds * 1000;

      let solBalance = null;
      let solUsd = null;
      if (shouldUpdateUi || shouldScan || positions.length) {
        solBalance = isSimulator ? state.simBalanceSol : await getSolBalance(connection, keypair.publicKey);
      }
      if (shouldUpdateUi || positions.length || shouldScan) {
        solUsd = await getSolUsdPriceCached();
      }
      setOpenPositions(positions.length);

      const closePosition = async ({
        position,
        reason,
        pnlPct,
        profitUsd,
        heldMinutes,
        solUsdNow,
      }) => {
        const { sig, outSol } = await exitPosition(connection, keypair, position);
        pushLog("info", `Exit tx: ${sig}`);
        pushTrade({ side: "sell", mint: position.mint, pnlPct, profitUsd, sig, reason, positionId: position.id });
        pushTrainingEvent(
          buildTrainingEvent({
            event: "exit",
            side: "sell",
            mint: position.mint,
            sig,
            pnlPct,
            profitUsd,
            heldMinutes,
            decision: buildDecisionMetadata(reason, getCooldown(state)),
            entrySnapshot: position.entrySnapshot ?? null,
          })
        );
        const remaining = getActivePositions().filter((item) => item.id !== position.id);
        setActivePositions(remaining);
        if (isSimulator) {
          state.simBalanceSol += outSol;
          state.simBalanceUsd = state.simBalanceSol * (solUsdNow || 0);
        }
        state.position = remaining[0] ?? null;
        state.simPosition = remaining[0] ?? null;
        state.lastExitTimeMs = nowMs();
        saveState(state);
      };

      if (positions.length) {
        const positionSnapshots = [];
        const uiPositions = [];
        let positionsEstSol = 0;

        for (const position of positions) {
          const heldMinutes = (now - position.entryTimeMs) / 60000;
          const valuation = await estimateTokenValueSol(position);
          const outSol = valuation.outSol;
          const pnlPct = pctChange(position.entrySol, outSol);
          const profitUsd = solUsd !== null ? (outSol - position.entrySol) * solUsd : null;
          positionsEstSol += outSol;
          positionSnapshots.push({ position, heldMinutes, outSol, pnlPct, profitUsd });
          if (shouldUpdateUi) {
            uiPositions.push(
              buildPositionSummary(position, {
                heldMinutes,
                pnlPct,
                estUsd: solUsd ? outSol * solUsd : null,
                estSol: outSol,
              })
            );
          }
        }

        const totalValueUsd = solUsd !== null ? (solBalance + positionsEstSol) * solUsd : null;
        if (shouldUpdateUi) {
          broadcastUi({
            status: "holding",
            balances: { sol: solBalance, solUsd, totalUsd: totalValueUsd ?? 0 },
            position: uiPositions[0] ?? null,
            positions: uiPositions,
            cooldown,
          });
          lastUiUpdateMs = now;
        }
        setBalances({ sol: solBalance, solUsd, totalUsd: totalValueUsd ?? 0 });

        const accountStopHit =
          totalValueUsd !== null && config.accountStopUsd > 0 && totalValueUsd <= config.accountStopUsd;

        for (const snapshot of positionSnapshots) {
          const { position, heldMinutes, pnlPct, profitUsd } = snapshot;
          const timeStopHit = heldMinutes >= config.exitHardMinutes;
          const softStopHit = heldMinutes >= config.exitSoftMinutes;
          const solUsdNow = solUsd ?? (await getSolUsdPriceCached());

          if (manualExitRequested) {
            pushLog("warn", "Manual sell triggered. Exiting now.");
            await closePosition({
              position,
              reason: "manual",
              pnlPct,
              profitUsd,
              heldMinutes,
              solUsdNow,
            });
            continue;
          }

          if (accountStopHit) {
            pushLog("warn", "Account stop triggered. Exiting.");
            await closePosition({
              position,
              reason: "account_stop",
              pnlPct,
              profitUsd,
              heldMinutes,
              solUsdNow,
            });
            continue;
          }

          if (pnlPct !== null && pnlPct <= -config.stopLossPct * 100) {
            pushLog("warn", "Stop loss triggered. Exiting.");
            await closePosition({
              position,
              reason: "stop_loss",
              pnlPct,
              profitUsd,
              heldMinutes,
              solUsdNow,
            });
            continue;
          }

          if (pnlPct !== null && profitUsd !== null && shouldTakeProfit(pnlPct, profitUsd)) {
            pushLog("info", "Take profit triggered. Exiting.");
            await closePosition({
              position,
              reason: "take_profit",
              pnlPct,
              profitUsd,
              heldMinutes,
              solUsdNow,
            });
            continue;
          }

          if (timeStopHit) {
            pushLog("info", "Hard time stop. Exiting.");
            await closePosition({
              position,
              reason: "hard_time",
              pnlPct,
              profitUsd,
              heldMinutes,
              solUsdNow,
            });
            continue;
          }

          if (softStopHit && shouldUpdateUi) {
            const canExtend =
              pnlPct !== null &&
              pnlPct >= config.minProfitToExtendPct &&
              (await shouldExtendHold(position));
            if (!canExtend) {
              pushLog("info", "Soft time stop. Exiting.");
              await closePosition({
                position,
                reason: "soft_time",
                pnlPct,
                profitUsd,
                heldMinutes,
                solUsdNow,
              });
              continue;
            }
          }

          if (shouldUpdateUi && pnlPct !== null && totalValueUsd !== null) {
            pushLog(
              "info",
              `Holding ${position.mint} | pnl ${pnlPct.toFixed(2)}% | held ${heldMinutes.toFixed(
                1
              )}m | est $${totalValueUsd.toFixed(2)}`
            );
          }
        }

        manualExitRequested = false;
      }

      if (!shouldScan) {
        if (!positions.length) {
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
              positions: [],
              cooldown,
            });
            setBalances({
              sol: solBalance ?? 0,
              solUsd: solUsd ?? 0,
              totalUsd: (solBalance ?? 0) * (solUsd ?? 0),
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
              positions: [],
              cooldown,
            });
            setBalances({
              sol: solBalance ?? 0,
              solUsd: solUsd ?? 0,
              totalUsd: (solBalance ?? 0) * (solUsd ?? 0),
            });
            if (shouldUpdateUi) {
              pushLog("info", `Cooldown active. Next entry in ${cooldown.remainingSec}s`);
              lastUiUpdateMs = now;
            }
            await sleep(LOOP_MS);
            continue;
          }

          if (shouldUpdateUi && solBalance !== null && solUsd !== null) {
            const totalUsd = solBalance * solUsd;
            broadcastUi({
              status: "waiting",
              balances: { sol: solBalance, solUsd, totalUsd },
              position: null,
              positions: [],
              cooldown,
            });
            setBalances({ sol: solBalance, solUsd, totalUsd });
            lastUiUpdateMs = now;
          }
        }
        await sleep(LOOP_MS);
        continue;
      }

      if (birdeyeBlockedUntilMs && now < birdeyeBlockedUntilMs && config.dataProvider === "birdeye") {
        if (shouldUpdateUi) {
          const remainingSec = Math.ceil((birdeyeBlockedUntilMs - now) / 1000);
          pushLog("warn", `Birdeye quota exceeded. Pausing scans for ${remainingSec}s`);
        }
        await sleep(LOOP_MS);
        continue;
      }

      const totalUsd = solBalance * solUsd;
      const feeBufferSol = isSimulator ? config.simulatorFeeBufferSol : config.feeBufferSol;
      const availableSol = Math.max(0, solBalance - feeBufferSol);
      if (availableSol <= 0) {
        pushLog("warn", "Not enough SOL after fee buffer.");
        await sleep(LOOP_MS);
        continue;
      }

      const allocationPct = Math.min(1, Math.max(0, (config.tradeAllocationPct || 0) / 100));
      let tradeSol = availableSol * (allocationPct || 1);
      if (config.maxPositionSol > 0) {
        tradeSol = Math.min(tradeSol, config.maxPositionSol);
      }
      if (config.minRemainingSol > 0) {
        tradeSol = Math.min(tradeSol, Math.max(0, availableSol - config.minRemainingSol));
      }
      if (tradeSol <= 0) {
        pushLog("warn", "Trade allocation too small after enforcing reserves.");
        await sleep(LOOP_MS);
        continue;
      }

      const tradeLamports = Math.floor(tradeSol * LAMPORTS_PER_SOL);
      if (!positions.length) {
        broadcastUi({
          status: "scanning",
          balances: { sol: solBalance, solUsd, totalUsd },
          position: null,
          positions: [],
          cooldown,
        });
        setBalances({ sol: solBalance, solUsd, totalUsd });
      }
      pushLog(
        "info",
        `Scanning candidates. SOL $${totalUsd.toFixed(2)} tradeSol ${tradeSol.toFixed(4)}`
      );

      lastScanMs = now;
      const candidate = await pickCandidate(connection, tradeLamports);
      if (!candidate) {
        pushLog("info", "No candidates found.");
      } else if (positions.some((item) => item.mint === candidate.address)) {
        pushLog("info", "Candidate already held. Skipping entry.");
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
        const entrySnapshot = buildEntrySnapshot(candidate);
        const position = await enterPosition(connection, keypair, tradeLamports, candidate);
        position.id = `pos-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
        position.entrySnapshot = entrySnapshot;
        const nextPositions = [...getActivePositions(), position];
        setActivePositions(nextPositions);
        state.position = nextPositions[0] ?? null;
        state.simPosition = nextPositions[0] ?? null;
        state.lastTradeTimeMs = nowMs();
        if (isSimulator) {
          state.simBalanceSol = Math.max(0, state.simBalanceSol - position.entrySol);
          state.simBalanceUsd = state.simBalanceSol * solUsd;
        }
        saveState(state);
        const entryCooldown = getCooldown(state);
        pushTrade({
          side: "buy",
          mint: position.mint,
          pnlPct: 0,
          profitUsd: 0,
          sig: position.signature,
          reason: isSimulatorMode() ? "entry_simulated" : "entry",
          positionId: position.id,
        });
        pushTrainingEvent(
          buildTrainingEvent({
            event: "entry",
            side: "buy",
            mint: position.mint,
            sig: position.signature,
            pnlPct: 0,
            profitUsd: 0,
            heldMinutes: 0,
            decision: buildDecisionMetadata("entry", entryCooldown),
            entrySnapshot,
          })
        );
        pushLog("info", `Entry tx: ${position.signature}`);
      }
    } catch (err) {
      if (isBirdeyeQuotaError(err)) {
        const blockMinutes = Math.max(1, config.birdeyeBlockMinutes || 10);
        birdeyeBlockedUntilMs = nowMs() + blockMinutes * 60 * 1000;
        pushLog("warn", `Birdeye quota exceeded. Pausing scans for ${blockMinutes} minutes.`);
        recordError("birdeye_quota");
      } else {
        await logSendTransactionError(err, connection);
        pushLog("error", err?.message || String(err));
        recordError("runtime");
      }
    }

    await sleep(LOOP_MS);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
