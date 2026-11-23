// Run the real Merge Harbor extension in a plain browser for development.
//
//   node scripts/preview.mjs [--seed-boards] [--port 4317]
//
// Uses the signed-in `gh` account for live data (read-only unless you click a write
// action). State goes to .preview/ in this repository unless COPILOT_HOME is set.
// --seed-boards writes development-only decision boards for octodemo fixture repos.
//
// The extension always listens on a random loopback port; this script puts a fixed-port
// proxy in front of it so a browser or launch config has a stable address. A tool bridge
// on port+1 lets you play the Copilot side (see scripts/preview/copilot-sdk-stub.mjs).
import { request, createServer } from "node:http";
import { register } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = Number(portIndex >= 0 ? args[portIndex + 1] : 4317);
process.env.MERGE_HARBOR_PREVIEW_PORT = String(port);
process.env.COPILOT_HOME ??= join(root, ".preview");

if (args.includes("--seed-boards")) {
    const { createDecisionStore } = await import("../extension/decision-core.mjs");
    const { seedBoards } = await import("./preview/seed-boards.mjs");
    seedBoards(createDecisionStore(join(process.env.COPILOT_HOME, "extensions", "merge-harbor", "artifacts")));
    console.log("[preview] Seeded development decision boards.");
}

register("./preview/loader.mjs", import.meta.url);
await import("../extension/extension.mjs");

createServer((req, res) => {
    const target = globalThis.mergeHarborPreviewCanvasUrl;
    if (!target) {
        res.writeHead(503).end("Canvas is still opening.");
        return;
    }
    const upstream = request(new URL(req.url, target), { method: req.method, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
    });
    upstream.on("error", (error) => res.writeHead(502).end(error.message));
    req.pipe(upstream);
}).listen(port, "127.0.0.1", () => console.log(`[preview] Open http://127.0.0.1:${port}/`));
