import fs from "fs";
import path from "path";
import config from "./config.js";
import { avg, pctChange, sum } from "./utils.js";
import { bollinger, emaSeries, lastEma, rsi } from "./indicators.js";

const defaultPointerPath = path.resolve(process.cwd(), "models", "latest.json");
const modelState = {
  pointerPath: config.modelPath ? path.resolve(process.cwd(), config.modelPath) : defaultPointerPath,
  resolvedPath: "",
  loadedAt: null,
  model: null,
  lastError: null,
};

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function isValidModel(model) {
  return (
    model &&
    Array.isArray(model.featureList) &&
    model.featureList.length > 0 &&
    model.weights &&
    typeof model.weights === "object"
  );
}

function resolveModelPath(pointerPath, parsed) {
  if (isValidModel(parsed)) {
    return { modelPath: pointerPath, model: parsed };
  }
  const candidatePath = parsed?.modelPath;
  if (candidatePath) {
    return {
      modelPath: path.isAbsolute(candidatePath)
        ? candidatePath
        : path.resolve(path.dirname(pointerPath), candidatePath),
      model: null,
    };
  }
  const metadataPath = parsed?.metadataPath;
  if (metadataPath) {
    const resolvedMetadataPath = path.isAbsolute(metadataPath)
      ? metadataPath
      : path.resolve(path.dirname(pointerPath), metadataPath);
    const metadataRaw = fs.readFileSync(resolvedMetadataPath, "utf8");
    const metadata = JSON.parse(metadataRaw);
    if (metadata?.modelPath) {
      return {
        modelPath: path.isAbsolute(metadata.modelPath)
          ? metadata.modelPath
          : path.resolve(path.dirname(resolvedMetadataPath), metadata.modelPath),
        model: null,
      };
    }
  }
  throw new Error("Model pointer missing modelPath.");
}

function loadModel() {
  if (!modelState.pointerPath) return null;
  try {
    const raw = fs.readFileSync(modelState.pointerPath, "utf8");
    const parsed = JSON.parse(raw);
    const resolved = resolveModelPath(modelState.pointerPath, parsed);
    if (resolved.model) {
      modelState.model = resolved.model;
      modelState.resolvedPath = resolved.modelPath;
      modelState.loadedAt = Date.now();
      modelState.lastError = null;
      return resolved.model;
    }
    const modelRaw = fs.readFileSync(resolved.modelPath, "utf8");
    const modelParsed = JSON.parse(modelRaw);
    if (!isValidModel(modelParsed)) {
      throw new Error("Model file missing required fields.");
    }
    modelState.model = modelParsed;
    modelState.resolvedPath = resolved.modelPath;
    modelState.loadedAt = Date.now();
    modelState.lastError = null;
    return modelParsed;
  } catch (err) {
    modelState.lastError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

function scheduleModelRefresh() {
  if (!modelState.pointerPath) return;
  loadModel();
  if (config.modelRefreshMs <= 0) return;
  const timer = setInterval(() => {
    loadModel();
  }, config.modelRefreshMs);
  if (timer.unref) timer.unref();
}

scheduleModelRefresh();

export function normalizeCandles(ohlcv) {
  const items = ohlcv?.items || ohlcv?.data?.items || ohlcv?.data || [];
  const candles = items
    .map((c) => ({
      t: c.t ?? c.time ?? c.timestamp ?? c.start ?? c.openTime,
      o: Number(c.o ?? c.open ?? c.open_price ?? c.openPrice),
      h: Number(c.h ?? c.high ?? c.high_price ?? c.highPrice),
      l: Number(c.l ?? c.low ?? c.low_price ?? c.lowPrice),
      c: Number(c.c ?? c.close ?? c.close_price ?? c.closePrice),
      v: Number(c.v ?? c.volume ?? c.volumeUsd ?? c.volumeUSD ?? c.vol ?? 0),
    }))
    .filter((c) => Number.isFinite(c.c) && Number.isFinite(c.v));

  return candles;
}

function buildModelFeatures({ rsiVal, emaFast, emaSlow, volumeSpike, valley, trend, trigger, last }) {
  const emaFastMinusSlow =
    emaFast !== null && emaSlow !== null ? emaFast - emaSlow : 0;
  return {
    rsi: rsiVal ?? 0,
    emaFast: emaFast ?? 0,
    emaSlow: emaSlow ?? 0,
    volumeSpike: volumeSpike ? 1 : 0,
    valley: valley ? 1 : 0,
    trend: trend ? 1 : 0,
    trigger: trigger ? 1 : 0,
    price: last?.c ?? 0,
    volume: last?.v ?? 0,
    emaFastMinusSlow,
  };
}

function normalizeFeatureValue(feature, value, normalization) {
  const stats = normalization?.[feature];
  if (!stats) return value;
  const std = stats.std || 1;
  return (value - stats.mean) / std;
}

function scoreWithModel(features) {
  const model = modelState.model;
  if (!isValidModel(model)) return null;
  try {
    let total = model.bias || 0;
    for (const feature of model.featureList) {
      const rawValue = Number.isFinite(features[feature]) ? features[feature] : 0;
      const value = normalizeFeatureValue(feature, rawValue, model.normalization);
      const weight = Number.isFinite(model.weights?.[feature]) ? model.weights[feature] : 0;
      total += weight * value;
    }
    const probability = sigmoid(total);
    return {
      probability,
      threshold: Number.isFinite(model.hyperparameters?.threshold)
        ? model.hyperparameters.threshold
        : config.modelThreshold,
      modelVersion: model.version ?? null,
      loadedAt: modelState.loadedAt,
    };
  } catch (err) {
    modelState.lastError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

export function computeSignal(candles) {
  if (candles.length < Math.max(config.bollPeriod, config.emaSlow) + 2) {
    return { ok: false, reason: "not_enough_candles" };
  }
  const closes = candles.map((c) => c.c);
  const volumes = candles.map((c) => c.v);
  const last = candles[candles.length - 1];

  const emaFastSeries = emaSeries(closes, config.emaFast);
  const emaSlowSeries = emaSeries(closes, config.emaSlow);
  const emaFast = lastEma(closes, config.emaFast);
  const emaSlow = lastEma(closes, config.emaSlow);
  const rsiVal = rsi(closes, 14);
  const bb = bollinger(closes, config.bollPeriod, config.bollStd);

  const emaFastPrev = emaFastSeries[emaFastSeries.length - 2];
  const emaSlowPrev = emaSlowSeries[emaSlowSeries.length - 2];
  const emaFastUp = emaFast !== null && emaFastPrev !== null ? emaFast > emaFastPrev : false;
  const emaSlowUp = emaSlow !== null && emaSlowPrev !== null ? emaSlow > emaSlowPrev : false;

  const volAvg = avg(volumes.slice(-10));
  const volumeSpike = volAvg > 0 ? last.v > volAvg * config.volSpikeMult : false;

  const valley = (rsiVal !== null && rsiVal < config.rsiLow) || (bb && last.c < bb.lower);
  const trend = emaFast !== null && emaSlow !== null && emaFast > emaSlow && emaFastUp && emaSlowUp;
  const trigger = emaFast !== null && last.c > emaFast && volumeSpike;

  const ruleOk = (valley && trigger) || trend;

  let ruleScore = 0;
  if (trend) ruleScore += 2;
  if (valley) ruleScore += 1;
  if (trigger) ruleScore += 1;
  if (rsiVal !== null && rsiVal > 50) ruleScore += 1;

  const features = buildModelFeatures({
    rsiVal,
    emaFast,
    emaSlow,
    volumeSpike,
    valley,
    trend,
    trigger,
    last,
  });
  const modelResult = scoreWithModel(features);
  const modelThreshold = modelResult?.threshold ?? config.modelThreshold;
  const ok = modelResult ? modelResult.probability >= modelThreshold : ruleOk;
  const score = modelResult ? modelResult.probability : ruleScore;

  return {
    ok,
    score,
    ruleScore,
    rsi: rsiVal,
    emaFast,
    emaSlow,
    bollinger: bb,
    volumeSpike,
    valley,
    trend,
    trigger,
    model: modelResult
      ? {
          probability: modelResult.probability,
          threshold: modelThreshold,
          version: modelResult.modelVersion,
          loadedAt: modelResult.loadedAt,
        }
      : {
          probability: null,
          threshold: config.modelThreshold,
          version: null,
          loadedAt: null,
          error: modelState.lastError,
        },
  };
}

export function computeMomentum(candles) {
  const short = Math.min(config.momentumShortMinutes, candles.length);
  const long = Math.min(config.momentumLongMinutes, candles.length);
  if (short < 2 || long < 2) {
    return { ok: false, reason: "not_enough_candles" };
  }

  const last = candles[candles.length - 1];
  const shortStart = candles[candles.length - short]?.c ?? last.c;
  const longStart = candles[candles.length - long]?.c ?? last.c;

  const pctShort = pctChange(shortStart, last.c);
  const pctLong = pctChange(longStart, last.c);

  const okShort = config.momentumMinPctShort > 0 ? pctShort >= config.momentumMinPctShort : true;
  const okLong = config.momentumMinPctLong > 0 ? pctLong >= config.momentumMinPctLong : true;

  const score = pctShort * config.momentumWeightShort + pctLong * config.momentumWeightLong;

  return {
    ok: okShort && okLong,
    score,
    pctShort,
    pctLong,
  };
}

export function volumeLastMinutes(candles, minutes = 15) {
  if (!candles.length) return 0;
  const count = Math.min(candles.length, minutes);
  const slice = candles.slice(candles.length - count);
  return sum(slice.map((c) => c.v));
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function computeVolatility(candles, minutes = 15) {
  const count = Math.min(candles.length, minutes);
  if (count < 2) return { ok: false, reason: "not_enough_candles" };
  const slice = candles.slice(candles.length - count);

  let minLow = null;
  let maxHigh = null;
  let totalAbsPct = 0;
  let moves = 0;

  for (let i = 0; i < slice.length; i += 1) {
    const c = slice[i];
    const low = safeNumber(c.l ?? c.c, null);
    const high = safeNumber(c.h ?? c.c, null);
    if (low !== null) minLow = minLow === null ? low : Math.min(minLow, low);
    if (high !== null) maxHigh = maxHigh === null ? high : Math.max(maxHigh, high);

    if (i > 0) {
      const prev = slice[i - 1];
      const prevClose = safeNumber(prev.c, null);
      const close = safeNumber(c.c, null);
      if (prevClose && close) {
        totalAbsPct += Math.abs(pctChange(prevClose, close));
        moves += 1;
      }
    }
  }

  if (!minLow || !maxHigh || minLow <= 0) return { ok: false, reason: "bad_range" };
  const rangePct = ((maxHigh - minLow) / minLow) * 100;
  const chopPct = moves > 0 ? totalAbsPct / moves : 0;

  return {
    ok: true,
    rangePct,
    chopPct,
  };
}
