import dotenv from "dotenv";

dotenv.config();

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  const n = Number(v);
  return Number.isFinite(n) ? n !== 0 : fallback;
}

const config = {
  rpcUrl: process.env.RPC_URL || "",
  birdeyeApiKey: process.env.BIRDEYE_API_KEY || "",
  birdeyeMinIntervalMs: num("BIRDEYE_MIN_INTERVAL_MS", 0),
  birdeyeMaxRetries: num("BIRDEYE_MAX_RETRIES", 2),
  birdeyeRetryBaseMs: num("BIRDEYE_RETRY_BASE_MS", 500),
  birdeyeRetryMaxMs: num("BIRDEYE_RETRY_MAX_MS", 5000),
  birdeyeCacheTtlMs: num("BIRDEYE_CACHE_TTL_MS", 30000),
  birdeyeBlockMinutes: num("BIRDEYE_BLOCK_MINUTES", 10),

  dataProvider: process.env.DATA_PROVIDER || "auto",
  dexChainId: process.env.DEX_CHAIN_ID || "solana",
  dexMinIntervalMs: num("DEX_MIN_INTERVAL_MS", 200),
  dexCacheTtlMs: num("DEX_CACHE_TTL_MS", 30000),
  dexSeedLimit: num("DEX_SEED_LIMIT", 30),
  dexMinPriceChangePct: num("DEX_MIN_PRICE_CHANGE_PCT", 3),
  dexPriceChangeWindow: process.env.DEX_PRICE_CHANGE_WINDOW || "h1",
  jupBaseUrl: process.env.JUP_BASE_URL || "https://api.jup.ag/swap/v1",
  jupApiKey: process.env.JUP_API_KEY || "",

  keypairPath: process.env.KEYPAIR_PATH || "",
  secretKey: process.env.SECRET_KEY || "",

  host: process.env.HOST || "0.0.0.0",
  port: num("PORT", 8787),
  uiRefreshSeconds: num("UI_REFRESH_SECONDS", 5),
  scanIntervalSeconds: num("SCAN_INTERVAL_SECONDS", 30),

  feeBufferSol: num("FEE_BUFFER_SOL", 0.01),
  maxSlippageBps: num("MAX_SLIPPAGE_BPS", 300),
  maxPriceImpactPct: num("MAX_PRICE_IMPACT_PCT", 5),
  stopLossPct: num("STOP_LOSS_PCT", 0.2),
  accountStopUsd: num("ACCOUNT_STOP_USD", 10),
  takeProfitPct: num("TAKE_PROFIT_PCT", 12),
  takeProfitUsd: num("TAKE_PROFIT_USD", 1),

  exitSoftMinutes: num("EXIT_SOFT_MINUTES", 15),
  exitHardMinutes: num("EXIT_HARD_MINUTES", 60),
  tradeCooldownMinutes: num("TRADE_COOLDOWN_MINUTES", 5),

  maxTop10Pct: num("MAX_TOP10_PCT", 40),
  minLiquidityUsd: num("MIN_LIQUIDITY_USD", 5000),
  minVol15mUsd: num("MIN_VOL_15M_USD", 2000),
  minVol24hUsd: num("MIN_VOL_24H_USD", 10000),
  candidateLimit: num("CANDIDATE_LIMIT", 12),
  trendingLimit: num("TRENDING_LIMIT", 20),
  flashWindowMinutes: num("FLASH_WINDOW_MINUTES", 15),
  minVolatilityPct: num("MIN_VOLATILITY_PCT", 3),
  volatilityWeight: num("VOLATILITY_WEIGHT", 2),

  momentumMode: bool("MOMENTUM_MODE", false),
  momentumShortMinutes: num("MOMENTUM_SHORT_MINUTES", 15),
  momentumLongMinutes: num("MOMENTUM_LONG_MINUTES", 60),
  momentumMinPctShort: num("MOMENTUM_MIN_PCT_SHORT", 0),
  momentumMinPctLong: num("MOMENTUM_MIN_PCT_LONG", 0),
  momentumWeightShort: num("MOMENTUM_WEIGHT_SHORT", 1),
  momentumWeightLong: num("MOMENTUM_WEIGHT_LONG", 0.5),

  rsiLow: num("RSI_LOW", 30),
  volSpikeMult: num("VOL_SPIKE_MULT", 2),
  emaFast: num("EMA_FAST", 9),
  emaSlow: num("EMA_SLOW", 21),
  bollPeriod: num("BOLL_PERIOD", 20),
  bollStd: num("BOLL_STD", 2),
  minProfitToExtendPct: num("MIN_PROFIT_TO_EXTEND_PCT", 5),
};

export default config;
