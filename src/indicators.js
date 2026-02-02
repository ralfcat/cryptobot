import { avg } from "./utils.js";

export function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const seed = avg(values.slice(0, period));
  const series = new Array(period - 1).fill(null);
  let emaPrev = seed;
  series.push(seed);
  for (let i = period; i < values.length; i += 1) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
    series.push(emaPrev);
  }
  return series;
}

export function lastEma(values, period) {
  const series = emaSeries(values, period);
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i] !== null && Number.isFinite(series[i])) return series[i];
  }
  return null;
}

export function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function bollinger(values, period = 20, stdMult = 2) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  const mean = avg(slice);
  const variance = avg(slice.map((v) => (v - mean) ** 2));
  const std = Math.sqrt(variance);
  return {
    mid: mean,
    upper: mean + stdMult * std,
    lower: mean - stdMult * std,
  };
}
