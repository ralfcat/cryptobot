import config from "./config.js";
import { avg, pctChange, sum } from "./utils.js";
import { bollinger, emaSeries, lastEma, rsi } from "./indicators.js";

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

  const ok = (valley && trigger) || trend;

  let score = 0;
  if (trend) score += 2;
  if (valley) score += 1;
  if (trigger) score += 1;
  if (rsiVal !== null && rsiVal > 50) score += 1;

  return {
    ok,
    score,
    rsi: rsiVal,
    emaFast,
    emaSlow,
    volumeSpike,
    valley,
    trend,
    trigger,
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
