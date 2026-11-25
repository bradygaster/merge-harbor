// Stand-in for @github/copilot-sdk/extension so the real extension.mjs can run in a
// plain browser during development. It opens the canvas once and prints its URL.
// Prompts the extension would send into a Copilot session are printed instead.
//
// A loopback-only tool bridge lets a developer (or an agent driving the preview) play
// the Copilot side: POST http://127.0.0.1:<port+1>/tools/<name> with the tool's JSON
// arguments, and GET /prompts for prompts the extension has sent.
import { createServer } from "node:http";

const prompts = [];

function startToolBridge(tools) {
    const port = (Number.parseInt(process.env.MERGE_HARBOR_PREVIEW_PORT ?? "", 10) || 4317) + 1;
    const server = createServer(async (req, res) => {
        const reply = (status, value) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(value));
        };
        if (req.method === "GET" && req.url === "/prompts") return reply(200, prompts);
        const match = req.method === "POST" && req.url?.match(/^\/tools\/([\w-]+)$/);
        const tool = match && tools.find((candidate) => candidate.name === match[1]);
        if (!tool) return reply(404, { error: "Unknown tool" });
        let body = "";
        for await (const chunk of req) body += chunk;
        try {
            reply(200, { result: await tool.handler(JSON.parse(body || "{}")) });
        } catch (error) {
            reply(500, { error: error.message });
        }
    });
    server.listen(port, "127.0.0.1", () => console.log(`[preview] Tool bridge: http://127.0.0.1:${port}/tools/<name>`));
}

export function createCanvas(definition) {
    return definition;
}

export async function joinSession({ tools = [], canvases = [] }) {
    const session = {
        async send({ prompt }) {
            prompts.push({ at: new Date().toISOString(), prompt });
            console.log(`\n[preview] Copilot would receive this prompt:\n${prompt}\n`);
        },
    };
    startToolBridge(tools);
    setTimeout(async () => {
        for (const canvas of canvases) {
            const opened = await canvas.open({ instanceId: "preview", input: {} });
            globalThis.mergeHarborPreviewCanvasUrl = opened.url;
            console.log(`[preview] ${canvas.displayName} canvas (random port): ${opened.url}`);
        }
    }, 0);
    return session;
}
