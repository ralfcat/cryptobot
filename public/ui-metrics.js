export function fmtUsd(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `$${Number(value).toFixed(2)}`;
}

export function fmtNum(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

export function fmtPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${Number(value).toFixed(digits)}%`;
}

export function fmtTime(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleTimeString();
}

export function computeTradeStats(items) {
  const trades = Array.isArray(items) ? items.slice().sort((a, b) => (a.t || 0) - (b.t || 0)) : [];
  let closed = 0;
  let wins = 0;
  let totalPnlUsd = 0;
  let totalPnlPct = 0;
  let best = null;
  let worst = null;
  const holds = [];
  const lastBuyByMint = new Map();

  for (const trade of trades) {
    const side = String(trade.side || "").toLowerCase();
    if (side === "buy") {
      if (trade.mint) lastBuyByMint.set(trade.mint, trade);
      continue;
    }
    if (side !== "sell") continue;
    closed += 1;
    const pnlUsd = Number(trade.profitUsd);
    const pnlPct = Number(trade.pnlPct);
    if (Number.isFinite(pnlUsd)) {
      totalPnlUsd += pnlUsd;
      if (pnlUsd > 0) wins += 1;
    }
    if (Number.isFinite(pnlPct)) {
      totalPnlPct += pnlPct;
      best = best === null ? pnlPct : Math.max(best, pnlPct);
      worst = worst === null ? pnlPct : Math.min(worst, pnlPct);
    }
    const buy = trade.mint ? lastBuyByMint.get(trade.mint) : null;
    if (buy?.t && trade.t) {
      holds.push((trade.t - buy.t) / 60000);
      lastBuyByMint.delete(trade.mint);
    }
  }

  const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null;
  const avgPnlPct = closed ? totalPnlPct / closed : null;
  const winRate = closed ? wins / closed : null;

  return { closed, winRate, totalPnlUsd, avgPnlPct, avgHold, best, worst };
}

export function seriesFromTrades(items) {
  const trades = Array.isArray(items) ? items.slice().sort((a, b) => (a.t || 0) - (b.t || 0)) : [];
  const points = [];
  let cumulative = 0;
  for (const trade of trades) {
    const side = String(trade.side || "").toLowerCase();
    if (side !== "sell") continue;
    const pnlUsd = Number(trade.profitUsd);
    if (!Number.isFinite(pnlUsd)) continue;
    cumulative += pnlUsd;
    points.push({ t: trade.t || Date.now(), v: cumulative });
  }
  if (!points.length) {
    points.push({ t: Date.now(), v: 0 });
  }
  return points;
}
