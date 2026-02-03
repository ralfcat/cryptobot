# Training Orchestration

This project includes a lightweight orchestration layer to manage the ETL → training → evaluation → promotion loop. The orchestration script is intentionally minimal so you can swap in real ETL/training logic later.

## Quick start

Run a single pipeline run:

```bash
npm run orchestrate -- --once
```

Schedule recurring runs in-process with a fixed interval (default: every 6 hours):

```bash
ORCHESTRATION_INTERVAL_MINUTES=360 npm run orchestrate
```

## Pipeline stages

1. **ETL**
   - Writes a placeholder artifact to `data/etl/etl-<runId>.json` so downstream steps have a source path.
   - Replace `runETL` in `src/orchestrator.js` with your real data ingestion logic.

2. **Training**
   - Creates `models/model-<runId>/metadata.json` with the run context.
   - Replace `runTraining` with model fitting and artifact serialization.

3. **Evaluation**
   - Loads metrics from `EVAL_METRICS_PATH` (JSON) or from the `EVAL_*` environment variables.
   - Updates the model metadata with `metrics` and `evaluatedAt`.

4. **Promotion**
   - Checks evaluation metrics against thresholds.
   - If eligible, writes the "current model pointer" to `models/latest.json`.

## Promotion gates

Promotion is gated on the following metrics stored in `metadata.json`:

| Metric | Environment variable | Default |
| --- | --- | --- |
| Minimum win rate | `MIN_WIN_RATE` | `0.55` |
| Maximum drawdown | `MAX_DRAWDOWN` | `0.2` |
| Minimum PnL per trade | `MIN_PNL_PER_TRADE` | `0` |

If `metrics.winRate >= MIN_WIN_RATE`, `metrics.maxDrawdown <= MAX_DRAWDOWN`, and `metrics.pnlPerTrade >= MIN_PNL_PER_TRADE`, the model is promoted.

## Model metadata

Each model directory contains `metadata.json` with fields like:

```json
{
  "modelId": "model-2024-01-01T00-00-00-000Z",
  "status": "promoted",
  "metrics": {
    "winRate": 0.6,
    "maxDrawdown": 0.15,
    "pnlPerTrade": 0.03
  },
  "promoted": true
}
```

The live bot should read `models/latest.json` to find the current model.

## Supplying evaluation metrics

Provide metrics via file:

```bash
cat <<'JSON' > /tmp/metrics.json
{
  "winRate": 0.62,
  "maxDrawdown": 0.12,
  "pnlPerTrade": 0.04
}
JSON

EVAL_METRICS_PATH=/tmp/metrics.json npm run orchestrate -- --once
```

Or via environment variables:

```bash
EVAL_WIN_RATE=0.62 EVAL_MAX_DRAWDOWN=0.12 EVAL_PNL_PER_TRADE=0.04 npm run orchestrate -- --once
```
If you prefer system cron, call the one-shot mode from your crontab:

```bash
*/30 * * * * cd /path/to/cryptobot && npm run orchestrate -- --once
```
