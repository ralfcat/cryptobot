import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

export function startServer({
  port,
  host,
  onSellNow,
  onResetCooldown,
  onSetMode,
  onGetStats,
  metricsEnabled = false,
  metricsPath = "/metrics",
  metricsRegister = null,
  statsApiKey = "",
}) {
  const app = express();
  app.use(express.static(publicDir));
  app.use(express.json());
  const apiKey = process.env.UI_API_KEY || "";

  const requireApiKey = (req, res, next) => {
    if (!apiKey) {
      next();
      return;
    }
    const header = req.headers["x-api-key"] || "";
    const bearer = req.headers.authorization || "";
    const token = bearer.startsWith("Bearer ") ? bearer.slice("Bearer ".length) : "";
    if (header === apiKey || token === apiKey) {
      next();
      return;
    }
    res.status(401).json({ ok: false, error: "unauthorized" });
  };

  const ensureStatsAuth = (req, res) => {
    if (!statsApiKey) return true;
    const header = req.headers["x-api-key"] || "";
    const bearer = req.headers.authorization || "";
    const token = bearer.startsWith("Bearer ") ? bearer.slice("Bearer ".length) : "";
    if (header === statsApiKey || token === statsApiKey) return true;
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  };

  app.post("/api/sell-now", requireApiKey, async (req, res) => {
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

  app.post("/api/reset-cooldown", requireApiKey, async (req, res) => {
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

  app.post("/api/mode", requireApiKey, async (req, res) => {
    if (!onSetMode) {
      res.status(503).json({ ok: false, error: "mode_unavailable" });
      return;
    }
    const mode = String(req.body?.mode || "").toLowerCase();
    if (!["sharp", "simulator"].includes(mode)) {
      res.status(400).json({ ok: false, error: "invalid_mode" });
      return;
    }
    try {
      const result = await onSetMode(mode);
      if (result?.ok === false) {
        res.status(409).json(result);
        return;
      }
      res.json({ ok: true, mode, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.get("/api/stats", (req, res) => {
    if (!ensureStatsAuth(req, res)) return;
    if (!onGetStats) {
      res.status(503).json({ ok: false, error: "stats_unavailable" });
      return;
    }
    try {
      res.json({ ok: true, ...onGetStats() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  if (metricsEnabled && metricsRegister) {
    app.get(metricsPath, async (req, res) => {
      try {
        res.set("Content-Type", metricsRegister.contentType);
        res.send(await metricsRegister.metrics());
      } catch (err) {
        res.status(500).send(err?.message || String(err));
      }
    });
  }

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

  const close = () =>
    new Promise((resolve, reject) => {
      wss.close(() => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    });

  return { broadcast, close, server };
}
