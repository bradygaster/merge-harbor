// Development harness: run the MCP server the way Claude Code does and expose its tools
// on a loopback bridge, so you (or an agent) can play Claude's side by hand.
//
//   node scripts/claude-dev.mjs                 data in .preview/claude/ (gitignored)
//   POST http://127.0.0.1:4327/tools/<name>   body: the tool's JSON arguments
//
// Open the canvas with:  curl -X POST http://127.0.0.1:4327/tools/merge_harbor_open_canvas -d "{}"
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridgePort = Number.parseInt(process.env.MERGE_HARBOR_BRIDGE_PORT ?? "", 10) || 4327;
const server = spawn(process.execPath, [join(root, "claude", "server", "mcp.mjs")], {
    env: { ...process.env, MERGE_HARBOR_HOME: process.env.MERGE_HARBOR_HOME ?? join(root, ".preview", "claude") },
    stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let buffer = "";
let nextId = 1;
server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
    }
});
function request(method, params) {
    const id = nextId++;
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((done) => pending.set(id, done));
}

await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "merge-harbor-dev", version: "0" } });
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

createServer(async (req, res) => {
    const reply = (status, value) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value, null, 2));
    };
    if (req.method === "GET" && req.url === "/tools") return reply(200, (await request("tools/list")).result);
    const match = req.method === "POST" && req.url?.match(/^\/tools\/([\w-]+)$/);
    if (!match) return reply(404, { error: "POST /tools/<name> or GET /tools" });
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = await request("tools/call", { name: match[1], arguments: JSON.parse(body || "{}") });
    reply(message.error ? 400 : 200, message.error ?? message.result);
}).listen(bridgePort, "127.0.0.1", () => {
    process.stderr.write(`[dev] MCP tool bridge: http://127.0.0.1:${bridgePort}/tools/<name>\n`);
});

process.on("SIGINT", () => server.stdin.end());
server.on("exit", () => process.exit(0));
