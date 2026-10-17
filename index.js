#!/usr/bin/env node
// discord-bridge-mcp — todo list + friendly progress DMs over Discord.
//
// Config resolution order (first hit wins):
//   1. env DISCORD_TOKEN / DISCORD_USER_ID
//   2. ~/.discord-bridge-mcp.json  (written by `setup` or the setup tool)
// Override the config location with DISCORD_BRIDGE_CONFIG.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, GatewayIntentBits, Partials } from "discord.js";

const VERSION = "2.0.0";
const CONFIG_PATH =
  process.env.DISCORD_BRIDGE_CONFIG || join(homedir(), ".discord-bridge-mcp.json");
const DEFAULT_PERSONALITY = "warm, encouraging, brief — like a friend cheering you on";

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
const TOKEN = process.env.DISCORD_TOKEN || config.token;
const USER_ID = process.env.DISCORD_USER_ID || config.userId;
const PERSONALITY = process.env.DISCORD_PERSONALITY || config.personality || DEFAULT_PERSONALITY;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  // Needed so react() can resolve a fetched DM message's reaction collector.
  partials: [Partials.Message],
});
const todos = [];

// Lazy login: setup CLI needs to log in itself, and the server must start
// unconfigured so the setup tool can be called.
let ready = null;
const loggedIn = () => (ready ??= client.login(TOKEN).catch((e) => { throw new Error(`login failed: ${e.message}`); }));

const ok = (text) => ({ content: [{ type: "text", text }] });

// Bulk delete the bot's own recent DMs. 99+ means "everything".
// Deletes one by one on purpose: bulkDelete needs Manage Messages, which bots
// don't get in DM channels.
async function clearMessages(count) {
  const user = await client.users.fetch(USER_ID).catch(() => null);
  if (!user) throw new Error("User not found — check DISCORD_USER_ID");
  const ch = await user.createDM();
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

async function dm(text, emojis = []) {
  if (!USER_ID) throw new Error("DISCORD_USER_ID not set — run setup");
  const user = await client.users.fetch(USER_ID).catch(() => null);
  if (!user) throw new Error("User not found — check DISCORD_USER_ID");
  const msg = await user.send(text.slice(0, 2000)); // Discord DM hard limit
  for (const e of emojis) await msg.react(e).catch(() => {});
  return `DM sent${emojis.length ? ` +${emojis.length} reaction(s)` : ""}`;
}

// ---------------------------------------------------------------- CLI: setup
if (process.argv[2] === "setup") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, fallback) =>
    new Promise((res) => rl.question(`${q}${fallback ? ` [${fallback}]` : ""}: `, (a) => res(a.trim() || fallback || "")));
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
    await user.send(`👋 Setup complete. I'm your agent sidekick — I'll send you progress here.`);
    console.log(`OK — signed in as ${client.user.tag}, DM'd ${user.tag}`);
  } catch (e) {
    console.error("Setup saved but login failed:", e.message);
    process.exit(1);
  }
  process.exit(0);
}

// --------------------------------------------------------------- MCP server
const server = new Server(
  { name: "discord-bridge-mcp", version: VERSION },
  { capabilities: { tools: {} } }
);

const voiceNote = ` Write the message yourself, in this voice: ${PERSONALITY}. Emoji are welcome in the text.`;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "setup",
      description:
        "Configure the Discord bridge. Call this FIRST if setup_is_configured is false — collect the bot token and the user's Discord user ID from them, then pass them here. Saves to disk so it persists.",
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
        "Check whether the bridge is configured. Returns setup_is_configured=false and instructions when it is not.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "progress_report",
      description: `Send the user a progress DM.${voiceNote}`,
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "The message, written in the agent's own voice" },
          emojis: {
            type: "array",
            items: { type: "string" },
            description: "Optional emoji to react with, e.g. [\"🔥\",\"✅\"]",
          },
        },
        required: ["message"],
      },
    },
    { name: "todo_add", description: "Add a todo task", inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } },
    { name: "todo_list", description: "List all todo tasks", inputSchema: { type: "object", properties: {} } },
    {
      name: "todo_done",
      description: "Mark a todo task done by index",
      inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
    },
    {
      name: "todo_share",
      description: `Send the todo list to the user as a DM.${voiceNote}`,
      inputSchema: { type: "object", properties: { emojis: { type: "array", items: { type: "string" } } } },
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
      saveConfig({
        ...config,
        token: args.token,
        userId: args.user_id,
        personality: args.personality || config.personality || DEFAULT_PERSONALITY,
      });
      config = loadConfig();
      return ok("Saved. Restart the MCP server to sign in with the new token.");
    }
    if (name === "setup_status") {
      return ok(
        JSON.stringify({
          setup_is_configured: Boolean(TOKEN && USER_ID),
          config_path: CONFIG_PATH,
          personality: PERSONALITY,
          hint: !TOKEN || !USER_ID ? "Ask the user for a bot token + their Discord user ID, then call setup." : null,
        })
      );
    }
    if (name === "progress_report") {
      if (!TOKEN) return ok("Not configured yet — call setup first.");
      await loggedIn();
      return ok(await dm(args.message, args.emojis || []));
    }
    if (name === "clear_messages") {
      if (!TOKEN) return ok("Not configured yet — call setup first.");
      await loggedIn();
      return ok(await clearMessages(args.count));
    }
    if (name === "todo_share") {
      if (!TOKEN) return ok("Not configured yet — call setup first.");
      await loggedIn();
      const list = todos.length
        ? todos.map((t, i) => `${t.done ? "✅" : "⬜️"} ${i}. ${t.task}`).join("\n")
        : "Nothing on the list yet.";
      return ok(await dm(`📋 Here's where we are:\n${list}`, args.emojis || []));
    }
    if (name === "todo_add") {
      todos.push({ task: args.task, done: false });
      return ok(`Added: ${args.task}`);
    }
    if (name === "todo_list") {
      return ok(
        todos.length
          ? todos.map((t, i) => `${i}. [${t.done ? "x" : " "}] ${t.task}`).join("\n")
          : "No tasks"
      );
    }
    if (name === "todo_done") {
      const t = todos[args.index];
      if (!t) return ok("Not found");
      t.done = true;
      return ok(`Done: ${t.task}`);
    }
    return ok("Unknown tool");
  } catch (e) {
    return ok(`Error: ${e.message}`);
  }
});

await server.connect(new StdioServerTransport());
console.error("MCP server running on stdio");