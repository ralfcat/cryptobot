# Backtest Metrics Thresholds

Use these thresholds to decide whether a trained model or strategy backtest is ready to promote.
Tune the values per market regime or token universe.

## Recommended defaults

| Metric | Target | Notes |
| --- | --- | --- |
| PnL % | ≥ 5% | Net profit over the backtest window. |
| Max drawdown % | ≤ 20% | Peak-to-trough equity decline. |
| Win rate % | ≥ 45% | Percentage of winning trades. |
| Trades | ≥ 10 | Minimum sample size to reduce variance. |

## Monitoring report usage

The training monitoring report compares each run to these thresholds and flags any WARN items.
Adjust with CLI flags when running `training/monitor.js`:

```bash
node training/monitor.js \
  --metrics path/to/run.metrics.json \
  --pnl-pct 8 \
  --max-drawdown 15 \
  --win-rate 50 \
  --min-trades 20
```
