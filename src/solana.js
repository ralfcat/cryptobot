import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress, getMint } from "@solana/spl-token";

const TOKEN_ACCOUNT_SIZE = 165;

export function createConnection(rpcUrl) {
  return new Connection(rpcUrl, "confirmed");
}

export function pubkey(input) {
  return new PublicKey(input);
}

export async function getSolBalance(connection, owner) {
  const lamports = await connection.getBalance(owner, "confirmed");
  return lamports / LAMPORTS_PER_SOL;
}

export async function getTokenBalance(connection, owner, mint) {
  const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed");
  let total = 0;
  for (const account of resp.value) {
    const amount = account.account.data.parsed.info.tokenAmount.uiAmount || 0;
    total += amount;
  }
  return total;
}

export async function getTokenBalanceRaw(connection, owner, mint) {
  const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed");
  let total = 0n;
  for (const account of resp.value) {
    const raw = BigInt(account.account.data.parsed.info.tokenAmount.amount || "0");
    total += raw;
  }
  return total;
}

export async function getMintInfo(connection, mint) {
  const mintInfo = await getMint(connection, mint, "confirmed");
  return {
    decimals: mintInfo.decimals,
    mintAuthority: mintInfo.mintAuthority,
    freezeAuthority: mintInfo.freezeAuthority,
    supply: mintInfo.supply,
  };
}

export async function getTopHoldersPct(connection, mint, topN = 10) {
  try {
    const largest = await connection.getTokenLargestAccounts(mint, "confirmed");
    const supply = await connection.getTokenSupply(mint, "confirmed");
    const total = supply.value.uiAmount ?? 0;
    if (!total || !Number.isFinite(total)) return { pct: null, error: null };
    const list = largest.value.slice(0, topN);
    const topSum = list.reduce((acc, item) => acc + (item.uiAmount || 0), 0);
    return { pct: (topSum / total) * 100, error: null };
  } catch (err) {
    return { pct: null, error: err };
  }
}

export async function getTokenSupply(connection, mint) {
  const supply = await connection.getTokenSupply(mint, "confirmed");
  return supply.value;
}

export async function getAtaRentLamports(connection, owner, mint) {
  const ata = await getAssociatedTokenAddress(mint, owner, false);
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (info) return 0;
  return connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);
}
