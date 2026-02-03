import { expect, test } from "@playwright/test";
import { startServer } from "../../src/server.js";

let uiServer;
let baseUrl;

test.beforeAll(async () => {
  uiServer = startServer({
    port: 0,
    host: "127.0.0.1",
    onSellNow: async () => ({ ok: true }),
    onResetCooldown: async () => ({ ok: true, reset: true }),
    onSetMode: async (mode) => ({ ok: true, mode }),
  });

  await new Promise((resolve) => uiServer.server.once("listening", resolve));
  const { port } = uiServer.server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  if (uiServer) {
    await uiServer.close();
  }
});

test("renders the dashboard and responds to mode changes", async ({ page }) => {
  await page.goto(baseUrl);

  await expect(page.getByRole("heading", { name: "Meme Coin Auto Trader" })).toBeVisible();

  uiServer.broadcast({
    status: "Live",
    lastAction: "Monitoring market",
    mode: "sharp",
    balances: { sol: 1.2345, solUsd: 24.68, totalUsd: 24.68 },
    position: null,
    rules: { stopLossPct: 0.2, takeProfitPct: 40, exitSoftMinutes: 25, exitHardMinutes: 60 },
    cooldown: { minutes: 10, nextEntryMs: Date.now() + 60000, remainingSec: 30 },
    logs: [{ t: Date.now(), level: "info", msg: "Booted" }],
    trades: [],
    updatedAt: Date.now(),
  });

  await expect(page.locator("#status-text")).toHaveText("Live");
  await expect(page.locator("#last-action")).toHaveText("Monitoring market");

  await page.getByRole("button", { name: "Simulator mode" }).click();
  await expect(page.locator("#mode-status")).toContainText("Simulator mode");
});

test("allows manual sell confirmation", async ({ page }) => {
  await page.goto(baseUrl);

  uiServer.broadcast({
    status: "Live",
    lastAction: "Position opened",
    mode: "sharp",
    balances: { sol: 1.2, solUsd: 23, totalUsd: 23 },
    position: { mint: "TOKEN", heldMinutes: 2.3, pnlPct: 1.2, estUsd: 24 },
    rules: { stopLossPct: 0.2, takeProfitPct: 40, exitSoftMinutes: 25, exitHardMinutes: 60 },
    cooldown: { minutes: 10, nextEntryMs: Date.now() + 60000, remainingSec: 30 },
    logs: [],
    trades: [],
    updatedAt: Date.now(),
  });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Sell now" }).click();
  await expect(page.locator("#sell-status")).toContainText("Sell requested");
});
