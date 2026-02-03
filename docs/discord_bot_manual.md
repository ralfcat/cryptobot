# Discord Bot Setup Manual (Super Simple, Step-by-Step)

This guide is written so a 5-year-old can follow it. We go **slow**, do **one thing at a time**, and explain **why**.

## What You Are Making
You are turning on a **helper robot** in Discord.  
When you type commands like `!status`, it tells you how the bot is doing.

---

## Part 1: Make a Discord “Robot”
### 1) Open the Discord Developer Portal
Go to: https://discord.com/developers/applications  
Click **New Application**.

### 2) Name it
Type a name like **CryptoBot Helper**.  
Press **Create**.

### 3) Make it a Bot
On the left menu, click **Bot**.  
Click **Add Bot** → **Yes, do it!**

### 4) Copy the “Bot Token”
On the bot page, click **Reset Token** and **Copy**.  
This is a **secret password**.  
**Do NOT share it.**

---

## Part 2: Invite the Bot to Your Discord Server

### 1) Go to OAuth2 → URL Generator
On the left menu, click **OAuth2** → **URL Generator**.

### 2) Pick Scopes
Check **bot**.

### 3) Pick Bot Permissions
Check:
- **Read Messages/View Channels**
- **Send Messages**
- **Read Message History**

### 4) Copy the Invite Link
Scroll down and **copy** the generated link.  
Open it in your browser and invite the bot to your server.

---

## Part 3: Turn On Message Content (Important)

### 1) Go to the Bot Page Again
Left menu → **Bot**

### 2) Find “Privileged Gateway Intents”
Turn **ON**:
- **Message Content Intent**

Press **Save Changes**.

---

## Part 4: Tell the Crypto Bot About Your Discord Bot

You will put the secret token into your `.env` file.

### 1) Open `.env` (or create it)
Inside your project folder:
- If you do not have `.env`, copy `.env.example` and rename it to `.env`.

### 2) Add These Lines
Replace the words in ALL CAPS with your real info.

```
DISCORD_BOT_TOKEN=PASTE_YOUR_SECRET_TOKEN_HERE
DISCORD_COMMAND_PREFIX=!
DISCORD_STATS_URL=http://localhost:8787/api/stats
STATS_API_KEY=MAKE_UP_A_SECRET_PASSWORD
```

---

## Part 5: Protect the Stats Endpoint

This bot reads stats from a private endpoint.  
You already set `STATS_API_KEY`.

That means the bot can read stats, but strangers cannot.

---

## Part 6: Start the Crypto Bot

In your terminal:

```
npm start
```

Wait until it says the UI is running (the bot must be running).

---

## Part 7: Start the Discord Bot

Open another terminal and run:

```
npm run discord:bot
```

You should see:
`Discord bot connected as ...`

---

## Part 8: Try Commands in Discord

In your Discord server, type:

- `!status` → shows status and balances
- `!positions` → shows open positions
- `!stats` → shows last action and recent trades

---

## Optional: Only Allow Specific Channels

If you only want the bot to answer in one channel:

1) Right-click the Discord channel → **Copy Channel ID**  
   (You need Developer Mode enabled in Discord settings.)

2) Put the ID in `.env`:

```
DISCORD_ALLOWED_CHANNEL_IDS=123456789012345678
```

You can add multiple IDs with commas:

```
DISCORD_ALLOWED_CHANNEL_IDS=111111111111111111,222222222222222222
```

---

## Troubleshooting (Simple Fixes)

### “Bot is offline”
- You did not run `npm run discord:bot`

### “Failed to fetch stats”
- The main crypto bot is not running (`npm start`).
- `STATS_API_KEY` is missing or different between bots.

### “Bot does not respond”
- You forgot to enable **Message Content Intent**.
- You are typing commands without the `!` prefix.
- The bot is not in your server.

---

## You Did It!
Now your Discord bot can talk to you and show stats.  
Good job! 🎉
