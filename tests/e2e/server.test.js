import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fetch from "node-fetch";
import WebSocket from "ws";
import { startServer } from "../../src/server.js";

let uiServer;
let baseUrl;
let wsUrl;

function waitForMessage(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

before(async () => {
  uiServer = startServer({
    port: 0,
    host: "127.0.0.1",
    onSellNow: async () => ({ ok: true, status: "queued" }),
    onResetCooldown: async () => ({ ok: true, reset: true }),
    onSetMode: async (mode) => ({ ok: true, mode }),
  });

  await new Promise((resolve) => uiServer.server.once("listening", resolve));
  const { port } = uiServer.server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

after(async () => {
  if (uiServer) {
    await uiServer.close();
  }
});

test("serves the dashboard shell", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.includes("Meme Coin Auto Trader"));
});

test("handles manual sell requests", async () => {
  const response = await fetch(`${baseUrl}/api/sell-now`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "queued");
});

test("rejects invalid mode changes", async () => {
  const response = await fetch(`${baseUrl}/api/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "invalid" }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "invalid_mode");
});

test("broadcasts websocket payloads", async () => {
  const payload = { status: "ready", ts: Date.now() };
  uiServer.broadcast(payload);

  const ws = new WebSocket(wsUrl);
  const messagePromise = waitForMessage(ws);
  await new Promise((resolve) => ws.once("open", resolve));
  const message = await messagePromise;
  ws.close();
  const parsed = JSON.parse(message.toString());
  assert.deepEqual(parsed, payload);
});
