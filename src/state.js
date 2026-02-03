import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const statePath = path.join(__dirname, "..", "state.json");
const defaultState = {
  position: null,
  lastTradeTimeMs: 0,
  lastExitTimeMs: 0,
  simBalanceSol: 0,
  simBalanceUsd: 0,
  simPosition: null,
};

export function loadState() {
  try {
    if (!fs.existsSync(statePath)) return { ...defaultState };
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...defaultState };
    return { ...defaultState, ...parsed };
  } catch {
    return { ...defaultState };
  }
}

export function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function clearState() {
  saveState({ ...defaultState });
}
