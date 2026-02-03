import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import config from "../src/config.js";
import {
  computeMomentum,
  computeSignal,
  computeVolatility,
  normalizeCandles,
} from "../src/strategy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function computeModelSignal(features, model) {
  if (!model?.weights) {
    return { ok: false, score: null, reason: "missing_model_weights" };
  }
  let score = 0;
  let used = 0;
  for (const [name, weight] of Object.entries(model.weights)) {
    const val = safeNumber(features?.[name], null);
    const w = safeNumber(weight, null);
    if (val === null || w === null) continue;
    score += val * w;
    used += 1;
  }
  if (used === 0) {
    return { ok: false, score: null, reason: "no_feature_overlap" };
  }
  const threshold = safeNumber(model.threshold, 0) ?? 0;
  return { ok: score >= threshold, score, threshold };
}

function selectSignal(mode, candles, features, model) {
  if (mode === "model") {
    return computeModelSignal(features, model);
  }
  if (mode === "momentum") {
    return computeMomentum(candles);
  }
  if (mode === "volatility") {
    return computeVolatility(candles, config.flashWindowMinutes);
  }
  if (mode === "strategy") {
    return computeSignal(candles);
  }
  if (config.momentumMode) {
    return computeMomentum(candles);
  }
  return computeSignal(candles);
}

function resolveSnapshots(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.snapshots)) return data.snapshots;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function toPercentage(value) {
  return Number.isFinite(value) ? value * 100 : 0;
}

function runBacktest(snapshots, options) {
  const {
    mode,
    model,
    maxHoldBars = 60,
    initialCash = 1,
    tradeCooldownBars = 0,
  } = options;
  let cash = initialCash;
  let position = null;
  let equity = initialCash;
  let peak = initialCash;
  let maxDrawdown = 0;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let totalWinPct = 0;
  let totalLossPct = 0;
  let cooldown = 0;
  const equityCurve = [];

  snapshots.forEach((snapshot, index) => {
    const candles = normalizeCandles(snapshot.ohlcv || snapshot.candles || snapshot.data);
    if (!candles.length) {
      equityCurve.push(equity);
      return;
    }
    const last = candles[candles.length - 1];
    const price = safeNumber(last.c, null);
    if (price === null || price <= 0) {
      equityCurve.push(equity);
      return;
    }

    if (position) {
      equity = position.size * price;
    } else {
      equity = cash;
    }

    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? (peak - equity) / peak : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    const signal = selectSignal(mode, candles, snapshot.features || snapshot.feature, model);
    const shouldExit =
      position &&
      (!signal.ok || (maxHoldBars && index - position.entryIndex >= maxHoldBars));
    if (position && shouldExit) {
      cash = position.size * price;
      const pnlPct = (price - position.entryPrice) / position.entryPrice;
      trades += 1;
      if (pnlPct > 0) {
        wins += 1;
        totalWinPct += pnlPct;
      } else {
        losses += 1;
        totalLossPct += pnlPct;
      }
      position = null;
      cooldown = tradeCooldownBars;
    }

    if (!position && cooldown === 0 && signal.ok) {
      position = {
        entryIndex: index,
        entryPrice: price,
        size: cash / price,
      };
      cash = 0;
    }

    if (cooldown > 0) cooldown -= 1;
    equityCurve.push(equity);
  });

  if (position) {
    const lastPrice = snapshots.length
      ? safeNumber(
          normalizeCandles(
            snapshots[snapshots.length - 1].ohlcv ||
              snapshots[snapshots.length - 1].candles ||
              snapshots[snapshots.length - 1].data,
          ).slice(-1)[0]?.c,
          position.entryPrice,
        )
      : position.entryPrice;
    cash = position.size * lastPrice;
    const pnlPct = (lastPrice - position.entryPrice) / position.entryPrice;
    trades += 1;
    if (pnlPct > 0) {
      wins += 1;
      totalWinPct += pnlPct;
    } else {
      losses += 1;
      totalLossPct += pnlPct;
    }
    position = null;
    equity = cash;
  }

  const pnl = cash - initialCash;
  const pnlPct = initialCash > 0 ? (pnl / initialCash) * 100 : 0;
  const winRate = trades > 0 ? wins / trades : 0;
  const avgWinPct = wins > 0 ? (totalWinPct / wins) * 100 : 0;
  const avgLossPct = losses > 0 ? (totalLossPct / losses) * 100 : 0;

  return {
    summary: {
      pnl,
      pnlPct,
      maxDrawdownPct: toPercentage(maxDrawdown),
      winRate: winRate * 100,
      trades,
      wins,
      losses,
      avgWinPct,
      avgLossPct,
      startCash: initialCash,
      endCash: cash,
    },
    equityCurve,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataPath = args.data || args.d;
  if (!dataPath) {
    console.error("Usage: node training/backtest.js --data snapshots.json [--metadata model.json]");
    process.exit(1);
  }

  const resolvedDataPath = path.resolve(process.cwd(), dataPath);
  const data = readJson(resolvedDataPath);
  const snapshots = resolveSnapshots(data);
  if (!snapshots.length) {
    console.error("No snapshots found in", resolvedDataPath);
    process.exit(1);
  }

  const metadataPath = args.metadata ? path.resolve(process.cwd(), args.metadata) : null;
  const metadata = metadataPath ? readJson(metadataPath) : null;
  const mode = args.mode || (metadata?.model ? "model" : "strategy");
  const maxHoldBars = safeNumber(args["max-hold"], 60) ?? 60;
  const initialCash = safeNumber(args["initial-cash"], 1) ?? 1;
  const tradeCooldownBars = safeNumber(args["trade-cooldown"], 0) ?? 0;

  const result = runBacktest(snapshots, {
    mode,
    model: metadata?.model,
    maxHoldBars,
    initialCash,
    tradeCooldownBars,
  });

  const outputDir = metadataPath
    ? path.dirname(metadataPath)
    : args.output
      ? path.resolve(process.cwd(), args.output)
      : __dirname;
  const baseName = metadataPath
    ? path.basename(metadataPath, path.extname(metadataPath))
    : path.basename(resolvedDataPath, path.extname(resolvedDataPath));
  const metricsPath = path.join(outputDir, `${baseName}.metrics.json`);
  fs.writeFileSync(metricsPath, JSON.stringify(result, null, 2));

  const summary = result.summary;
  console.log("Backtest complete:");
  console.log(`  Trades: ${summary.trades}`);
  console.log(`  Win rate: ${summary.winRate.toFixed(2)}%`);
  console.log(`  PnL: ${summary.pnl.toFixed(4)} (${summary.pnlPct.toFixed(2)}%)`);
  console.log(`  Max drawdown: ${summary.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  Metrics saved to ${metricsPath}`);
}

main();
