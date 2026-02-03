import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import config from "./config.js";
import { nowMs } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const samplesPath = path.join(__dirname, "..", "rugpull_samples.jsonl");

const WEIGHTS = {
  scam: 50,
  honeypot: 50,
  mintable: 15,
  freezeable: 10,
  mintAuthority: 12,
  freezeAuthority: 8,
  ownerCanChange: 8,
  highTax: 8,
  lpUnlock: 8,
  topHolders: 10,
  lowLiquidity: 5,
  lowVolume: 3,
};

function toBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(s)) return true;
    if (["0", "false", "no", "n"].includes(s)) return false;
  }
  return Boolean(value);
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function flagScore(flags, key, active, weight) {
  if (!active) return 0;
  flags[key] = true;
  return weight;
}

export function computeRugPullRisk({ overview, security, mintInfo, holdersPct } = {}) {
  const flags = {};
  let score = 0;

  const scam = toBool(security?.isScam ?? security?.is_scam);
  score += flagScore(flags, "scam", scam === true, WEIGHTS.scam);

  const honeypot = toBool(security?.is_honeypot ?? security?.isHoneypot);
  score += flagScore(flags, "honeypot", honeypot === true, WEIGHTS.honeypot);

  const mintable = toBool(security?.is_mintable ?? security?.mintable ?? security?.can_mint);
  score += flagScore(flags, "mintable", mintable === true, WEIGHTS.mintable);

  const freezeable = toBool(security?.is_freezeable ?? security?.freezeable ?? security?.can_freeze);
  score += flagScore(flags, "freezeable", freezeable === true, WEIGHTS.freezeable);

  const ownerCanChange = toBool(
    security?.owner_change_balance ?? security?.ownerCanChangeBalance ?? security?.owner_change
  );
  score += flagScore(flags, "ownerCanChange", ownerCanChange === true, WEIGHTS.ownerCanChange);

  const highTax = toBool(security?.high_tax ?? security?.highTax ?? security?.is_high_tax);
  score += flagScore(flags, "highTax", highTax === true, WEIGHTS.highTax);

  const lpUnlock = toBool(
    security?.lp_unlock ?? security?.lpUnlock ?? security?.liquidity_unlock ?? security?.liquidityUnlocked
  );
  score += flagScore(flags, "lpUnlock", lpUnlock === true, WEIGHTS.lpUnlock);

  const hasMintAuth = Boolean(mintInfo?.mintAuthority);
  score += flagScore(flags, "mintAuthority", hasMintAuth, WEIGHTS.mintAuthority);

  const hasFreezeAuth = Boolean(mintInfo?.freezeAuthority);
  score += flagScore(flags, "freezeAuthority", hasFreezeAuth, WEIGHTS.freezeAuthority);

  const holders = safeNumber(holdersPct, null);
  const holdersThreshold = safeNumber(config.rugRiskHoldersPct, 35);
  if (holders !== null && holdersThreshold !== null && holders >= holdersThreshold) {
    score += flagScore(flags, "topHolders", true, WEIGHTS.topHolders);
  }

  const liquidityUsd = safeNumber(overview?.liquidityUSD ?? overview?.liquidityUsd ?? overview?.liquidity, null);
  const minLiquidity = safeNumber(config.minLiquidityUsd, null);
  if (liquidityUsd !== null && minLiquidity !== null && liquidityUsd < minLiquidity * 2) {
    score += flagScore(flags, "lowLiquidity", true, WEIGHTS.lowLiquidity);
  }

  const vol24hUsd = safeNumber(
    overview?.volume24hUSD ?? overview?.volume24hUsd ?? overview?.v24hUSD ?? overview?.volumeUSD,
    null
  );
  const minVol = safeNumber(config.minVol24hUsd, null);
  if (vol24hUsd !== null && minVol !== null && vol24hUsd < minVol * 2) {
    score += flagScore(flags, "lowVolume", true, WEIGHTS.lowVolume);
  }

  return {
    score,
    flags,
    holdersPct: holders,
    liquidityUsd,
    vol24hUsd,
  };
}

export function appendRugPullSample(sample) {
  if (!config.rugSampleLog) return;
  const payload = { t: nowMs(), ...sample };
  fs.appendFileSync(samplesPath, `${JSON.stringify(payload)}\n`);
}
