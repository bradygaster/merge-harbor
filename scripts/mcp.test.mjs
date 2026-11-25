// Drive the MCP server over stdio the way Claude Code does, without touching GitHub.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMissionStore } from "../extension/assessment-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "merge-harbor-claude-"));
const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

// A mission queued from the canvas before Claude claims it.
const missions = createMissionStore(home);
const queued = missions.create({
    owner: "octodemo",
    name: "harbor-fixture",
    key: "octodemo/harbor-fixture",
    url: "https://github.com/octodemo/harbor-fixture",
    defaultBranch: "main",
    targetSha: "0123456789abcdef0123456789abcdef01234567",
});

const server = spawn(process.execPath, [join(root, "claude", "server", "mcp.mjs")], {
    env: { ...process.env, MERGE_HARBOR_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
server.stderr.on("data", (chunk) => (stderr += chunk));

const pending = new Map();
let stdoutBuffer = "";
server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        const message = JSON.parse(line); // Anything that isn't JSON-RPC on stdout fails here.
        pending.get(message.id)?.(message);
        pending.delete(message.id);
    }
});

let nextId = 1;
function request(method, params) {
    const id = nextId++;
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out. stderr:\n${stderr}`)), 10000);
        pending.set(id, (message) => {
            clearTimeout(timer);
            resolveReply(message);
        });
    });
}
const call = async (name, args = {}) => (await request("tools/call", { name, arguments: args })).result;

try {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert(init.result?.serverInfo?.name === "merge-harbor", "initialize must identify the server.");
    assert(init.result.instructions.includes("Approval to assess is not approval to act"), "Server instructions must carry the approval rule.");
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    // Unknown protocol versions get the newest supported one; non-object JSON must not crash the server.
    const oldInit = await request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    assert(oldInit.result?.protocolVersion === "2025-06-18", "initialize must not echo an unsupported protocol version.");
    const invalid = new Promise((resolveReply) => pending.set(null, resolveReply));
    server.stdin.write("null\n");
    assert((await invalid).error?.code === -32600, "A non-object JSON line must get Invalid Request.");
    assert((await request("ping")).result, "The server must keep running after an invalid line.");
    const closedView = await call("merge_harbor_show_view", { view: "convoy" });
    assert(closedView.isError, "show_view must fail clearly while the canvas is closed.");

    const names = (await request("tools/list")).result.tools.map((tool) => tool.name);
    for (const name of [
        "merge_harbor_get_issue_inventory",
        "merge_harbor_report_issue_triage",
        "merge_harbor_report_repository_assessment",
        "merge_harbor_open_canvas",
        "merge_harbor_show_view",
        "merge_harbor_get_summary",
        "merge_harbor_claim_assessments",
    ]) {
        assert(names.includes(name), `tools/list is missing ${name}.`);
    }

    const opened = await call("merge_harbor_open_canvas", { view: "decisions" });
    const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(opened.content[0].text)?.[0];
    assert(url, "open_canvas must return a loopback URL.");
    const page = await (await fetch(url)).text();
    assert(page.includes('"name":"Claude"'), "The page must be told it runs under Claude.");
    assert(page.includes("Run /merge-harbor:triage"), "The page must show Claude's triage hint.");

    const waiting = missions.read(queued.id);
    assert(waiting.status === "queued" && waiting.phase === "Waiting for Claude", "Claude can't be pushed a prompt, so queued assessments must wait to be claimed.");

    const claimed = (await call("merge_harbor_claim_assessments")).content[0].text;
    assert(claimed.includes(queued.id) && claimed.includes("isolated local clone or disposable worktree"), "Claiming must return the mission's full safety instructions.");
    assert(missions.read(queued.id).status === "in_progress", "Claimed missions are in progress.");
    assert((await call("merge_harbor_claim_assessments")).content[0].text.startsWith("No assessments are queued"), "A mission is claimed once.");

    const report = await call("merge_harbor_report_repository_assessment", {
        missionId: queued.id,
        status: "completed",
        message: "Assessment complete",
        findings: [],
    });
    assert(!report.isError && missions.read(queued.id).status === "completed", "Claude reports results through the shared tool.");

    const bad = await call("merge_harbor_report_repository_assessment", { missionId: "nope", status: "completed", message: "x" });
    assert(bad.isError && bad.content[0].text.startsWith("Merge Harbor rejected the request:"), "Tool failures come back as MCP errors, not crashes.");

    const unknown = await request("tools/call", { name: "nope", arguments: {} });
    assert(unknown.error?.code === -32602, "Unknown tools are a JSON-RPC error.");

    process.stdout.write("MCP smoke test: 7 tools, canvas under Claude, queued assessment claimed once and reported.\n");
} finally {
    server.stdin.end();
    await new Promise((done) => server.on("exit", done));
    rmSync(home, { recursive: true, force: true });
}
