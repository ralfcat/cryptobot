import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

export function startServer({ port, host, onSellNow, onResetCooldown, onSetSimBalance }) {
  const app = express();
  app.use(express.static(publicDir));
  app.use(express.json());

  app.post("/api/sell-now", async (req, res) => {
    if (!onSellNow) {
      res.status(503).json({ ok: false, error: "manual_sell_unavailable" });
      return;
    }
    try {
      const result = await onSellNow();
      if (result?.ok === false) {
        res.status(409).json(result);
        return;
      }
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post("/api/reset-cooldown", async (req, res) => {
    if (!onResetCooldown) {
      res.status(503).json({ ok: false, error: "reset_cooldown_unavailable" });
      return;
    }
    try {
      const result = await onResetCooldown();
      if (result?.ok === false) {
        res.status(409).json(result);
        return;
      }
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post("/api/sim-balance", async (req, res) => {
    if (!onSetSimBalance) {
      res.status(503).json({ ok: false, error: "sim_balance_unavailable" });
      return;
    }
    try {
      const result = await onSetSimBalance(req.body || {});
      if (result?.ok === false) {
        res.status(409).json(result);
        return;
      }
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  let lastPayload = null;

  function broadcast(payload) {
    lastPayload = payload;
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  }

  wss.on("connection", (ws) => {
    if (lastPayload) {
      ws.send(JSON.stringify(lastPayload));
    }
  });

  server.listen(port, host, () => {
    const bindHost = host || "0.0.0.0";
    console.log(`UI server listening on http://${bindHost}:${port}`);
  });

  return { broadcast };
}
