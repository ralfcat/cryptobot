import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const statePath = path.join(__dirname, "..", "state.json");

export function loadState() {
  try {
    if (!fs.existsSync(statePath)) return { position: null, lastTradeTimeMs: 0, lastExitTimeMs: 0 };
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed || { position: null, lastTradeTimeMs: 0, lastExitTimeMs: 0 };
  } catch {
    return { position: null, lastTradeTimeMs: 0, lastExitTimeMs: 0 };
  }
}

export function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function clearState() {
  saveState({ position: null, lastTradeTimeMs: 0, lastExitTimeMs: 0 });
}
