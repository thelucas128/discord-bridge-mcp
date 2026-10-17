import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, GatewayIntentBits } from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN;
const USER_ID = process.env.DISCORD_USER_ID;
if (!TOKEN) throw new Error("DISCORD_TOKEN env var required");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const todos = [];

client.on("ready", () => console.log("Discord client ready"));
client.login(TOKEN).catch((e) => console.error("Discord login failed:", e.message));

const server = new Server(
  { name: "discord-bridge-mcp", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "todo_add",
      description: "Add a todo task",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
      },
    },
    {
      name: "todo_list",
      description: "List all todo tasks",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "todo_done",
      description: "Mark a todo task done by index",
      inputSchema: {
        type: "object",
        properties: { index: { type: "number" } },
        required: ["index"],
      },
    },
    {
      name: "progress_report",
      description: "Send agent progress via Discord DM",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "todo_add") {
    todos.push({ task: args.task, done: false });
    return { content: [{ type: "text", text: `Added: ${args.task}` }] };
  }
  if (name === "todo_list") {
    const text = todos.length
      ? todos.map((t, i) => `${i}. [${t.done ? "x" : " "}] ${t.task}`).join("\n")
      : "No tasks";
    return { content: [{ type: "text", text }] };
  }
  if (name === "todo_done") {
    const t = todos[args.index];
    if (!t) return { content: [{ type: "text", text: "Not found" }] };
    t.done = true;
    return { content: [{ type: "text", text: `Done: ${t.task}` }] };
  }
  if (name === "progress_report") {
    if (!USER_ID) {
      return { content: [{ type: "text", text: "DISCORD_USER_ID not set" }] };
    }
    const user = await client.users.fetch(USER_ID).catch(() => null);
    if (!user) return { content: [{ type: "text", text: "User not found" }] };
    await user.send(args.message);
    return { content: [{ type: "text", text: "DM sent" }] };
  }
  return { content: [{ type: "text", text: "Unknown tool" }] };
});

await server.connect(new StdioServerTransport());
console.log("MCP server running on stdio");
