# discord-bridge-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent a todo list and a
direct line to your Discord DMs, so you can see what it's doing without watching the terminal.

Renamed from `discord-todo-mcp`, which undersold it: the DM progress channel is the main feature,
the todo list is secondary.

Tools exposed over stdio:

| Tool | What it does |
|---|---|
| `todo_add` | Add a task to the in-memory list |
| `todo_list` | List tasks with done state |
| `todo_done` | Mark a task done by index |
| `progress_report` | Send a progress message to your Discord DM |

## Requirements

- Node.js 20+
- A Discord bot token
- The bot and you must share a server, **or** you must have DMs from server members already enabled

## Setup

### 1. Create a Discord bot

1. Go to <https://discord.com/developers/applications> → **New Application**
2. Open **Bot** → **Reset Token** → copy it (this is your `DISCORD_TOKEN`; you only see it once)
3. Keep **Message Content Intent** off — this server never reads message content
4. Invite the bot with the `bot` scope and at least the `Send Messages` permission

### 2. Set your user ID

In Discord: **User Settings → Advanced → Developer Mode** on. Then right-click yourself →
**Copy User ID**. That's your `DISCORD_USER_ID`.

### 3. Install and run

```bash
npm install
```

Set the two variables, then start the server:

```bash
# PowerShell (current session)
$env:DISCORD_TOKEN = "your-bot-token"
$env:DISCORD_USER_ID = "your-user-id"
node index.js
```

`node index.js` prints `MCP server running on stdio` and `Discord client ready`, then waits
silently. That silence is correct — it's waiting for an MCP client to connect over stdin.

To make the variables permanent on Windows:

```powershell
setx DISCORD_TOKEN "your-bot-token"
setx DISCORD_USER_ID "your-user-id"
```

Restart your terminal afterwards; `setx` only affects new processes.

## Registering with an MCP client

Launch it with `node` directly rather than `npx .` — on Windows, `npx` resolves to `npx.cmd`,
which pops a separate console window on every start.

```json
{
  "mcp": {
    "discord-bridge-mcp": {
      "type": "local",
      "command": ["node", "/absolute/path/to/discord-bridge-mcp/index.js"],
      "cwd": "/absolute/path/to/discord-bridge-mcp",
      "enabled": true
    }
  }
}
```

## Security

- `DISCORD_TOKEN` is a **full bot credential**. Anyone holding it controls the bot: read its DMs,
  join it to servers, act as it. Treat it exactly like a password.
- This repo reads both secrets from the environment only. There are no hardcoded values, and
  `.env` is gitignored. **Never paste a real token into a file that gets committed.**
- If a token ever leaks, go to the Developer Portal → your app → **Bot → Reset Token** and update
  your environment variable. Resetting invalidates the old one immediately.
- Setting the variables with `setx` stores them in your user registry, readable by any process you
  run. That's fine on a personal machine; don't do it on a shared or locked-down one.

## Limitations

- The todo list lives in memory. Restarting the server clears it. By design — there's no database.
- `progress_report` sends plain text. Discord's 2000-character DM limit applies.
- If DM delivery fails with `Cannot send messages to this user`, the bot isn't in a server with you
  and your DMs are closed. Fix it by joining the bot to one of your servers, or opening a DM channel
  from any shared server first.

## License

MIT
