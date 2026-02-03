import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function statusLabel(pass) {
  return pass ? "PASS" : "WARN";
}

function buildReport(metrics, thresholds, metadata) {
  const summary = metrics.summary || {};
  const checks = [
    {
      label: "PnL %",
      value: summary.pnlPct,
      threshold: thresholds.pnlPct,
      pass: safeNumber(summary.pnlPct, 0) >= thresholds.pnlPct,
    },
    {
      label: "Max drawdown %",
      value: summary.maxDrawdownPct,
      threshold: thresholds.maxDrawdownPct,
      pass: safeNumber(summary.maxDrawdownPct, 0) <= thresholds.maxDrawdownPct,
    },
    {
      label: "Win rate %",
      value: summary.winRate,
      threshold: thresholds.winRate,
      pass: safeNumber(summary.winRate, 0) >= thresholds.winRate,
    },
    {
      label: "Trades",
      value: summary.trades,
      threshold: thresholds.minTrades,
      pass: safeNumber(summary.trades, 0) >= thresholds.minTrades,
    },
  ];

  const lines = [];
  lines.push("# Training Monitoring Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  if (metadata?.runId || metadata?.model?.name) {
    lines.push(
      `Model: ${metadata?.model?.name || "unknown"} ${metadata?.runId ? `(run ${metadata.runId})` : ""}`,
    );
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- PnL: ${safeNumber(summary.pnl, 0).toFixed(4)} (${safeNumber(summary.pnlPct, 0).toFixed(2)}%)`);
  lines.push(`- Max drawdown: ${safeNumber(summary.maxDrawdownPct, 0).toFixed(2)}%`);
  lines.push(`- Win rate: ${safeNumber(summary.winRate, 0).toFixed(2)}%`);
  lines.push(`- Trades: ${safeNumber(summary.trades, 0)}`);
  lines.push("");
  lines.push("## Threshold Checks");
  lines.push("");
  lines.push("| Metric | Value | Threshold | Status |");
  lines.push("| --- | --- | --- | --- |");
  checks.forEach((check) => {
    lines.push(
      `| ${check.label} | ${safeNumber(check.value, 0).toFixed(2)} | ${check.threshold} | ${statusLabel(check.pass)} |`,
    );
  });
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- Review WARN items before promoting the model.");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const metricsPath = args.metrics || args.m;
  if (!metricsPath) {
    console.error("Usage: node training/monitor.js --metrics run.metrics.json [--metadata model.json]");
    process.exit(1);
  }

  const resolvedMetricsPath = path.resolve(process.cwd(), metricsPath);
  const metrics = readJson(resolvedMetricsPath);
  const metadata = args.metadata ? readJson(path.resolve(process.cwd(), args.metadata)) : null;

  const thresholds = {
    pnlPct: safeNumber(args["pnl-pct"], metadata?.metricsThresholds?.pnlPct ?? 5) ?? 5,
    maxDrawdownPct:
      safeNumber(args["max-drawdown"], metadata?.metricsThresholds?.maxDrawdownPct ?? 20) ?? 20,
    winRate: safeNumber(args["win-rate"], metadata?.metricsThresholds?.winRate ?? 45) ?? 45,
    minTrades: safeNumber(args["min-trades"], metadata?.metricsThresholds?.minTrades ?? 10) ?? 10,
  };

  const report = buildReport(metrics, thresholds, metadata);
  const outputDir = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.dirname(resolvedMetricsPath);
  const baseName = path.basename(resolvedMetricsPath, path.extname(resolvedMetricsPath));
  const reportPath = path.join(outputDir, `${baseName}.report.md`);
  fs.writeFileSync(reportPath, report);
  console.log(`Monitoring report saved to ${reportPath}`);
}

main();
