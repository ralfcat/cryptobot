import client from "prom-client";

const register = new client.Registry();
let initialized = false;

const metrics = {
  trades: new client.Counter({
    name: "cryptobot_trades_total",
    help: "Total trades by side.",
    labelNames: ["side"],
    registers: [register],
  }),
  errors: new client.Counter({
    name: "cryptobot_errors_total",
    help: "Total errors by type.",
    labelNames: ["type"],
    registers: [register],
  }),
  openPositions: new client.Gauge({
    name: "cryptobot_open_positions",
    help: "Number of open positions.",
    registers: [register],
  }),
  balanceSol: new client.Gauge({
    name: "cryptobot_balance_sol",
    help: "Current SOL balance.",
    registers: [register],
  }),
  balanceUsd: new client.Gauge({
    name: "cryptobot_balance_usd",
    help: "Current USD balance estimate.",
    registers: [register],
  }),
  totalUsd: new client.Gauge({
    name: "cryptobot_total_usd",
    help: "Total portfolio USD estimate.",
    registers: [register],
  }),
};

export function initMetrics() {
  if (initialized) return;
  client.collectDefaultMetrics({ register });
  initialized = true;
}

export function recordTrade(side) {
  if (!side) return;
  metrics.trades.labels(String(side)).inc();
}

export function recordError(type) {
  metrics.errors.labels(String(type || "unknown")).inc();
}

export function setOpenPositions(count) {
  metrics.openPositions.set(Number(count) || 0);
}

export function setBalances({ sol, solUsd, totalUsd }) {
  if (Number.isFinite(sol)) metrics.balanceSol.set(sol);
  if (Number.isFinite(solUsd)) metrics.balanceUsd.set(solUsd);
  if (Number.isFinite(totalUsd)) metrics.totalUsd.set(totalUsd);
}

export function getMetricsRegister() {
  return register;
}
