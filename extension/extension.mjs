// GitHub Copilot host for Merge Harbor. Everything host-neutral lives in harbor-runtime.mjs;
// this file mounts its tools and canvas and pushes assessment prompts with session.send.
import { homedir } from "node:os";
import { join } from "node:path";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { buildAssessmentPrompt } from "./assessment-core.mjs";
import { createHarborRuntime } from "./harbor-runtime.mjs";

const copilotHome = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
const views = ["overview", "convoy", "watchtower", "decisions"];

const runtime = createHarborRuntime({
    dataDirectory: join(copilotHome, "extensions", "merge-harbor", "artifacts"),
    host: {
        name: "Copilot",
        triageHint: "Ask Copilot to triage a repository's issues.",
        sendAssessmentPrompt: (mission) => session.send({ prompt: buildAssessmentPrompt(mission) }),
    },
});

function failureText(error) {
    const message = runtime.ghFailureMessage(error);
    return message === "The authenticated GitHub CLI request failed." ? error.message : message;
}

const session = await joinSession({
    tools: runtime.tools.map((tool) => ({
        ...tool,
        handler: async (args) => {
            try {
                return await tool.handler(args);
            } catch (error) {
                return { resultType: "failure", textResultForLlm: `Merge Harbor rejected the request: ${failureText(error)}` };
            }
        },
    })),
    canvases: [
        createCanvas({
            id: "merge-harbor",
            displayName: "Merge Harbor",
            description: "Ambient merge operations with personal and organization views plus safe repository assessments.",
            inputSchema: {
                type: "object",
                properties: { defaultView: { type: "string", enum: views } },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "show_view",
                    description: "Switch the open canvas to the Overview (overview), PR flow (convoy), Needs attention (watchtower), or Decisions (decisions) view.",
                    inputSchema: {
                        type: "object",
                        properties: { view: { type: "string", enum: views } },
                        required: ["view"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => runtime.setView(ctx.instanceId, ctx.input.view),
                },
                {
                    name: "get_demo_summary",
                    description: "Return the active repository scope, its open pull request totals, and the canvas's current view.",
                    handler: async (ctx) => runtime.summary(ctx.instanceId),
                },
            ],
            open: async (ctx) => {
                const entry = await runtime.open(ctx.instanceId, ctx.input?.defaultView ?? "overview");
                return { title: "Merge Harbor", status: "Merge operations and safe repository assessments", url: entry.url };
            },
            onClose: async (ctx) => runtime.close(ctx.instanceId),
        }),
    ],
});

runtime.resume();
