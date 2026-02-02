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

### Momentum mode (optional)
Set `MOMENTUM_MODE=1` to rank candidates by recent price change (short + long lookback) instead of the RSI/EMA signal. Use the `MOMENTUM_*` settings in `.env.example` to tune the lookbacks, minimum % change, and weighting.

### Flash/volatility settings
`FLASH_WINDOW_MINUTES` controls the lookback window used to compute intraminute volatility (high-low % range). `MIN_VOLATILITY_PCT` is a hard filter to only consider actively swinging tokens. `VOLATILITY_WEIGHT` boosts that volatility in the final score.

## Disclaimer
This is experimental software. Use at your own risk.
