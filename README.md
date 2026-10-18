# discord-bridge-mcp

An MCP server that DMs **your agent's** todo list and progress updates to Discord — with emoji reactions and a personality you pick.

The agent writes the messages itself, in whatever voice you configure. You get pings on your phone instead of staring at a terminal.

## Install — pick one

### Option A: straight from GitHub (no npm publish needed)

```json
"mcp": {
  "discord-bridge-mcp": {
    "type": "local",
    "command": ["npx", "-y", "github:thelucas128/discord-bridge-mcp"],
    "enabled": true
  }
}
```

That's it. First run downloads deps; later runs are cached.

> **Windows:** `npx` spawns `npx.cmd`, which pops a black console window on every launch. If that bothers you, clone once and run `node` on the file instead — see Option B.

### Option B: clone it (no console window)

```bash
git clone https://github.com/thelucas128/discord-bridge-mcp
cd discord-bridge-mcp
npm install
```

```json
"mcp": {
  "discord-bridge-mcp": {
    "type": "local",
    "command": ["node", "/absolute/path/to/discord-bridge-mcp/index.js"],
    "enabled": true
  }
}
```

### Configure it — let the agent do the work

Restart your MCP client and just ask the agent: **"set up discord"**. It will call `setup_status`, ask you for two things, then call `setup`:

1. **Your bot token** — from https://discord.com/developers/applications → your app → **Bot** → **Reset Token**. Copy it immediately, Discord shows it once.
2. **Your Discord user ID** — enable **User Settings → Advanced → Developer Mode**, then right-click yourself → **Copy User ID**. It's a long number like `822139237184962561`.

Prefer a terminal? Same thing:

```bash
npx -y github:thelucas128/discord-bridge-mcp setup
```

It prompts for token, user ID, and personality, saves to `~/.discord-bridge-mcp.json`, signs in, and DMs you a confirmation. **Restart the MCP server afterwards** — the running process caches its config at startup.

Config resolution order: `DISCORD_TOKEN` / `DISCORD_USER_ID` env vars → `~/.discord-bridge-mcp.json`. Override the file path with `DISCORD_BRIDGE_CONFIG`.

> Why a config file and not just env vars? Most MCP clients spawn servers with a *filtered* environment, so `setx` variables often never reach the process. The file always works.

## Tools

| Tool | What it does |
|---|---|
| `setup` | Save token + user ID + personality to disk. Agent calls this for you. |
| `setup_status` | Is it configured? Returns `setup_is_configured`. |
| `progress_report` | DM the user a progress update. Optional `emojis: ["🔥","✅"]` adds reactions. |
| `todo_add` / `todo_list` / `todo_done` | The todo list. |
| `todo_share` — **removed**. It wrapped your words in a template; use `todo_list` to read the list, then `send_message` with your own wording. |
| `send_message` | DM the user. **Sent exactly as written** — no prefix, no template. |
| `clear_messages` | Delete the bot's own recent DMs. `count: 99` or more = wipe the whole DM history. |
| `ask_question` | DM the user a question; waits up to `timeout_ms` (default 60000 = 1 minute) for a reply, otherwise returns `default_answer` so the agent falls back to its default (e.g., Opencode). |
| `ping` | Mention the user (`<@id>`) on Discord, optionally with a short message. |

### Clearing messages

In OpenCode, `/clear-discordmessage 20` deletes the last 20 bot DMs; `/clear-discordmessage` with no number (or "all") wipes everything.

Works only on the bot's **own** messages — anything you sent is untouched, and Discord requires the bot to be the author.

## Questions

`ask_question` sends the question as a DM and waits for a reply. If the user answers within the timeout, their answer is returned. Otherwise it returns `default_answer` (or `[no reply]`) so the agent can fall back to its default behavior — e.g. Opencode — instead of blocking.

```json
{
  "question": "Should I use Node 20 or 22?",
  "default_answer": "Node 20",
  "timeout_ms": 60000
}
```

Only one question at a time per user; replies are matched to the oldest pending question.

## Ping

`ping` sends a mention (`<@USER_ID>`) with an optional message, useful for "restart required" or attention-getting DMs.

## Personality

Set once at setup, or change any time:

```json
{ "personality": "dry and sarcastic, short sentences, British" }
```

The server folds that sentence into the tool description, so the agent writes every DM in that voice. Default: *warm, encouraging, brief — like a friend cheering you on*.

One personality per install. Run a second MCP instance on a different config file if you want two voices.

## Emoji

Two places, both supported:

- **In the text** — `progress_report({ message: "tests green 🎉" })`
- **As reactions** — `progress_report({ message: "shipped", emojis: ["🚀", "✅"] })`

Reactions use real Discord reactions, so they render as the emoji hovering under the message.

## Requirements

- Node 20+
- A Discord bot token (create one at https://discord.com/developers/applications)
- To DM you, the bot must be in a server **with you**, **or** you must have DMs from server members enabled

## Troubleshooting

**"Cannot send messages to this user" (error 50007)** — the bot can't DM you. Invite it to a server you share, then retry. Server → *Invite People* → paste the bot's URL with the `client_id` from the Developer Portal.

**Nothing arrives** — call `setup_status`; check `setup_is_configured` is true and that the running process was restarted after setup.

**Todos vanish on restart** — they're in memory only. Persistence is not built in.

## Security

- Your token is a full bot credential. Never paste it into a committed file, an issue, or a screenshot.
- `~/.discord-bridge-mcp.json` holds it in plaintext. On a shared machine, use env vars instead or delete the file after setup.
- Leaked? Reset it in the Developer Portal immediately — the old one dies.
- `.gitignore` excludes `.env*`; `.env.example` is placeholders only.

## License

MIT