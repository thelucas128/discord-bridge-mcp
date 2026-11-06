#!/usr/bin/env node
// discord-bridge-mcp: todo list, progress DMs, screenshots and two-way
// chat between an agent and its user, over Discord.
//
// Config resolution order (first hit wins):
//   1. env DISCORD_TOKEN / DISCORD_USER_ID (plain TOKEN also accepted)
//   2. a .env file next to index.js or in the cwd (parsed once, no deps)
//   3. ~/.discord-bridge-mcp.json  (written by `setup` or the setup tool)
// Override the config location with DISCORD_BRIDGE_CONFIG.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AttachmentBuilder, Client, GatewayIntentBits, Partials } from "discord.js";

const VERSION = "3.0.0";
const DEFAULT_PERSONALITY = "warm, encouraging, brief, like a friend cheering you on";
const MAX_UPLOAD = 25 * 1024 * 1024; // Discord's bot attachment cap: 25 MB

// Some users keep the token in a .env next to the server. Fill keys that the
// real environment does not already set, so the client always wins.
function readDotEnv() {
  for (const dir of [dirname(fileURLToPath(import.meta.url)), process.cwd()]) {
    let raw;
    try {
      raw = readFileSync(join(dir, ".env"), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}
readDotEnv();

const CONFIG_PATH =
  process.env.DISCORD_BRIDGE_CONFIG || join(homedir(), ".discord-bridge-mcp.json");

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
let TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN || config.token || "";
let USER_ID = String(process.env.DISCORD_USER_ID || config.userId || "").trim();
let PERSONALITY =
  process.env.DISCORD_PERSONALITY || config.personality || DEFAULT_PERSONALITY;

const todos = Array.isArray(config.todos) ? config.todos : [];
function persistTodos() {
  config = { ...config, todos };
  saveConfig(config);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  // Needed so react() can resolve a fetched DM message's reaction collector.
  partials: [Partials.Message],
});

// Lazy login: setup CLI needs to log in itself, and the server must start
// unconfigured so the setup tool can be called.
let ready = null;
async function doLogin() {
  try {
    await client.login(TOKEN);
  } catch (e) {
    ready = null; // a failed login must be retryable, not cached forever
    throw new Error(`login failed: ${e.message}`);
  }
}
const loggedIn = () => (ready ??= doLogin());

// The app id is the base64 first segment of the bot token, so the OAuth
// invite URL is available before any login happens.
function oauthInvite(token = TOKEN) {
  try {
    const id = Buffer.from((token || "").split(".")[0] || "", "base64").toString("ascii");
    if (!/^\d{15,21}$/.test(id)) return null;
    // View Channels + Add Reactions + Send Messages + Embed Links + Attach Files + Read Message History
    return `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=117824`;
  } catch {
    return null;
  }
}

const ok = (text) => ({ content: [{ type: "text", text }] });

// One user fetch + DM channel fetch per user, cached: every later send
// becomes a single API roundtrip instead of three.
let dmCache = null;
async function getChannel() {
  if (!TOKEN) throw new Error("Bot token missing. Ask the user for it, then call setup.");
  if (!USER_ID) throw new Error("User ID missing. Ask for their Discord user ID, then call setup.");
  if (dmCache?.userId === USER_ID) return dmCache.channel;
  await loggedIn();
  try {
    const user = await client.users.fetch(USER_ID);
    const channel = await user.createDM();
    dmCache = { userId: USER_ID, channel };
    return channel;
  } catch (e) {
    dmCache = null;
    throw new Error(`Cannot reach user ${USER_ID} (${e.message})`);
  }
}

// Newest message the server has seen in the user's DM thread, so "new reply"
// checks never resurface history. Scoped to DM channels: a guild event must
// not advance the DM baseline.
let lastSeenTs = 0;
client.on("messageCreate", (m) => {
  if (m.channel?.isDMBased?.()) lastSeenTs = Math.max(lastSeenTs, m.createdTimestamp);
});

async function ensureBaseline(channel) {
  if (lastSeenTs) return;
  try {
    const last = await channel.messages.fetch({ limit: 1 });
    lastSeenTs = last.first?.()?.createdTimestamp ?? 0;
  } catch {
    // no history reachable; 0 keeps "new" == "from now on"
  }
}

// Discord 50007 means the bot cannot DM the user, which is almost always a
// missing shared server; point at the invite URL instead of a dead end.
function dmHint(e) {
  return /Cannot send messages|50007/.test(e?.message || "")
    ? ` Invite the bot to a server you are both in: ${oauthInvite() ?? "(call setup to get the invite URL)"}.`
    : "";
}

// Split long text at line breaks under the 2000-char API cap instead of
// silently truncating what the agent wrote.
function chunkText(text) {
  const out = [];
  let rest = text;
  while (rest.length > 1999) {
    let cut = rest.lastIndexOf("\n", 1980);
    if (cut < 1000) cut = 1980;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

// Sends the text verbatim: no prefix, no template, the agent wrote every
// word. Reactions land on the final message.
async function sendText(text, emojis = []) {
  const ch = await getChannel();
  const parts = chunkText(String(text ?? ""));
  let last;
  try {
    for (const part of parts) last = await ch.send(part);
  } catch (e) {
    throw new Error(`${e.message}${dmHint(e)}`);
  }
  for (const e of emojis) await last.react(e).catch(() => {});
  return `Sent (${parts.length} message${parts.length > 1 ? "s" : ""})`;
}

// The agent may hand over a data URL, a JSON dump or a bytes-wrong file;
// catching it here saves the user a broken preview in Discord.
function imageDataCheck(buf, name) {
  if (!buf.length) return "the file is 0 bytes";
  const ext = String(name).toLowerCase().split(".").pop();
  if (!["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return null; // generic file, no claim to verify
  const looks = {
    png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
    jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    gif: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
    webp: (b) => b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  }[ext];
  return looks(buf) ? null : `bytes are not valid ${ext}; likely a data URL or wrong data was passed, decode to raw base64 first`;
}

// path sends a file off disk; data sends base64 bytes under a filename.
// Discord infers the type from the extension, so the name matters.
async function sendAttachment({ path, data, filename, message }) {
  if (!path && !data) {
    throw new Error(
      'Nothing to send. Pass "path" (a local file, absolute or ~) or "data" (base64 bytes) with "filename".'
    );
  }
  let file, bytes, name;
  if (path) {
    let p = String(path);
    if (p.startsWith("~")) p = join(homedir(), p.slice(1));
    p = resolve(p);
    if (!existsSync(p)) throw new Error(`File not found: ${p}`);
    bytes = statSync(p).size;
    name = basename(p);
    // peek the header without loading the whole file
    const fh = openSync(p, "r");
    try {
      const head = Buffer.alloc(16);
      const n = readSync(fh, head, 0, 16, 0);
      const problem = imageDataCheck(head.subarray(0, n), name);
      if (problem) throw new Error(`${name}: ${problem}`);
    } finally {
      closeSync(fh);
    }
    file = new AttachmentBuilder(p, { name });
  } else {
    const b64 = String(data)
      .trim()
      .replace(/^data:[^,]*base64,/, "") // data URLs wrap the payload: keep the raw part only
      .replace(/\s/g, "");
    const buf = Buffer.from(b64, "base64");
    const problem = imageDataCheck(buf, filename || "screenshot.png");
    if (problem) throw new Error(`${filename || "screenshot.png"}: ${problem}`);
    bytes = buf.length;
    name = filename || "screenshot.png";
    file = new AttachmentBuilder(buf, { name });
  }
  if (bytes > MAX_UPLOAD) {
    throw new Error(
      `${name} is ${(bytes / 1048576).toFixed(1)} MB; Discord accepts up to 25 MB. Trim or compress it.`
    );
  }
  const ch = await getChannel();
  try {
    await ch.send({ content: message || undefined, files: [file] });
  } catch (e) {
    throw new Error(`${e.message}${dmHint(e)}`);
  }
  return `Screenshot sent: ${name} (${(bytes / 1024).toFixed(1)} KB)`;
}

// The gateway pushes new DMs instantly; a light poll backs it up if an
// event gets dropped. First matching reply wins, whichever path sees it.
function waitForReply(channel, cutoffTs, timeoutMs) {
  const describe = (m) => ({
    content: String(m.content ?? "").trim(),
    from: m.author?.username ?? USER_ID,
    attachments: [...(m.attachments?.values() ?? [])].map((a) => a.name),
    ts: m.createdTimestamp,
    at: new Date(m.createdTimestamp).toISOString(),
  });
  const match = (m) =>
    m.author?.id === USER_ID && !m.webhookId && m.createdTimestamp > cutoffTs;
  return new Promise((resolve) => {
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      client.off("messageCreate", onMessage);
      clearInterval(pollTimer);
      clearTimeout(deadline);
      resolve(answer);
    };
    const onMessage = (m) => {
      if (m.channel?.id === channel.id && match(m)) finish(describe(m));
    };
    const sweep = async () => {
      try {
        const msgs = await channel.messages.fetch({ limit: 10 });
        const hit = [...msgs.values()].filter(match).sort((a, b) => a.createdTimestamp - b.createdTimestamp).pop();
        if (hit) finish(describe(hit));
      } catch {
        // next tick retries; a transient failure should not kill the wait
      }
    };
    client.on("messageCreate", onMessage);
    const pollTimer = setInterval(sweep, 5000);
    const deadline = setTimeout(() => finish(null), timeoutMs);
    sweep(); // a reply may already be sitting in the channel
  });
}

// Read-ahead without waiting: only what the user sent since the server last
// looked. `all: true` returns recent history instead, labeled as such, and
// `since_minutes` widens the window for a one-off look further back.
async function recentReplies({ limit = 5, all = false, since_minutes = null } = {}) {
  const ch = await getChannel();
  await ensureBaseline(ch);
  let cutoff = lastSeenTs;
  let scope = `new since last check`;
  if (all) {
    cutoff = -1;
    scope = "recent history (may include old messages)";
  } else if (since_minutes) {
    cutoff = Date.now() - Number(since_minutes) * 60000;
    scope = `new in the last ${since_minutes} min`;
  }
  const msgs = await ch.messages
    .fetch({ limit: 40 })
    .catch((e) => Promise.reject(new Error(`Cannot read DM history (${e.message})`)));
  lastSeenTs = Math.max(lastSeenTs, msgs.first?.()?.createdTimestamp ?? 0);
  const theirs = [...msgs.values()]
    .filter((m) => m.author?.id === USER_ID && !m.webhookId && m.createdTimestamp > cutoff)
    .slice(0, limit);
  if (!theirs.length) {
    return `No replies ${scope}. Use all:true to see history.`;
  }
  const body = theirs
    .map((m) => {
      const at = new Date(m.createdTimestamp).toISOString().slice(11, 16);
      const files = [...(m.attachments?.values() ?? [])].map((a) => a.name);
      return `${at} UTC: ${String(m.content ?? "").trim() || "(no text)"}${
        files.length ? ` [attachment: ${files.join(", ")}]` : ""
      }`;
    })
    .join("\n");
  return `${theirs.length} reply(ies) ${scope}:\n${body}`;
}

// Bulk delete the bot's own recent DMs. 99+ means "everything".
// Deletes one by one on purpose: bulkDelete needs Manage Messages, which bots
// don't get in DM channels.
async function clearMessages(count) {
  const ch = await getChannel();
  const all = count >= 99;
  let deleted = 0;
  let before;
  while (all || deleted < count) {
    // eslint-disable-next-line no-await-in-loop -- sequential deletes, one batch at a time
    const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    for (const m of batch.values()) {
      if (m.author.id !== client.user.id) continue; // only our own messages
      // eslint-disable-next-line no-await-in-loop
      const done = await m.delete().then(() => true).catch(() => false);
      if (done) deleted++;
      if (!all && deleted >= count) break;
    }
    before = batch.last().id;
    if (!all) break; // one fetch covers any count under 99
  }
  return `Deleted ${deleted} message(s)${all ? " (all)" : ""}`;
}

// ---------------------------------------------------------------- CLI: setup
if (process.argv[2] === "setup") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, fallback) =>
    new Promise((res) => rl.question(`${q}${fallback ? ` [${fallback}]` : ""}: `, (a) => res(a.trim() || fallback || "")));
  const inv = oauthInvite();
  console.log(
    `Two things needed: (1) your bot token from discord.com/developers/applications, Bot tab, Reset Token, shown once; (2) your Discord user ID, ${
      inv ? "3) the bot must share a server with you to DM you: " + inv : ""
    }`
  );
  const token = await ask("Discord bot token");
  const userId = await ask("Your Discord user ID");
  const personality = await ask("Agent personality (tone)", config.personality || DEFAULT_PERSONALITY);
  rl.close();
  saveConfig({ ...config, token, userId, personality });
  config = loadConfig();
  console.log(`Saved to ${CONFIG_PATH}`);
  try {
    await client.login(token);
    const user = await client.users.fetch(userId);
    await user.send("👋 Setup complete. I'm your agent sidekick, I'll send progress here. You can just talk to me here too.");
    console.log(`OK — signed in as ${client.user.tag}, DM'd ${user.tag}`);
  } catch (e) {
    console.error("Setup saved but login failed:", e.message);
    const url = oauthInvite(token);
    if (url) console.error(`Invite the bot to a server you are in, then retry: ${url}`);
    process.exit(1);
  }
  process.exit(0);
}

// --------------------------------------------------------------- MCP server
const server = new Server(
  { name: "discord-bridge-mcp", version: VERSION },
  { capabilities: { tools: {} } }
);

// Folded into tool descriptions at list time, so a personality change
// takes effect on the next tools/list without a restart.
const voice = () => ` Write the message yourself, in this voice: ${PERSONALITY}. Emoji welcome in the text.`;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "setup",
      description:
        "Configure the Discord bridge. Call this FIRST if setup_is_configured is false. Collect from the user: (1) their bot token, from discord.com/developers/applications, their app, Bot tab, Reset Token, Discord shows it once; (2) their Discord user ID, Developer Mode, right-click themselves, Copy User ID. The bot DMs the user, so it must share a server with them: use the returned invite URL. Saves to disk and applies live, no restart needed.",
      inputSchema: {
        type: "object",
        properties: {
          token: { type: "string", description: "Discord bot token" },
          user_id: { type: "string", description: "The user's numeric Discord user ID" },
          personality: { type: "string", description: "Tone the agent should use in DMs" },
        },
        required: ["token", "user_id"],
      },
    },
    {
      name: "setup_status",
      description:
        "Check whether the bridge is configured. Returns setup_is_configured and the bot's OAuth invite URL (the bot needs to be in a server shared with the user). Returns an instructions hint when not configured.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "progress_report",
      description: `Send the user a progress DM. Report what actually happened: exact numbers, file paths, what changed, what failed. Accuracy beats cheerleading.${voice()}`,
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "The message, written in the agent's own voice" },
          emojis: {
            type: "array",
            items: { type: "string" },
            description: 'Optional emoji to react with, e.g. ["🔥","✅"]',
          },
        },
        required: ["message"],
      },
    },
    {
      name: "send_message",
      description: `DM the user. Delivered exactly as written, no prefix, no template.${voice()}`,
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "The exact text to send, already fully written" },
          emojis: { type: "array", items: { type: "string" }, description: "Optional emoji to react with" },
        },
        required: ["message"],
      },
    },
    {
      name: "send_screenshot",
      description:
        'Show the user what you just did: push a screenshot or file over Discord. Pass "path" (a local file, absolute or starting with ~) or "data" (base64 bytes) with "filename". Accepts png, jpg, gif, webp, or any file up to 25 MB; image bytes are validated, so a data URL or corrupt dump fails fast with a clear error instead of a broken preview. Use it when seeing beats reading: UI changes, diagrams, error screens, previews. Add a one-line caption via "message".',
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Local file path (absolute, or ~ allowed)" },
          data: { type: "string", description: "Raw base64 image bytes as alternative to path" },
          filename: { type: "string", description: 'Name for uploaded data, defaults "screenshot.png"' },
          message: { type: "string", description: "Optional caption sent with the upload" },
        },
      },
    },
    {
      name: "ask_question",
      description:
        "Ask the user a question over Discord DM and wait for their reply, detected in real time via gateway events. Only counts replies that arrive AFTER the question, never an old message. If no reply arrives within timeout_ms (default 60000, max 600000), returns no reply plus default_answer so you can continue with your own judgment. Ask one question at a time in the same DM.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask the user" },
          default_answer: {
            type: "string",
            description: "Answer returned when the user does not reply within timeout_ms, so the agent can fall back to its default behavior",
          },
          timeout_ms: { type: "number", description: "How long to wait for a reply in ms (default 60000, max 600000)" },
          emojis: { type: "array", items: { type: "string" }, description: "Optional emoji to react with on the question" },
        },
        required: ["question"],
      },
    },
    {
      name: "check_replies",
      description:
        "Non-blocking peek at the user's Discord DM replies. INCREMENTAL by default: returns only messages newer than your last check, so old answers never resurface; empty result means nothing new. Pass all:true to browse history instead, or since_minutes:N for a one-off wider window.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many recent user messages to show (default 5)" },
          all: { type: "boolean", description: "Show recent history instead of just what is new" },
          since_minutes: { type: "number", description: "Alternative window: show messages newer than N minutes ago" },
        },
      },
    },
    {
      name: "ping",
      description: "Ping the user on Discord (mentions them, fires a phone notification), optionally with a short message.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Optional message to send along with the ping" },
          emojis: { type: "array", items: { type: "string" }, description: "Optional emoji to react with" },
        },
      },
    },
    { name: "todo_add", description: "Add a todo task (persists across restarts)", inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } },
    { name: "todo_list", description: "List all todo tasks", inputSchema: { type: "object", properties: {} } },
    {
      name: "todo_done",
      description: "Mark a todo task done by index",
      inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
    },
    {
      name: "todo_remove",
      description: "Delete a todo task by index (e.g. one that is no longer needed)",
      inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
    },
    {
      name: "todo_reset",
      description: "Clear the whole todo list",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "clear_messages",
      description:
        "Delete the bot's own recent Discord DMs. count = how many; 99 or more clears the entire DM history. Use when the user says '/clear-discordmessage', 'clear my discord messages', or 'wipe the discord log'.",
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "number", description: "How many recent bot messages to delete. 99+ = everything." },
        },
        required: ["count"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "setup") {
      const newToken = String(args.token || "").trim();
      const newUserId = String(args.user_id || "").trim();
      if (!newToken || !newUserId) {
        return ok("Both token and user_id are required. Ask the user for the bot token and their Discord user ID.");
      }
      PERSONALITY = args.personality || PERSONALITY;
      saveConfig({ ...config, token: newToken, userId: newUserId, personality: PERSONALITY });
      config = loadConfig();
      // Env vars win over the saved file until the process restarts.
      const envToken = process.env.DISCORD_TOKEN || process.env.TOKEN;
      const switched = !envToken && newToken !== TOKEN;
      TOKEN = envToken || newToken;
      USER_ID = process.env.DISCORD_USER_ID || newUserId;
      dmCache = null; // the user may have changed; refetch
      if (switched && ready) {
        ready = null;
        await client.destroy().catch(() => {});
      }
      let note = "";
      try {
        await sendText("👋 Setup complete, live. Progress lands here, and you can reply here anytime.");
        note = " Confirmation DM sent.";
      } catch (e) {
        note = ` Could not DM yet (${e.message}).`;
      }
      const inv = oauthInvite();
      return ok(
        `Saved to ${CONFIG_PATH}. No restart needed.${note}${
          inv ? `\nInvite URL (bot must share a server with the user to DM them): ${inv}` : ""
        }`
      );
    }
    if (name === "setup_status") {
      const configured = Boolean(TOKEN && USER_ID);
      const inv = oauthInvite();
      return ok(
        JSON.stringify({
          setup_is_configured: configured,
          invite_url: inv,
          next_steps: configured
            ? null
            : [
                "Ask the user for their bot token: discord.com/developers/applications, their app, Bot tab, Reset Token (shown once).",
                "Ask the user for their Discord user ID: Developer Mode, right-click themselves, Copy User ID.",
                "Call setup with both. The bot DMs the user, so it must also be invited to a server they are in: " + (inv ?? "invite URL appears once the token is set."),
              ],
          personality: PERSONALITY,
          config_path: CONFIG_PATH,
          version: VERSION,
        })
      );
    }
    if (name === "send_message" || name === "progress_report") {
      return ok(await sendText(args.message, args.emojis || []));
    }
    if (name === "send_screenshot") {
      return ok(await sendAttachment(args));
    }
    if (name === "ask_question") {
      const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 60000, 3000), 600000);
      const ch = await getChannel();
      await ensureBaseline(ch);
      // cutoff = everything already in the thread, so an old message can
      // never be mistaken for the answer to this question
      let sent;
      try {
        sent = await ch.send(String(args.question));
        for (const e of args.emojis || []) await sent.react(e).catch(() => {});
      } catch (e) {
        throw new Error(`${e.message}${dmHint(e)}`);
      }
      const cutoff = Math.max(lastSeenTs, sent.createdTimestamp);
      lastSeenTs = Math.max(lastSeenTs, sent.createdTimestamp);
      const reply = await waitForReply(ch, cutoff, timeoutMs);
      if (reply) lastSeenTs = Math.max(lastSeenTs, reply.ts);
      const body = reply
        ? `${reply.content || "(no text)"}${reply.attachments.length ? ` [attachment: ${reply.attachments.join(", ")}]` : ""} (from ${reply.from} at ${reply.at})`
        : `no reply within ${Math.round(timeoutMs / 1000)}s. Default answer used: ${args.default_answer ?? "(none given)"}`;
      return ok(`Answer: ${body}`);
    }
    if (name === "check_replies") {
      return ok(
        await recentReplies({
          limit: Math.max(Number(args.limit) || 5, 1),
          all: Boolean(args.all),
          since_minutes: args.since_minutes || null,
        })
      );
    }
    if (name === "ping") {
      const body = args.message ? `<@${USER_ID}> ${args.message}` : `<@${USER_ID}>`;
      return ok(await sendText(body, args.emojis || []));
    }
    if (name === "clear_messages") {
      return ok(await clearMessages(Number(args.count) || 0));
    }
    if (name === "todo_add") {
      const task = String(args.task ?? "").trim();
      if (!task) return ok("Empty task, nothing added.");
      todos.push({ task, done: false });
      persistTodos();
      return ok(`Added (${todos.length} total): ${task}`);
    }
    if (name === "todo_list") {
      return ok(
        todos.length
          ? todos.map((t, i) => `${i}. [${t.done ? "x" : " "}] ${t.task}`).join("\n")
          : "No tasks."
      );
    }
    if (name === "todo_done") {
      const t = todos[Number(args.index)];
      if (!t) return ok(`No task at index ${args.index}.`);
      t.done = true;
      persistTodos();
      return ok(`Done: ${t.task}`);
    }
    if (name === "todo_remove") {
      const i = Number(args.index);
      if (!todos[i]) return ok(`No task at index ${i}.`);
      const [gone] = todos.splice(i, 1);
      persistTodos();
      return ok(`Removed: ${gone.task}`);
    }
    if (name === "todo_reset") {
      todos.length = 0;
      persistTodos();
      return ok("Todo list cleared.");
    }
    return ok("Unknown tool");
  } catch (e) {
    return ok(`Error: ${e.message}`);
  }
});

await server.connect(new StdioServerTransport());
console.error(`discord-bridge-mcp v${VERSION} running on stdio`);
