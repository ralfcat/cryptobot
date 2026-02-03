import assert from "node:assert/strict";
import { test } from "node:test";
import { computeTradeStats, fmtNum, fmtPct, fmtTime, fmtUsd, seriesFromTrades } from "../../public/ui-metrics.js";

test("fmt helpers handle empty values", () => {
  assert.equal(fmtUsd(null), "-");
  assert.equal(fmtNum(undefined), "-");
  assert.equal(fmtPct(Number.NaN), "-");
  assert.equal(fmtTime(0), "-");
});

test("fmt helpers render expected formats", () => {
  assert.equal(fmtUsd(12.3456), "$12.35");
  assert.equal(fmtNum(12.3456, 2), "12.35");
  assert.equal(fmtPct(1.2345, 1), "1.2%");
  assert.ok(fmtTime(Date.now()).length > 0);
});

test("computeTradeStats aggregates wins and holds", () => {
  const now = Date.now();
  const trades = [
    { side: "buy", mint: "AAA", t: now - 60000 },
    { side: "sell", mint: "AAA", t: now, profitUsd: 1.5, pnlPct: 5 },
    { side: "sell", mint: "BBB", t: now + 1000, profitUsd: -0.5, pnlPct: -2 },
  ];

  const stats = computeTradeStats(trades);
  assert.equal(stats.closed, 2);
  assert.equal(stats.winRate, 0.5);
  assert.equal(stats.totalPnlUsd, 1.0);
  assert.equal(stats.avgPnlPct, 1.5);
  assert.equal(stats.best, 5);
  assert.equal(stats.worst, -2);
  assert.ok(stats.avgHold !== null);
});

test("seriesFromTrades builds a cumulative series", () => {
  const now = Date.now();
  const trades = [
    { side: "sell", t: now - 1000, profitUsd: 1.0 },
    { side: "sell", t: now, profitUsd: -0.5 },
  ];

  const points = seriesFromTrades(trades);
  assert.equal(points.length, 2);
  assert.equal(points[0].v, 1.0);
  assert.equal(points[1].v, 0.5);
});

test("seriesFromTrades returns a default point on empty input", () => {
  const points = seriesFromTrades([]);
  assert.equal(points.length, 1);
  assert.equal(points[0].v, 0);
});
