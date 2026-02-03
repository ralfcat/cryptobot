import { computeTradeStats, fmtNum, fmtPct, fmtTime, fmtUsd, seriesFromTrades } from "./ui-metrics.js";

const el = (id) => document.getElementById(id);

const statusText = el("status-text");
const lastAction = el("last-action");
const solBalance = el("sol-balance");
const solUsd = el("sol-usd");
const totalUsd = el("total-usd");
const posMint = el("pos-mint");
const posHeld = el("pos-held");
const posPnl = el("pos-pnl");
const posValue = el("pos-value");
const ruleStop = el("rule-stop");
const ruleTp = el("rule-tp");
const ruleSoft = el("rule-soft");
const ruleHard = el("rule-hard");
const cooldown = el("cooldown");
const nextEntry = el("next-entry");
const lastUpdate = el("last-update");
const logsEl = el("logs");
const tradesEl = el("trades");
const sellNowBtn = el("sell-now");
const sellStatus = el("sell-status");
const resetCooldownBtn = el("reset-cooldown");
const resetStatus = el("reset-status");
const modeSharpBtn = el("mode-sharp");
const modeSimulatorBtn = el("mode-simulator");
const modeStatus = el("mode-status");
const statTrades = el("stat-trades");
const statWinrate = el("stat-winrate");
const statTotalPnl = el("stat-totalpnl");
const statAvgPnl = el("stat-avgpnl");
const statAvgHold = el("stat-avg-hold");
const statBestWorst = el("stat-bestworst");
const pnlChart = el("pnl-chart");

let latestPayload = null;
let sellBusy = false;
let resetBusy = false;
let modeBusy = false;

function prettyMode(mode) {
  if (!mode) return "-";
  return mode === "simulator" ? "Simulator mode" : "Sharp-mode";
}

function updateModeControls(mode, { pending = false } = {}) {
  if (modeSharpBtn) {
    modeSharpBtn.classList.toggle("active", mode === "sharp");
    modeSharpBtn.disabled = modeBusy;
  }
  if (modeSimulatorBtn) {
    modeSimulatorBtn.classList.toggle("active", mode === "simulator");
    modeSimulatorBtn.disabled = modeBusy;
  }
  if (modeStatus) {
    if (pending) {
      modeStatus.textContent = `Updating: ${prettyMode(mode)}`;
    } else {
      modeStatus.textContent = `Active: ${prettyMode(mode)}`;
    }
  }
}

function renderLogs(items) {
  logsEl.innerHTML = "";
  if (!items || !items.length) {
    logsEl.innerHTML = "<div class=\"log-item\">No logs yet.</div>";
    return;
  }
  items
    .slice()
    .reverse()
    .forEach((item) => {
      const div = document.createElement("div");
      div.className = "log-item";
      div.textContent = `[${fmtTime(item.t)}] ${item.level.toUpperCase()}: ${item.msg}`;
      logsEl.appendChild(div);
    });
}

function renderTrades(items) {
  tradesEl.innerHTML = "";
  if (!items || !items.length) {
    tradesEl.innerHTML = "<div class=\"trade-item\">No trades yet.</div>";
    return;
  }
  items
    .slice()
    .reverse()
    .forEach((item) => {
      const div = document.createElement("div");
      div.className = "trade-item";
      const side = item.side.toUpperCase();
      const line = `${side} ${item.mint.slice(0, 6)}... at ${fmtTime(item.t)} | est pnl ${fmtNum(item.pnlPct, 2)}% | ${fmtUsd(item.profitUsd)}`;
      div.textContent = line;
      tradesEl.appendChild(div);
    });
}

function drawPnlChart(canvas, points) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const padding = 22;
  const width = rect.width;
  const height = rect.height;

  ctx.clearRect(0, 0, width, height);

  const values = points.map((p) => p.v);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const xStep = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;
  const yScale = (height - padding * 2) / (max - min);

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i += 1) {
    const y = padding + ((height - padding * 2) / 3) * i;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
  }

  const gradient = ctx.createLinearGradient(0, padding, 0, height - padding);
  gradient.addColorStop(0, "rgba(6, 214, 160, 0.35)");
  gradient.addColorStop(1, "rgba(239, 71, 111, 0.15)");

  ctx.beginPath();
  points.forEach((p, idx) => {
    const x = padding + xStep * idx;
    const y = height - padding - (p.v - min) * yScale;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(238,242,247,0.9)";
  ctx.stroke();

  ctx.lineTo(width - padding, height - padding);
  ctx.lineTo(padding, height - padding);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = "12px 'JetBrains Mono', ui-monospace";
  ctx.fillText(fmtUsd(max), padding, padding - 6);
  ctx.fillText(fmtUsd(min), padding, height - padding + 16);
}

let chartPoints = [];
function renderPerformance(items) {
  const stats = computeTradeStats(items);
  if (statTrades) statTrades.textContent = stats.closed ? String(stats.closed) : "-";
  if (statWinrate) statWinrate.textContent = stats.winRate === null ? "-" : fmtPct(stats.winRate * 100, 1);
  if (statTotalPnl) statTotalPnl.textContent = fmtUsd(stats.totalPnlUsd);
  if (statAvgPnl) statAvgPnl.textContent = stats.avgPnlPct === null ? "-" : fmtPct(stats.avgPnlPct, 2);
  if (statAvgHold) statAvgHold.textContent = stats.avgHold === null ? "-" : `${fmtNum(stats.avgHold, 1)} min`;
  if (statBestWorst) {
    const best = stats.best === null ? "-" : fmtPct(stats.best, 2);
    const worst = stats.worst === null ? "-" : fmtPct(stats.worst, 2);
    statBestWorst.textContent = `${best} / ${worst}`;
  }

  chartPoints = seriesFromTrades(items);
  drawPnlChart(pnlChart, chartPoints);
}

function update(payload) {
  if (!payload) return;
  latestPayload = payload;
  statusText.textContent = payload.status || "Unknown";
  lastAction.textContent = payload.lastAction || "-";

  const balances = payload.balances || {};
  solBalance.textContent = fmtNum(balances.sol, 4);
  solUsd.textContent = fmtUsd(balances.solUsd);
  totalUsd.textContent = fmtUsd(balances.totalUsd);

  const pos = payload.position;
  if (pos) {
    posMint.textContent = pos.mint;
    posHeld.textContent = `${fmtNum(pos.heldMinutes, 1)} min`;
    posPnl.textContent = `${fmtNum(pos.pnlPct, 2)}%`;
    posValue.textContent = fmtUsd(pos.estUsd);
  } else {
    posMint.textContent = "-";
    posHeld.textContent = "-";
    posPnl.textContent = "-";
    posValue.textContent = "-";
  }

  const rules = payload.rules || {};
  ruleStop.textContent = rules.stopLossPct ? `${fmtNum(rules.stopLossPct * 100, 0)}%` : "-";
  ruleTp.textContent = rules.takeProfitPct ? `${fmtNum(rules.takeProfitPct, 0)}%` : "-";
  ruleSoft.textContent = rules.exitSoftMinutes ? `${fmtNum(rules.exitSoftMinutes, 0)} min` : "-";
  ruleHard.textContent = rules.exitHardMinutes ? `${fmtNum(rules.exitHardMinutes, 0)} min` : "-";

  const cd = payload.cooldown || {};
  cooldown.textContent = cd.minutes ? `${fmtNum(cd.minutes, 0)} min` : "-";
  nextEntry.textContent = cd.nextEntryMs ? fmtTime(cd.nextEntryMs) : "-";
  lastUpdate.textContent = payload.updatedAt ? fmtTime(payload.updatedAt) : "-";

  renderLogs(payload.logs || []);
  renderTrades(payload.trades || []);
  renderPerformance(payload.trades || []);
  updateModeControls(payload.mode);

  if (sellNowBtn) {
    const hasPosition = Boolean(payload.position);
    sellNowBtn.disabled = !hasPosition || sellBusy;
    if (sellStatus && !sellBusy) {
      sellStatus.textContent = hasPosition ? "Ready to sell current position." : "Waiting for position.";
    }
  }

  if (resetCooldownBtn) {
    const hasPosition = Boolean(payload.position);
    const remaining = Number(cd.remainingSec || 0);
    resetCooldownBtn.disabled = resetBusy || hasPosition;
    if (resetStatus && !resetBusy) {
      if (hasPosition) {
        resetStatus.textContent = "Cooldown resets are available after exit.";
      } else if (remaining > 0) {
        resetStatus.textContent = `Cooldown active: ${remaining}s remaining.`;
      } else {
        resetStatus.textContent = "No cooldown active.";
      }
    }
  }
}

async function requestMode(nextMode) {
  if (modeBusy || !nextMode) return;
  const currentMode = latestPayload?.mode || "sharp";
  if (nextMode === currentMode) return;
  modeBusy = true;
  updateModeControls(nextMode, { pending: true });
  try {
    const res = await fetch("/api/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: nextMode }),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok || data.ok === false) {
      const msg = data?.error || `HTTP ${res.status}`;
      if (modeStatus) modeStatus.textContent = `Failed: ${msg}`;
      updateModeControls(currentMode);
      return;
    }
    const confirmedMode = data.mode || nextMode;
    if (latestPayload) {
      latestPayload.mode = confirmedMode;
    }
    updateModeControls(confirmedMode);
  } catch (err) {
    if (modeStatus) modeStatus.textContent = `Failed: ${err?.message || err}`;
    updateModeControls(currentMode);
  } finally {
    modeBusy = false;
    updateModeControls(latestPayload?.mode || nextMode);
  }
}

if (modeSharpBtn) {
  modeSharpBtn.addEventListener("click", () => requestMode("sharp"));
}

if (modeSimulatorBtn) {
  modeSimulatorBtn.addEventListener("click", () => requestMode("simulator"));
}

async function requestSellNow() {
  if (sellBusy) return;
  const hasPosition = Boolean(latestPayload?.position);
  if (!hasPosition) {
    if (sellStatus) sellStatus.textContent = "No open position to sell.";
    return;
  }
  if (!confirm("Sell the current position now?")) return;
  sellBusy = true;
  if (sellNowBtn) sellNowBtn.disabled = true;
  if (sellStatus) sellStatus.textContent = "Sending sell request...";
  try {
    const res = await fetch("/api/sell-now", { method: "POST" });
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok || data.ok === false) {
      const msg = data?.error || `HTTP ${res.status}`;
      if (sellStatus) sellStatus.textContent = `Failed: ${msg}`;
    } else if (sellStatus) {
      sellStatus.textContent = "Sell requested. Waiting for confirmation.";
    }
  } catch (err) {
    if (sellStatus) sellStatus.textContent = `Failed: ${err?.message || err}`;
  } finally {
    sellBusy = false;
    if (sellNowBtn) sellNowBtn.disabled = !latestPayload?.position;
  }
}

if (sellNowBtn) {
  sellNowBtn.addEventListener("click", requestSellNow);
}

async function requestResetCooldown() {
  if (resetBusy) return;
  const hasPosition = Boolean(latestPayload?.position);
  const remaining = Number(latestPayload?.cooldown?.remainingSec || 0);
  if (hasPosition) {
    if (resetStatus) resetStatus.textContent = "Cannot reset cooldown while holding a position.";
    return;
  }
  if (remaining <= 0) {
    if (resetStatus) resetStatus.textContent = "No cooldown active.";
    return;
  }
  if (!confirm("Reset cooldown and allow a new entry immediately?")) return;
  resetBusy = true;
  if (resetCooldownBtn) resetCooldownBtn.disabled = true;
  if (resetStatus) resetStatus.textContent = "Resetting cooldown...";
  try {
    const res = await fetch("/api/reset-cooldown", { method: "POST" });
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok || data.ok === false) {
      const msg = data?.error || `HTTP ${res.status}`;
      if (resetStatus) resetStatus.textContent = `Failed: ${msg}`;
    } else if (resetStatus) {
      resetStatus.textContent = data.reset ? "Cooldown reset." : "No cooldown active.";
    }
  } catch (err) {
    if (resetStatus) resetStatus.textContent = `Failed: ${err?.message || err}`;
  } finally {
    resetBusy = false;
    if (resetCooldownBtn) resetCooldownBtn.disabled = Boolean(latestPayload?.position);
  }
}

if (resetCooldownBtn) {
  resetCooldownBtn.addEventListener("click", requestResetCooldown);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    update(payload);
  };

  ws.onclose = () => {
    setTimeout(connect, 1500);
  };
}

connect();

if (pnlChart) {
  const resizeObserver = new ResizeObserver(() => {
    if (chartPoints.length) drawPnlChart(pnlChart, chartPoints);
  });
  resizeObserver.observe(pnlChart);
}
