# Running Crypto Meme Auto Trader (Solana)

This guide is intentionally exhaustive. Follow each step in order so the bot can start, connect to Solana, and expose the dashboard.

## 1) Prerequisites

### System requirements
- **Node.js 18+** (required by the project). Confirm with:
  ```bash
  node --version
  ```
- **npm** (comes with Node). Confirm with:
  ```bash
  npm --version
  ```
- **Git** (only if you need to clone the repo). Confirm with:
  ```bash
  git --version
  ```

### Required accounts/keys
- **Solana RPC URL** (Helius, QuickNode, or public RPC).
- **Birdeye API key**.
- **Jupiter API key** (required for `api.jup.ag`).
- **A dedicated hot wallet keypair JSON** (the bot must sign transactions without manual approval).

> ⚠️ **Safety warning:** Use a fresh keypair with limited funds. This bot is experimental and high risk.

## 2) Obtain or create a hot wallet keypair

You need a keypair file (`.json`) on disk. If you already have one, skip to step 3.

### Option A: Create a new Solana keypair (recommended)
1. Install the Solana CLI (if you don’t have it): https://docs.solana.com/cli/install-solana-cli-tools
2. Generate a new keypair:
   ```bash
   solana-keygen new --outfile /absolute/path/to/keypair.json
   ```
3. Fund the new wallet with a small amount of SOL (enough for test trades and fees).
4. Ensure the keypair file is readable by your user.

### Option B: Use an existing keypair
1. Locate your keypair JSON file.
2. Ensure the path is absolute (e.g., `/Users/you/keys/bot-keypair.json`).

## 3) Clone or open the repository

If you already have the repo locally, skip to step 4.

```bash
git clone <repo-url>
cd cryptobot
```

> This guide assumes you are in the repo root where `package.json` lives.

## 4) Install dependencies

```bash
npm install
```

This installs the required Node modules listed in `package.json`.

## 5) Configure environment variables

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and set the required values:
   ```ini
   RPC_URL=https://your-solana-rpc
   BIRDEYE_API_KEY=your-birdeye-key
   JUP_API_KEY=your-jupiter-key
   KEYPAIR_PATH=/absolute/path/to/your/keypair.json
   PORT=8787
   ```

### Required fields explained
- **RPC_URL**: A Solana RPC endpoint URL (HTTPS).
- **BIRDEYE_API_KEY**: Used for market data.
- **JUP_API_KEY**: Used for Jupiter swap quotes/execution.
- **KEYPAIR_PATH**: Absolute path to your hot wallet JSON file.
- **PORT**: Dashboard HTTP port. Default is `8787` if unset.

### Optional but useful checks
- Confirm the file path is correct and readable:
  ```bash
  ls -l /absolute/path/to/your/keypair.json
  ```
- Confirm your RPC is reachable (should return JSON):
  ```bash
  curl -s -X POST "$RPC_URL" -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
  ```

## 6) Start the bot

From the repo root:

```bash
npm start
```

### What to expect
- The bot starts a web server (Express) and begins its trading loop.
- The dashboard is available at:
  ```
  http://localhost:8787
  ```
  (or the `PORT` you set in `.env`).

## 7) Stop the bot

Press **Ctrl+C** in the terminal running the bot.

## 8) (Optional) Run with Docker

You can run the bot in a container using Docker and docker-compose.

### Prerequisites
- Docker Desktop or Docker Engine
- `docker-compose` (if not bundled with Docker)

### Steps
1. Ensure your `.env` file exists in the repo root.
2. Build and run the container:
   ```bash
   docker-compose up --build
   ```
3. Access the dashboard at:
   ```
   http://localhost:8787
   ```

### Notes for Docker
- The container expects `KEYPAIR_PATH` to be valid **inside** the container. If your keypair is outside the repo, mount it as a volume or copy it into the repo and update the path accordingly.
- `docker-compose.yml` maps `PORT` (default `8787`) from your machine to the container.

## 9) (Optional) Training dataset builder

If you want to build datasets from bot logs:

```bash
node training/build_dataset.js --events training_events.jsonl --trades trades.jsonl --date 2024-01-15
```

Outputs go to `data/datasets/{date}/` and include `train.parquet` and `metadata.json` (or `train.jsonl` if parquet is unavailable).

## 10) Troubleshooting checklist

- **Bot exits immediately**: Check `.env` values (especially `RPC_URL` and `KEYPAIR_PATH`).
- **Dashboard not loading**: Confirm `PORT` isn’t in use; try a different port.
- **No trades happening**: Ensure your wallet has SOL and your API keys are valid.
- **Jupiter errors**: Verify `JUP_API_KEY` and that the base URL is reachable.
- **Rate limit errors**: Check Birdeye or RPC provider limits.

---

If you need to change any trading behavior, review `.env.example` and adjust the settings there before starting the bot.
