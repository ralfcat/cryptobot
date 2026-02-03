import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fetch from "node-fetch";
import { startServer } from "../../src/server.js";

let uiServer;
let baseUrl;
let modeRequests = [];

before(async () => {
  modeRequests = [];
  uiServer = startServer({
    port: 0,
    host: "127.0.0.1",
    onSellNow: async () => ({ ok: true }),
    onResetCooldown: async () => ({ ok: true, reset: true }),
    onSetMode: async (mode) => {
      modeRequests.push(mode);
      return { ok: true, mode };
    },
  });

  await new Promise((resolve) => uiServer.server.once("listening", resolve));
  const { port } = uiServer.server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (uiServer) {
    await uiServer.close();
  }
});

test("accepts a reset cooldown request", async () => {
  const response = await fetch(`${baseUrl}/api/reset-cooldown`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.reset, true);
});

test("accepts a valid mode change", async () => {
  const response = await fetch(`${baseUrl}/api/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "simulator" }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "simulator");
  assert.deepEqual(modeRequests, ["simulator"]);
});
