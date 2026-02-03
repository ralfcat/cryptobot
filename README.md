# Crypto Meme Auto Trader (Solana)

**High risk.** This bot can lose the entire balance. Use a small, separate wallet.

## Why a hot wallet (not Phantom)
For fully automatic trades the bot must be able to sign and send transactions without manual approval. Phantom normally requires confirmations, and its auto-confirm feature is limited to approved apps and still requires a manual connection. A **hot wallet** (a separate keypair used only by the bot) is the standard approach for unattended trading.

If you want to reuse your Phantom wallet, you'd need to export the private key/seed and load it into this bot. That is **not recommended**. Create a fresh wallet and send only the funds you are willing to lose.

## Requirements
- Node.js 18+
- Solana RPC URL (Helius, QuickNode, or public RPC)
- Birdeye API key
- Jupiter API key (required for `api.jup.ag`)

## Setup

```bash
cd Crypto_meme_auto_trader
npm install
```

Create `.env` from `.env.example` and fill in the required fields:

```
RPC_URL=...
BIRDEYE_API_KEY=...
JUP_API_KEY=...
KEYPAIR_PATH=path/to/your/keypair.json
```

## Run

```bash
npm start
```

Open the dashboard at `http://localhost:8787` (or whatever `PORT` you set).

## Observability
- **Metrics**: When `METRICS_ENABLED=1`, Prometheus metrics are exposed at `METRICS_PATH` (default `/metrics`). Protect `/api/stats` with `STATS_API_KEY` if you enable the Discord bot.
- **Discord bot**: Run `npm run discord:bot` after setting `DISCORD_BOT_TOKEN` and `DISCORD_STATS_URL` (defaults to `http://localhost:8787/api/stats`).

## Training dataset builder

Build reproducible ML datasets from `training_events.jsonl` and `trades.jsonl` (written by the bot). The builder merges features with labels derived from realized PnL or forward-return windows using stored OHLCV snapshots, and writes a versioned Parquet dataset.

```bash
node training/build_dataset.js --events training_events.jsonl --trades trades.jsonl --date 2024-01-15
```

Output files are written to `data/datasets/{date}/train.parquet` with a `metadata.json` summary. You can override defaults with:

```bash
node training/build_dataset.js --windows 5,15,60 --pnl-window-hours 24 --out data/datasets
```

To enable Parquet output, install `parquetjs-lite` (network restrictions may require vendoring it). If the dependency is unavailable, the builder falls back to `train.jsonl` and reports the failure.

## Core rules implemented
- **All-in trade** using available SOL minus a small fee buffer.
- **Stop loss** at -20%.
- **Take profit** exit when estimated profit crosses `TAKE_PROFIT_PCT` or `TAKE_PROFIT_USD`.
- **Soft time stop** at 15 minutes (extend if trend remains strong and profit >= `MIN_PROFIT_TO_EXTEND_PCT`).
- **Hard time stop** at 60 minutes.
- **Account stop**: exit if account value (SOL + position) drops below $10.
- **Filters**: liquidity/volume minimums, top-10 holder concentration, mint/freeze authority revoked, price impact cap.
- **Volatility-first**: requires short-window % range to exceed `MIN_VOLATILITY_PCT` and prioritizes higher intraminute swings.
- **Trade pace**: minimum time between entries is `TRADE_COOLDOWN_MINUTES` (default 5 minutes).

## Notes
- Jupiter API now uses `https://api.jup.ag/swap/v1` and expects an API key header. If you prefer a different endpoint, set `JUP_BASE_URL`.
- Birdeye OHLCV and token overview endpoints require an API key and may have rate limits.

## Config
See `.env.example` for parameters.

### Multi-position sizing
- `MAX_OPEN_POSITIONS` controls concurrent positions.
- `TRADE_ALLOCATION_PCT` limits per-entry sizing as a percent of available SOL.
- `MAX_POSITION_SOL` caps absolute SOL per position.
- `MIN_REMAINING_SOL` preserves a SOL reserve after entries.

### Rug-pull tuning roadmap
See `docs/rugpull_tuning.md` for the phased plan to collect data, label rug events, and tune the simulator with open-source modeling tools.

### Rug-pull modeling (Python)
See `modeling/README.md` for the Python baseline used to train and score a rug-pull risk model from `rugpull_samples.jsonl`.

### Momentum mode (optional)
Set `MOMENTUM_MODE=1` to rank candidates by recent price change (short + long lookback) instead of the RSI/EMA signal. Use the `MOMENTUM_*` settings in `.env.example` to tune the lookbacks, minimum % change, and weighting.

### Flash/volatility settings
`FLASH_WINDOW_MINUTES` controls the lookback window used to compute intraminute volatility (high-low % range). `MIN_VOLATILITY_PCT` is a hard filter to only consider actively swinging tokens. `VOLATILITY_WEIGHT` boosts that volatility in the final score.

## Disclaimer
This is experimental software. Use at your own risk.
