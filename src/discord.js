import fetch from "node-fetch";
import { Client, GatewayIntentBits } from "discord.js";
import config from "./config.js";

const token = config.discordBotToken;
if (!token) {
  console.error("DISCORD_BOT_TOKEN is required to start the Discord bot.");
  process.exit(1);
}

const statsUrl = config.discordStatsUrl || `http://localhost:${config.port}/api/stats`;
const prefix = config.discordCommandPrefix || "!";
const allowedChannels = new Set(config.discordAllowedChannelIds || []);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

async function fetchStats() {
  const headers = {};
  if (config.statsApiKey) headers["x-api-key"] = config.statsApiKey;
  const res = await fetch(statsUrl, { headers });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

function formatUsd(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : "-";
}

function formatPct(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : "-";
}

function formatPositions(positions) {
  if (!positions?.length) return "No open positions.";
  return positions
    .map((pos) => {
      const mint = pos.mint ? `${pos.mint.slice(0, 6)}...` : "-";
      const pnl = formatPct(pos.pnlPct);
      const est = formatUsd(pos.estUsd);
      return `${mint} | ${pnl} | ${est}`;
    })
    .join("\n");
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (allowedChannels.size && !allowedChannels.has(message.channelId)) return;
  if (!message.content.startsWith(prefix)) return;

  const command = message.content.slice(prefix.length).trim().toLowerCase();
  if (!["status", "positions", "stats"].includes(command)) return;

  try {
    const stats = await fetchStats();
    const balances = stats.balances || {};
    if (command === "status") {
      await message.reply(
        `Status: ${stats.status || "-"} | Mode: ${stats.mode || "-"} | ` +
          `SOL ${Number.isFinite(balances.sol) ? balances.sol.toFixed(4) : "-"} | ` +
          `Total ${formatUsd(balances.totalUsd)}`
      );
      return;
    }
    if (command === "positions") {
      await message.reply(`Open positions (${stats.positions?.length || 0}):\n${formatPositions(stats.positions)}`);
      return;
    }
    if (command === "stats") {
      const trades = stats.trades || [];
      await message.reply(
        `Last action: ${stats.lastAction || "-"} | Open positions: ${stats.positions?.length || 0} | ` +
          `Recent trades: ${trades.length}`
      );
    }
  } catch (err) {
    await message.reply(`Failed to fetch stats: ${err?.message || err}`);
  }
});

client.once("ready", () => {
  console.log(`Discord bot connected as ${client.user?.tag}`);
});

client.login(token);
