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
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AttachmentBuilder, Client, EmbedBuilder, GatewayIntentBits, Partials } from "discord.js";
import { ActivityType } from "discord-api-types/v10";

const VERSION = "3.3.0";
const DEFAULT_PERSONALITY = "warm, encouraging, brief, like a friend cheering you on";
const MAX_UPLOAD = 25 * 1024 * 1024; // Discord's bot attachment cap: 25 MB
const MAX_DOWNLOAD = 50 * 1024 * 1024; // guard against filling the disk with user files
const TEXT_EXT = /\.(txt|md|json|csv|log|xml|html?|js|ts|py|ya?ml|ini|env|sql|sh)$/i;
const MAX_PROFILE_IMAGE = 10 * 1024 * 1024; // avatars, banners, app icons and covers
const PROFILE_IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp"];
const PRESENCE_STATUSES = ["online", "idle", "dnd", "invisible"];

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

// Hex strings, #rgb shorthand and a few named colors, all resolved to the
// integer Discord wants. Unknown names fail loudly instead of silently
// dropping the color the agent chose.
function parseColor(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value;
  const s = String(value).trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(s)) return parseInt(s.replace("#", ""), 16);
  if (/^#?[0-9a-fA-F]{3}$/.test(s)) {
    const h = s.replace("#", "");
    return parseInt(h.split("").map((c) => c + c).join(""), 16);
  }
  const named = {
    red: 0xed4245, green: 0x57f287, blue: 0x3498db, blurple: 0x5865f2,
    yellow: 0xfee75c, orange: 0xfaa61c, purple: 0x9b59b6, gold: 0xf1c40f,
    grey: 0x99aab5, gray: 0x99aab5, white: 0xffffff, black: 0x000000,
  };
  const found = named[s.toLowerCase()];
  if (found === undefined) throw new Error(`Unknown embed color "${value}". Use #RRGGBB or red/green/blue/yellow/orange/purple/gold/grey/white/black.`);
  return found;
}

// One builder for both send_embed and set_status. Discord silently rejects
// oversized embeds, so cap the individual parts and check the 6000-char total.
function makeEmbed(args) {
  const keys = ["title", "description", "fields", "color", "url", "footer"];
  if (!keys.some((k) => args[k] !== undefined && args[k] !== null && args[k] !== "")) return null;
  const embed = new EmbedBuilder();
  if (args.title) embed.setTitle(String(args.title).slice(0, 256));
  if (args.description) embed.setDescription(String(args.description).slice(0, 4096));
  if (args.url) embed.setURL(String(args.url));
  const color = parseColor(args.color);
  if (color !== undefined) embed.setColor(color);
  if (args.footer) embed.setFooter({ text: String(args.footer).slice(0, 2048) });
  if (Array.isArray(args.fields) && args.fields.length) {
    embed.addFields(args.fields.slice(0, 25).map((f) => ({
      name: String(f?.name ?? "—").slice(0, 256) || "—",
      value: String(f?.value ?? "—").slice(0, 1024) || "—",
      inline: Boolean(f?.inline),
    })));
  }
  const d = embed.data;
  const total =
    String(d.title ?? "").length + String(d.description ?? "").length +
    String(d.footer?.text ?? "").length +
    (d.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
  if (total > 6000) {
    throw new Error(`Embed is ${total} chars; Discord allows 6000. Trim the title, fields or description.`);
  }
  if (!d.title && !d.description && !d.footer?.text && !d.fields?.length && !d.url) {
    throw new Error("Embed has nothing to show. Add a title, description, fields, url or footer.");
  }
  return embed;
}

function safeFileName(name) {
  return String(name || "attachment.bin").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "attachment.bin";
}

function saveStatusId(id) {
  config = { ...config, statusMessageId: id };
  saveConfig(config);
}

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

// Profile art must be real image bytes: a data URL, a renamed .txt or a wrong
// path fails here with one clear message instead of a confusing 400 from Discord.
function profileImage(src, label) {
  // A bare string is a path, unless it is a data URL (then it is the bytes).
  if (typeof src === "string") src = src.startsWith("data:") ? { data: src } : { path: src };
  if (!src || (!src.path && !src.data)) {
    throw new Error(`${label}: pass { path } or { data, filename }.`);
  }
  let buf, name;
  if (src.path) {
    let p = String(src.path);
    if (p.startsWith("~")) p = join(homedir(), p.slice(1));
    p = resolve(p);
    if (!existsSync(p)) throw new Error(`${label}: file not found: ${p}`);
    buf = readFileSync(p);
    name = basename(p);
  } else {
    const b64 = String(src.data).trim().replace(/^data:[^,]*base64,/, "").replace(/\s/g, "");
    buf = Buffer.from(b64, "base64");
    name = src.filename || `${label}.png`;
  }
  if (!buf.length) throw new Error(`${label}: "${name}" is empty or not valid base64.`);
  if (buf.length > MAX_PROFILE_IMAGE) {
    throw new Error(`${label}: ${(buf.length / 1048576).toFixed(1)} MB is over the ${MAX_PROFILE_IMAGE / 1048576} MB cap.`);
  }
  const ext = String(name).toLowerCase().split(".").pop();
  if (!PROFILE_IMAGE_EXT.includes(ext)) {
    throw new Error(`${label}: "${name}" is not an image; use png, jpg, jpeg, gif or webp.`);
  }
  const problem = imageDataCheck(buf, name);
  if (problem) throw new Error(`${label}: ${problem}`);
  return { buf, name };
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
  let sent;
  try {
    sent = await ch.send({ content: message || undefined, files: [file] });
  } catch (e) {
    throw new Error(`${e.message}${dmHint(e)}`);
  }
  return `Screenshot sent: ${name} (${(bytes / 1024).toFixed(1)} KB, msg ${sent.id})`;
}

// The gateway pushes new DMs instantly; a light poll backs it up if an
// event gets dropped. First matching reply wins, whichever path sees it.
function waitForReply(channel, cutoffTs, timeoutMs) {
  const describe = (m) => ({
    id: m.id,
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
      } [msg:${m.id}]`;
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

async function sendEmbed(args) {
  const embed = makeEmbed(args);
  if (!embed) throw new Error("Nothing to send. Pass title, description, fields or color.");
  const ch = await getChannel();
  try {
    await ch.send({ content: args.message || undefined, embeds: [embed] });
  } catch (e) {
    throw new Error(`${e.message}${dmHint(e)}`);
  }
  return `Embed sent (${embed.data.fields?.length ?? 0} field(s)).`;
}

// Discord renders .md attachments as a formatted document (headings, tables,
// lists, code blocks) instead of a plain-text preview, so long structured
// content that would blow past the 2000-char message cap goes out as a file.
async function sendMarkdown({ markdown, path, filename, message } = {}) {
  if (markdown === undefined && !path) {
    throw new Error('Nothing to send. Pass "markdown" (the text) or "path" (an existing .md file).');
  }
  let body, name;
  if (markdown !== undefined) {
    body = Buffer.from(String(markdown), "utf8");
    name = filename || "update.md";
  } else {
    let p = String(path);
    if (p.startsWith("~")) p = join(homedir(), p.slice(1));
    p = resolve(p);
    if (!existsSync(p)) throw new Error(`File not found: ${p}`);
    body = readFileSync(p);
    name = filename || basename(p);
  }
  if (!body.length) throw new Error("Markdown is empty.");
  if (body.length > MAX_UPLOAD) {
    throw new Error(`Markdown is ${(body.length / 1048576).toFixed(1)} MB; Discord accepts up to 25 MB.`);
  }
  name = safeFileName(name);
  if (!/\.(md|markdown)$/i.test(name)) name += ".md";
  const dir = join(tmpdir(), "discord-bridge-mcp");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${Date.now()}-${name}`);
  writeFileSync(out, body);
  const ch = await getChannel();
  let sent;
  try {
    sent = await ch.send({ content: message || undefined, files: [new AttachmentBuilder(out, { name })] });
  } catch (e) {
    throw new Error(`${e.message}${dmHint(e)}`);
  }
  return `Markdown sent: ${name} (${(body.length / 1024).toFixed(1)} KB, msg ${sent.id}). Discord renders .md attachments as a formatted document.`;
}

// A single status message that gets edited in place, so a long task does not
// flood the DM. Its id lives in the config file, so it survives a restart;
// a stale id (message deleted or wiped by clear_messages) just creates a new one.
async function upsertStatus(args) {
  const ch = await getChannel();
  const text = String(args.message ?? args.description ?? "");
  const embed = makeEmbed({ ...args, description: text });
  if (!embed && !text) throw new Error("Pass message text, or embed fields such as title/fields/color.");
  if (!embed && text.length > 1999) {
    throw new Error("Status text is over 1999 chars. Add a title or fields to send it as an embed, or use send_message.");
  }
  const payload = embed ? { embeds: [embed] } : { content: text };

  let existing = null;
  if (config.statusMessageId) {
    existing = await ch.messages.fetch(config.statusMessageId).catch(() => null);
    if (existing && existing.author?.id !== client.user?.id) existing = null;
  }
  if (existing) {
    try {
      await existing.edit(payload);
      return `Updated live status message (${existing.id}).`;
    } catch (e) {
      if (!/Unknown Message|404|Missing Access|Cannot edit/i.test(e.message)) {
        throw new Error(`${e.message}${dmHint(e)}`);
      }
      config.statusMessageId = null; // stale: fall through and create a fresh one
    }
  }
  let sent;
  try {
    sent = await ch.send(payload);
  } catch (e) {
    throw new Error(`${e.message}${dmHint(e)}`);
  }
  saveStatusId(sent.id);
  for (const e of args.emojis || []) await sent.react(e).catch(() => {});
  return `Created live status message (${sent.id}). Call set_status again to update it in place.`;
}

async function clearStatus() {
  const id = config.statusMessageId;
  if (!id) return "No live status message to clear.";
  config.statusMessageId = null;
  saveConfig(config);
  const ch = await getChannel().catch(() => null);
  if (!ch) return `Forgot status id ${id}.`;
  const msg = await ch.messages.fetch(id).catch(() => null);
  if (msg) await msg.delete().catch(() => {});
  return `Cleared live status message (${id}).`;
}

// Pull a file the user sent back out of the DM and onto disk, so the agent
// can open it (vision on a screenshot, text preview on a log, etc.).
async function readAttachments({ message_id, index = 0, attachment = 0, all = false, save_dir } = {}) {
  const ch = await getChannel();
  let msg;
  if (message_id) {
    msg = await ch.messages.fetch(String(message_id)).catch(() => null);
    if (!msg) throw new Error(`Message ${message_id} not found in this DM. Use the msg id printed by check_replies or ask_question.`);
  } else {
    const msgs = await ch.messages
      .fetch({ limit: 40 })
      .catch((e) => Promise.reject(new Error(`Cannot read DM history (${e.message})`)));
    const theirs = [...msgs.values()]
      .filter((m) => m.author?.id === USER_ID && !m.webhookId)
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    msg = theirs[Math.max(Number(index) || 0, 0)];
    if (!msg) throw new Error("No recent message from the user. Ask them to send a file, or pass message_id.");
  }
  const list = [...(msg.attachments?.values() ?? [])];
  if (!list.length) throw new Error(`Message ${msg.id} has no attachments.`);
  const picks = all ? list : [list[Math.max(Number(attachment) || 0, 0)]].filter(Boolean);
  if (!picks.length) throw new Error(`No attachment at index ${attachment}; this message has ${list.length}.`);

  const dir = save_dir ? resolve(String(save_dir).replace(/^~/, homedir())) : join(tmpdir(), "discord-bridge-mcp");
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (const a of picks) {
    if (a.size > MAX_DOWNLOAD) {
      out.push(`${a.name}: ${(a.size / 1048576).toFixed(1)} MB exceeds the ${MAX_DOWNLOAD / 1048576} MB cap, skipped.`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- one download at a time, bounded by attachment count
    // discord.js v14 has no Attachment.download(), so fetch the CDN url directly.
    let buf;
    try {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      throw new Error(`Download failed for ${a.name} (${e.message})`);
    }
    const path = join(dir, `${msg.id}-${safeFileName(a.name)}`);
    writeFileSync(path, buf);
    const isText = /^text\//i.test(a.contentType || "") || TEXT_EXT.test(a.name || "");
    const preview = isText ? `\nText:\n${buf.toString("utf8").slice(0, 4000)}` : "";
    out.push(`Saved: ${path}\n  name: ${a.name} | size: ${(buf.length / 1024).toFixed(1)} KB | type: ${a.contentType || "unknown"} | message ${msg.id}${preview}`);
  }
  return out.join("\n\n");
}

// Give the bot its own identity: the username shown in DMs, the About Me bio
// (the application description Discord shows on a bot profile), and the art:
// avatar, banner, plus the app icon and cover image in the developer profile.
// Username changes are capped at 2 per hour by Discord.
async function updateProfile(args = {}) {
  const images = ["avatar", "banner", "icon", "cover"].filter(
    (k) => args[k] !== undefined && args[k] !== null && args[k] !== ""
  );
  if (args.name === undefined && args.bio === undefined && !images.length) {
    throw new Error("Nothing to change. Pass name, bio, avatar, banner, icon or cover.");
  }
  await loggedIn();
  const done = [];
  if (args.name !== undefined) {
    const username = String(args.name).trim();
    if (!/^[a-zA-Z0-9._]{2,32}$/.test(username)) {
      throw new Error("Username must be 2-32 characters: letters, numbers, underscore or period.");
    }
    try {
      await client.user.setUsername(username);
    } catch (e) {
      throw new Error(`Username change failed (${e.message}). Discord allows 2 per hour.`);
    }
    done.push(`username → ${username}`);
  }
  if (args.bio !== undefined) {
    const bio = String(args.bio).slice(0, 400);
    try {
      await client.application.edit({ description: bio });
    } catch (e) {
      throw new Error(`Bio change failed (${e.message}).`);
    }
    done.push(`bio → "${bio.length > 60 ? bio.slice(0, 60) + "…" : bio}" (${bio.length} chars)`);
  }
  for (const key of ["avatar", "banner"]) {
    if (args[key] === undefined || args[key] === null || args[key] === "") continue;
    const { buf, name } = profileImage(args[key], key);
    try {
      // eslint-disable-next-line no-await-in-loop -- at most two image calls, each rate-limited
      await (key === "avatar" ? client.user.setAvatar(buf) : client.user.setBanner(buf));
    } catch (e) {
      throw new Error(`${key} change failed (${e.message}).`);
    }
    done.push(`${key} → ${name}`);
  }
  if (args.icon !== undefined || args.cover !== undefined) {
    const patch = {};
    if (args.icon !== undefined && args.icon !== null && args.icon !== "") {
      patch.icon = profileImage(args.icon, "icon").buf;
      done.push("app icon updated");
    }
    if (args.cover !== undefined && args.cover !== null && args.cover !== "") {
      patch.coverImage = profileImage(args.cover, "cover").buf;
      done.push("cover image updated");
    }
    try {
      await client.application.edit(patch);
    } catch (e) {
      throw new Error(`App image change failed (${e.message}).`);
    }
  }
  return `Profile updated: ${done.join("; ")}.`;
}

// The little status line under the bot's name: online/idle/dnd/invisible, and
// the activity text ("Playing …", "Watching …", a custom status, …). Passing an
// empty activity clears it; omitting a field keeps it as it is.
async function setPresence(args = {}) {
  const payload = {};
  if (args.status !== undefined && args.status !== null && args.status !== "") {
    const status = String(args.status).toLowerCase();
    if (!PRESENCE_STATUSES.includes(status)) {
      throw new Error(`status must be one of ${PRESENCE_STATUSES.join(", ")}.`);
    }
    payload.status = status;
  }
  if (args.activity !== undefined) {
    const text = String(args.activity);
    if (!text.trim()) {
      payload.activities = [];
    } else {
      const kind = String(args.activity_type || "playing").toLowerCase();
      const types = {
        playing: ActivityType.Playing,
        streaming: ActivityType.Streaming,
        listening: ActivityType.Listening,
        watching: ActivityType.Watching,
        competing: ActivityType.Competing,
        custom: ActivityType.Custom,
      };
      if (!(kind in types)) {
        throw new Error(`activity_type must be one of ${Object.keys(types).join(", ")}.`);
      }
      const activity = { name: text.slice(0, 128), type: types[kind] };
      if (kind === "streaming") {
        // Discord only renders the purple "Live" style when a Twitch/YouTube
        // url is attached; without one the same payload shows as Playing.
        if (!args.activity_url) {
          throw new Error("streaming needs activity_url (a twitch.tv or youtube.com link); without it Discord shows the activity as Playing.");
        }
        activity.url = String(args.activity_url);
      }
      payload.activities = [activity];
    }
  }
  if (!("status" in payload) && !("activities" in payload)) {
    throw new Error("Pass status, activity, or both.");
  }
  // Read the label before setPresence: for a custom activity discord.js rewrites
  // name to "Custom Status" in place, so the object no longer holds what we set.
  const activityLabel = "activities" in payload && payload.activities.length ? payload.activities[0].name : null;
  await loggedIn();
  await client.user.setPresence(payload);
  const parts = [];
  if (payload.status) parts.push(`status ${payload.status}`);
  if ("activities" in payload) {
    parts.push(activityLabel ? `activity "${activityLabel}"` : "activity cleared");
  }
  return `Presence set: ${parts.join(", ")}.`;
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
  saveConfig({ ...config, token, userId, personality, statusMessageId: userId === USER_ID ? config.statusMessageId : null });
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
      name: "send_embed",
      description:
        "Send a rich Discord embed for updates that need scanning. Pass title, description, fields ([{name, value, inline}]), color (#RRGGBB or red/green/blue/yellow/orange/purple/gold/grey/white/black), url and footer. Optional message adds plain text above the card. Discord caps: 25 fields, 6000 characters total; longer values are trimmed with a clear error.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, value: { type: "string" }, inline: { type: "boolean" } },
              required: ["name", "value"],
            },
          },
          color: { type: "string", description: "Hex #RRGGBB or a named color" },
          url: { type: "string" },
          footer: { type: "string" },
          message: { type: "string", description: "Optional plain text above the embed" },
        },
      },
    },
    {
      name: "send_markdown",
      description:
        "Send long or richly structured content as a .md attachment. Discord renders .md files as a formatted document (GitHub-style headings, tables, lists, checklists, code blocks), so this beats the 2000-character message cap and keeps formatting. Use it for digests, plans, docs, changelogs, comparison tables. Pass markdown source, or path to an existing .md file; optional message is a short caption above it.",
      inputSchema: {
        type: "object",
        properties: {
          markdown: { type: "string", description: "Markdown source to send" },
          path: { type: "string", description: "Path to an existing .md file instead of inline markdown" },
          filename: { type: "string", description: 'Attachment name; ".md" is added if missing (default update.md)' },
          message: { type: "string", description: "Optional caption above the attachment" },
        },
      },
    },
    {
      name: "set_status",
      description:
        "Create or update ONE live status message in the DM instead of sending a new progress DM each time. The first call creates it, later calls edit it in place, and the id persists across restarts. Pass message text for a plain status, or title/fields/color/url/footer for a status card. If the message was deleted or wiped with clear_messages, the next call creates a fresh one. Emojis are applied only when the message is first created.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Status text (plain content, or embed description when card fields are present)" },
          title: { type: "string" },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, value: { type: "string" }, inline: { type: "boolean" } },
              required: ["name", "value"],
            },
          },
          color: { type: "string", description: "Hex #RRGGBB or a named color" },
          url: { type: "string" },
          footer: { type: "string" },
          emojis: { type: "array", items: { type: "string" }, description: "Optional reactions on creation" },
        },
      },
    },
    {
      name: "clear_status",
      description: "Delete the live status message created by set_status and forget its id. Safe to call when there is none.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "read_attachments",
      description:
        "Download a file the user sent back in the Discord DM and save it locally so the agent can open it. Pass message_id (printed by check_replies and ask_question) to target a message, or index (0 = newest user message) when you do not have an id. Use attachment to pick which file, or all:true to grab them all. Returns the saved path, size and type; text files are also previewed inline. Files over 50 MB are skipped.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "Discord message id to read attachments from" },
          index: { type: "number", description: "Which recent user message to use when no message_id is given (0 = newest)" },
          attachment: { type: "number", description: "Which attachment on that message (0 = first)" },
          all: { type: "boolean", description: "Download every attachment on the message" },
          save_dir: { type: "string", description: "Where to save; defaults to a temp folder" },
        },
      },
    },
    {
      name: "update_profile",
      description:
        "Give the bot its own identity. Change any of: name (the bot's username, 2-32 chars, 2 changes/hour max), bio (the About Me text on its Discord profile, up to 400 chars), avatar and banner (its profile art), icon and cover (its developer-profile art). Image fields take { path } for a local file or { data, filename } for base64, and must be png/jpg/gif/webp under 10 MB. Everything is optional; only what you pass changes. BIO IS DECORATION ONLY: a cool line, a vibe, taste in things. It is never a reply, a question, an announcement or a way to talk to the user; use send_message, progress_report or ask_question for anything they need to read.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "New bot username (2-32 chars: letters, numbers, _, .)" },
          bio: {
            type: "string",
            description:
              "Profile flavor only (max 400 chars): a cool line, vibe, taste, something aesthetic. Never a reply, question or message to the user. Empty clears it.",
          },
          avatar: {
            type: "object",
            description: "New avatar image",
            properties: {
              path: { type: "string", description: "Local image file (absolute or ~)" },
              data: { type: "string", description: "Base64 bytes or a data URL, with filename" },
              filename: { type: "string", description: "Name for data (extension decides the type)" },
            },
          },
          banner: {
            type: "object",
            description: "New profile banner image",
            properties: {
              path: { type: "string" },
              data: { type: "string" },
              filename: { type: "string" },
            },
          },
          icon: {
            type: "object",
            description: "Application icon (the art next to the app name)",
            properties: {
              path: { type: "string" },
              data: { type: "string" },
              filename: { type: "string" },
            },
          },
          cover: {
            type: "object",
            description: "Application cover image (developer profile header)",
            properties: {
              path: { type: "string" },
              data: { type: "string" },
              filename: { type: "string" },
            },
          },
        },
      },
    },
    {
      name: "set_presence",
      description:
        "Set the bot's live presence: status (online, idle, dnd, invisible) and/or the activity line under its name (activity + activity_type playing/watching/listening/streaming/competing/custom). Omitting a field keeps the current value; an empty activity clears it. PURELY AESTHETIC: use it for a mood, a cool fun fact, or a tiny hint of progress ('3/7 tests left'). Never use it to ask or answer the user or carry a message; use send_message, progress_report or set_status for anything they need to read. This is not the DM status message (that is set_status).",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["online", "idle", "dnd", "invisible"],
            description: "Aesthetic status dot; not a communication channel",
          },
          activity: {
            type: "string",
            description:
              "Decorative line only: a vibe, a cool fun fact, or a small progress hint. Not a place to talk to the user. Empty clears it.",
          },
          activity_type: {
            type: "string",
            enum: ["playing", "watching", "listening", "streaming", "competing", "custom"],
            description: "How the activity reads; defaults to playing",
          },
          activity_url: {
            type: "string",
            description: "Twitch or YouTube link; required for streaming so Discord renders the Live style",
          },
        },
      },
    },
    {
      name: "ask_question",
      description:
        "Ask the user a question over Discord DM and wait for their reply, detected in real time via gateway events. Only counts replies that arrive AFTER the question, never an old message. If no reply arrives within timeout_ms (default 60000, max 600000), returns no reply plus default_answer so you can continue with your own judgment. Ask one question at a time in the same DM. The reply includes a msg id you can pass to read_attachments when they answer with a file.",
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
        "Non-blocking peek at the user's Discord DM replies. INCREMENTAL by default: returns only messages newer than your last check, so old answers never resurface; empty result means nothing new. Pass all:true to browse history instead, or since_minutes:N for a one-off wider window. Each line ends with [msg:id], which read_attachments accepts to download any file on that message.",
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
      // A status message belongs to one user's DM: drop the old id if the user changed.
      if (newUserId !== USER_ID) config = { ...config, statusMessageId: null };
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
    if (name === "send_embed") {
      return ok(await sendEmbed(args));
    }
    if (name === "send_markdown") {
      return ok(await sendMarkdown(args));
    }
    if (name === "set_status") {
      return ok(await upsertStatus(args));
    }
    if (name === "clear_status") {
      return ok(await clearStatus());
    }
    if (name === "read_attachments") {
      return ok(await readAttachments(args));
    }
    if (name === "update_profile") {
      return ok(await updateProfile(args));
    }
    if (name === "set_presence") {
      return ok(await setPresence(args));
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
        ? `${reply.content || "(no text)"}${reply.attachments.length ? ` [attachment: ${reply.attachments.join(", ")}]` : ""} (from ${reply.from} at ${reply.at}, msg ${reply.id})`
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
