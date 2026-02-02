import fs from "fs";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import config from "./config.js";

export function loadKeypair() {
  let secret = null;
  if (config.keypairPath) {
    const raw = fs.readFileSync(config.keypairPath, "utf8");
    secret = JSON.parse(raw);
  } else if (config.secretKey) {
    if (config.secretKey.trim().startsWith("[")) {
      secret = JSON.parse(config.secretKey);
    } else {
      secret = Array.from(bs58.decode(config.secretKey.trim()));
    }
  }
  if (!secret) throw new Error("Missing KEYPAIR_PATH or SECRET_KEY.");
  const secretKey = Uint8Array.from(secret);
  return Keypair.fromSecretKey(secretKey);
}
