# discord-bridge-mcp

An MCP server that turns your Discord DMs into a live line between you and your agent: it DMs progress updates, the todo list, screenshots, questions, and it reads your replies, in real time.

The agent writes the messages itself, in whatever voice you configure. You get everything on your phone instead of staring at a terminal.

## What you need (all three)

1. **A bot token**: create an app at https://discord.com/developers/applications, open it, go to **Bot**, and click **Reset Token**. Copy it immediately: Discord only shows it once.
2. **Your Discord user ID**: enable **User Settings, Advanced, Developer Mode** in Discord, then right-click yourself in any chat and choose **Copy User ID**. It is a long number like `822139237184962561`.
3. **An OAuth invite**: the bot can only DM you if you **share a server with it** (or your privacy settings already allow server members to DM you). Invite your app with this URL, replacing `CLIENT_ID`:

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=117824
```

`117824` covers exactly what the bridge needs: View Channels, Add Reactions, Send Messages, Embed Links, Attach Files, Read Message History.

Both tools in the server (`setup_status`, `setup`) return this exact invite link once the token is known, so the agent handles the URL for you.

## Install, pick one

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

> **Windows:** `npx` spawns `npx.cmd`, which pops a black console window on every launch. If that bothers you, clone once and run `node` on the file instead: Option B.

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

### Configure it: let the agent do the work

Restart your MCP client and just ask the agent: **"set up discord"**. It calls `setup_status`, asks you for the bot token and your user ID, then calls `setup`. Setup applies live (no restart), sends you a confirmation DM, and includes the invite link if the first DM cannot get through.

Prefer a terminal? Same thing:

```bash
npx -y github:thelucas128/discord-bridge-mcp setup
```

It prompts for token, user ID, and personality, saves to `~/.discord-bridge-mcp.json`, signs in, and DMs you a confirmation.

**Config order, first hit wins:** env `DISCORD_TOKEN` / `DISCORD_USER_ID`, then a `.env` file next to `index.js` or in the cwd (`TOKEN=` also works for the token), then `~/.discord-bridge-mcp.json`. Override the file location with `DISCORD_BRIDGE_CONFIG`.

## Tools

| Tool | What it does |
|---|---|
| `setup` | Save token + user ID + personality, then sign in live. No restart needed. |
| `setup_status` | Is it configured? Returns `setup_is_configured`, the OAuth invite URL, and next steps when it is not. |
| `progress_report` | DM the user a progress update. Optional `emojis: ["🔥","✅"]` adds reactions. |
| `send_message` | DM the user. Sent exactly as written, no prefix, no template. |
| `send_screenshot` | Send a file or screenshot from disk (`path`) or raw base64 bytes (`data`), with an optional caption. |
| `send_embed` | Send a rich card (`title`, `description`, `fields`, `color`, `url`, `footer`) for updates that need scanning. Optional `message` adds text above it. |
| `send_markdown` | Send a `.md` attachment that Discord renders as a formatted document — headings, tables, task lists, code blocks — past the 2000-character message cap. |
| `set_status` / `clear_status` | Create one live status message and edit it in place on later calls, instead of flooding the DM with progress reports. |
| `read_attachments` | Download a file the user sent back in the DM to a local path, so the agent can open it. Text files are previewed inline. |
| `update_profile` | Change the bot's own identity: `name`, `bio` (About Me), and the art (`avatar`, `banner`, `icon`, `cover`). |
| `set_presence` | Set the bot's live presence: `status` (online/idle/dnd/invisible) and the `activity` line (`playing`, `watching`, `custom`, …). |
| `ask_question` | DM a question and wait for the user's reply, detected in real time. On timeout, returns its `default_answer` so the agent keeps moving. |
| `check_replies` | Non-blocking peek at the user's recent DM replies, with timestamps and a `msg:id`, to catch messages that arrived while the agent was working. |
| `ping` | Mention the user (`<@id>`), phone notification. Optional short message. |
| `todo_add` / `todo_list` / `todo_done` / `todo_remove` / `todo_reset` | The todo list. It persists across restarts. |
| `clear_messages` | Delete the bot's own recent DMs. `count: 99` or more wipes the whole DM history. |

## Screenshots

The agent can show you what it did. The screenshot itself is taken by whatever tool the agent has (a browser tool, a capture command, anything that writes a file or prints base64), and the bridge sends it to your DM:

```json
{ "path": "C:/Users/you/AppData/Temp/shot-42.png", "message": "New dashboard is live" }
```

or from memory, no temp file needed:

```json
{ "data": "iVBORw0KGgo...", "filename": "preview.png", "message": "error screen before the fix" }
```

Any file up to 25 MB works, png, jpg, gif, webp, pdf, whatever. One call, one roundtrip.

## Live status

For long tasks, one message that updates beats twenty that pile up. The first `set_status` call creates it; every later call edits the same message in place. Its id is saved in the config, so it survives a restart. If you deleted it or wiped the log with `clear_messages`, the next call creates a fresh one.

```json
{ "message": "Step 3/7 — migrating schema", "emojis": ["⚙️"] }
```

Add `title`, `fields`, `color`, `url` or `footer` to make it a card instead of plain text. `clear_status` deletes the message and forgets its id.

## Files back from the user

`check_replies` and `ask_question` print a `msg:id` for each reply. Pass it to `read_attachments` to save whatever the user attached:

```json
{ "message_id": "123456789012345678", "all": true }
```

Without an id, `index: 0` means the newest message from the user. Files land in a temp folder (or `save_dir`), capped at 50 MB. Images come back as a path you can hand to a vision tool; text files (`.txt`, `.md`, `.json`, `.log`, …) also get a 4000-character inline preview.

## Rich embeds

`send_embed` builds a Discord card, useful for digests and anything with several labelled values:

```json
{
  "title": "Deploy complete",
  "color": "#57f287",
  "fields": [
    { "name": "Commit", "value": "a1b2c3d", "inline": true },
    { "name": "Tests", "value": "142 passed", "inline": true }
  ],
  "footer": "staging"
}
```

`color` accepts `#RRGGBB`, `#rgb`, or a name like `red`, `green`, `blue`, `gold`. Discord allows 25 fields and 6000 characters per embed; overlong input is trimmed or rejected with a clear error instead of silently dropped.

## Markdown documents

Discord renders `.md` attachments as a formatted document — GitHub-style headings, tables, task lists and fenced code — instead of a plain-text preview. That makes a file the right container for anything too long or too structured for a 2000-character message:

```json
{
  "filename": "migration-plan.md",
  "message": "Plan is in the file 👇",
  "markdown": "# Migration plan\n\n| Step | Status |\n|---|---|\n| Schema | ✅ |\n| Backfill | ⏳ |\n"
}
```

Pass inline `markdown` or `path` to an existing `.md` file; `filename` gets a `.md` extension if you leave it off. The file is capped at 25 MB like any other attachment.

## Its own profile

The agent can style the bot it speaks through. Every field is optional, and only what you pass changes:

```json
{
  "name": "Mochi",
  "bio": "Your build buddy. I watch CI so you don't have to.",
  "avatar": { "path": "C:/art/mochi.png" },
  "banner": { "path": "C:/art/banner.png" }
}
```

- `name` is the bot's username (2-32 chars, letters/numbers/`_`/`.`). Discord caps changes at **2 per hour**.
- `bio` is the About Me text on the bot's profile (the application description), up to 400 characters. It is **decoration only**: a cool line, a vibe, taste. Never a reply, a question or a message to you — those go through `send_message`, `progress_report` and `ask_question`.
- `avatar` and `banner` are the profile art; `icon` and `cover` are the developer-profile art. Each takes `{ "path": ... }` or `{ "data": "<base64>", "filename": "x.png" }`, must be png/jpg/gif/webp, and is capped at 10 MB.

`set_presence` controls the status line under the name:

```json
{ "status": "idle", "activity": "watching your CI", "activity_type": "custom" }
```

`activity_type` is one of `playing`, `watching`, `listening`, `streaming`, `competing`, `custom` (streaming also needs `activity_url`, a Twitch/YouTube link). Omit a field to leave it alone; pass `activity: ""` to clear the line.

The presence is **purely aesthetic**: a mood, a cool fun fact, or a tiny hint of progress ("3/7 tests left"). It is not a place to ask or answer you — anything you need to read goes through `send_message`, `progress_report` or `set_status`. This is the bot's Discord presence, not the DM status message, which is `set_status`.

## Talking while working

`ask_question` sends the question and waits. Replies are detected by the Discord gateway, so the agent sees your answer the moment you hit send, with a light polling fallback in case an event gets dropped. If you say nothing within `timeout_ms` (default 60 s, max 10 min), it returns the agent's own `default_answer` and the agent continues with its default behavior instead of blocking you.

```json
{
  "question": "Migrate or keep the old schema?",
  "default_answer": "keep it",
  "timeout_ms": 90000
}
```

`check_replies` is the free version: it returns your recent DMs with timestamps and never waits, so the agent can glance at your messages between steps ("read your replies, was that a yes?").

One `ask_question` at a time in the same thread: two waiting calls can cross-match your replies.

## Personality

Set once at setup, or change any time:

```json
{ "personality": "dry and sarcastic, short sentences, British" }
```

The server folds that sentence into the tool description, so the agent writes every DM in that voice. Default: *warm, encouraging, brief, like a friend cheering you on*. Changes apply on the next tool refresh, no restart.

One personality per install. Run a second MCP instance on a different config file if you want two voices.

## Speed

- The bot's user and DM channel are cached after the first fetch: each send is one Discord API call, not three.
- Login is lazy and happens once per process, before the first message.
- Questions arrive while you are still typing: gateway events wake the waiting tool instantly.
- The `.env` parsing runs once at startup, no framework, still one file.

## Persistence

Todos are saved in the config file on every change (`todo_add`, `todo_done`, `todo_remove`, `todo_reset` all write through), so `todo_list` survives a server restart. Messages stay in the DM history you already scroll.

## Clearing messages

In OpenCode, `/clear-discordmessage 20` deletes the last 20 bot DMs; `/clear-discordmessage` with no number (or "all") wipes everything.

Works only on the bot's **own** messages: anything you sent is untouched, and Discord requires the bot to be the author.

## Requirements

- Node 20+
- A Discord bot token (see above)
- To DM you, the bot must be in a server **with you**, **or** you must have DMs from server members enabled

## Troubleshooting

**"Cannot send messages to this user" (error 50007)**: the bot cannot DM you. It needs to share a server with you. Ask the agent to call `setup_status` and open the `invite_url` it returns (the `setup` CLI prints it too), invite the bot, then retry. You can also build the URL by hand from the top of this README, using your app's client id.

**Nothing arrives**: call `setup_status`; check `setup_is_configured` is true. The v3 bridge hot-reloads after `setup`, no restart needed. But if the running process is still an older version, restart the MCP server once.

**Upload rejected: too big**: Discord caps bot uploads at 25 MB per file. Compress the screenshot or crop it.

**No reply detected in `ask_question`**: gateway connections can drop without notice once in a while. The bridge already polls every 5 s as backup, so a rare miss recovers on the next sweep. If every question times out, check the bot is still invited on a server you share, and that you replied inside the bot's DM, not another channel.

## Security

- Your token is a full bot credential. Never paste it into a committed file, an issue, or a screenshot.
- `~/.discord-bridge-mcp.json` holds it in plaintext. On a shared machine, use env vars instead or delete the file after setup.
- Leaked? Reset it in the Developer Portal immediately, the old one dies.
- `.gitignore` excludes `.env*`; `.env.example` is placeholders only.

## License

MIT
