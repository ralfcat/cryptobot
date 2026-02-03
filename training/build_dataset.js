#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_WINDOWS_MIN = [5, 15, 60];
const DEFAULT_PNL_WINDOW_HOURS = 24;

function parseArgs(argv) {
  const args = {
    events: path.join(__dirname, "..", "training_events.jsonl"),
    trades: path.join(__dirname, "..", "trades.jsonl"),
    out: path.join(__dirname, "..", "data", "datasets"),
    date: new Date().toISOString().slice(0, 10),
    windows: DEFAULT_WINDOWS_MIN,
    pnlWindowHours: DEFAULT_PNL_WINDOW_HOURS,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    switch (key) {
      case "--events":
        args.events = value;
        i += 1;
        break;
      case "--trades":
        args.trades = value;
        i += 1;
        break;
      case "--out":
        args.out = value;
        i += 1;
        break;
      case "--date":
        args.date = value;
        i += 1;
        break;
      case "--windows":
        args.windows = value.split(",").map((w) => Number(w.trim())).filter(Boolean);
        i += 1;
        break;
      case "--pnl-window-hours":
        args.pnlWindowHours = Number(value);
        i += 1;
        break;
      default:
        break;
    }
  }
  return args;
}

function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Invalid JSONL in ${filePath}: ${err.message}`);
      }
    });
}

function toMs(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function extractCandles(event) {
  if (Array.isArray(event?.ohlcv)) return event.ohlcv;
  if (Array.isArray(event?.candles)) return event.candles;
  const ohlcv = event?.ohlcv || event?.ohlc || null;
  if (ohlcv && typeof ohlcv === "object") {
    const candidates = Object.values(ohlcv).find((value) => Array.isArray(value));
    if (candidates) return candidates;
  }
  return [];
}

function normalizeCandle(candle) {
  return {
    t: toMs(candle?.t ?? candle?.time ?? candle?.timestamp ?? candle?.ts),
    o: Number(candle?.o ?? candle?.open),
    h: Number(candle?.h ?? candle?.high),
    l: Number(candle?.l ?? candle?.low),
    c: Number(candle?.c ?? candle?.close),
    v: Number(candle?.v ?? candle?.volume),
  };
}

function getEntryPrice(event, candles, eventTime) {
  const direct = event?.entryPrice ?? event?.price ?? event?.features?.price ?? event?.features?.entryPrice;
  if (direct !== undefined && direct !== null && !Number.isNaN(Number(direct))) {
    return Number(direct);
  }
  if (!candles.length) return null;
  const prior = candles
    .filter((c) => c.t !== null && c.t <= eventTime)
    .sort((a, b) => a.t - b.t)
    .pop();
  return prior?.c ?? null;
}

function forwardReturn(candles, eventTime, entryPrice, windowMinutes) {
  if (!candles.length || entryPrice === null || entryPrice === 0) return null;
  const targetTime = eventTime + windowMinutes * 60 * 1000;
  const future = candles
    .filter((c) => c.t !== null && c.t >= targetTime)
    .sort((a, b) => a.t - b.t)[0];
  if (!future) return null;
  return (future.c - entryPrice) / entryPrice;
}

function buildTradeIndex(trades) {
  const bySig = new Map();
  const byMint = new Map();
  for (const trade of trades) {
    const sig = trade?.sig || trade?.signature || trade?.tradeSig;
    if (sig) bySig.set(sig, trade);
    const mint = trade?.mint || trade?.tokenMint || trade?.token;
    if (!mint) continue;
    if (!byMint.has(mint)) byMint.set(mint, []);
    byMint.get(mint).push(trade);
  }
  for (const list of byMint.values()) {
    list.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  }
  return { bySig, byMint };
}

function matchTrade(event, tradeIndex, pnlWindowHours) {
  const sig = event?.tradeSig || event?.sig || event?.signature;
  if (sig && tradeIndex.bySig.has(sig)) return tradeIndex.bySig.get(sig);
  const mint = event?.mint || event?.tokenMint || event?.token;
  if (!mint) return null;
  const list = tradeIndex.byMint.get(mint) || [];
  const eventTime = toMs(event?.t ?? event?.timestamp ?? event?.time ?? event?.ts);
  if (!eventTime) return null;
  const cutoff = eventTime + pnlWindowHours * 60 * 60 * 1000;
  return list.find((trade) => trade?.t >= eventTime && trade?.t <= cutoff) || null;
}

async function writeParquet(rows, outputPath) {
  if (!rows.length) {
    throw new Error("No rows to write.");
  }
  try {
    const parquet = await import("parquetjs-lite");
    const schema = new parquet.ParquetSchema({
      event_id: { type: "UTF8", optional: true },
      event_time_ms: { type: "INT64" },
      mint: { type: "UTF8" },
      entry_price: { type: "DOUBLE", optional: true },
      label_source: { type: "UTF8" },
      label_realized_pnl_pct: { type: "DOUBLE", optional: true },
      label_realized_profit_usd: { type: "DOUBLE", optional: true },
      label_return_5m: { type: "DOUBLE", optional: true },
      label_return_15m: { type: "DOUBLE", optional: true },
      label_return_60m: { type: "DOUBLE", optional: true },
      features_json: { type: "UTF8" },
      metadata_json: { type: "UTF8" },
    });

    const writer = await parquet.ParquetWriter.openFile(schema, outputPath);
    for (const row of rows) {
      await writer.appendRow(row);
    }
    await writer.close();
    return { path: outputPath, format: "parquet" };
  } catch (err) {
    const fallbackPath = outputPath.replace(/\\.parquet$/, \".jsonl\");
    const payload = rows.map((row) => `${JSON.stringify(row)}\\n`).join(\"\");
    fs.writeFileSync(fallbackPath, payload);
    console.warn(
      `Failed to write Parquet (missing parquetjs-lite). Wrote JSONL to ${fallbackPath}.`
    );
    return { path: fallbackPath, format: "jsonl" };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const events = parseJsonl(args.events);
  const trades = parseJsonl(args.trades);
  const tradeIndex = buildTradeIndex(trades);

  const rows = [];

  for (const event of events) {
    const eventTime = toMs(event?.t ?? event?.timestamp ?? event?.time ?? event?.ts);
    const mint = event?.mint || event?.tokenMint || event?.token;
    if (!eventTime || !mint) continue;

    const candles = extractCandles(event).map(normalizeCandle).filter((c) => c.t !== null);
    const entryPrice = getEntryPrice(event, candles, eventTime);
    const trade = matchTrade(event, tradeIndex, args.pnlWindowHours);

    const forwardReturns = {};
    for (const windowMin of args.windows) {
      forwardReturns[windowMin] = forwardReturn(candles, eventTime, entryPrice, windowMin);
    }

    const labelSource = trade
      ? "realized_pnl"
      : Object.values(forwardReturns).some((value) => value !== null)
        ? "forward_return"
        : "unknown";

    rows.push({
      event_id: event?.id ?? event?.eventId ?? null,
      event_time_ms: eventTime,
      mint,
      entry_price: entryPrice,
      label_source: labelSource,
      label_realized_pnl_pct: trade?.pnlPct ?? null,
      label_realized_profit_usd: trade?.profitUsd ?? null,
      label_return_5m: forwardReturns[5] ?? null,
      label_return_15m: forwardReturns[15] ?? null,
      label_return_60m: forwardReturns[60] ?? null,
      features_json: JSON.stringify(event?.features ?? {}),
      metadata_json: JSON.stringify({
        raw_event_keys: Object.keys(event || {}),
        trade_sig: trade?.sig ?? null,
      }),
    });
  }

  const outputDir = path.join(args.out, args.date);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "train.parquet");
  const dataset = await writeParquet(rows, outputPath);

  const metadata = {
    generated_at: new Date().toISOString(),
    events_path: args.events,
    trades_path: args.trades,
    rows: rows.length,
    windows_minutes: args.windows,
    pnl_window_hours: args.pnlWindowHours,
  };
  fs.writeFileSync(path.join(outputDir, "metadata.json"), JSON.stringify(metadata, null, 2));

  console.log(`Wrote ${rows.length} rows to ${dataset.path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
