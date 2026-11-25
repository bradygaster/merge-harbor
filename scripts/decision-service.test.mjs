import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionStore, currentRevision } from "../extension/decision-core.mjs";
import { createDecisionService } from "../extension/decision-service.mjs";

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const OWNER = "octodemo";
const NAME = "harbor-service";
const ISSUES = 230; // three pages of 100, with pull requests interleaved

// A fake `gh api` that speaks just enough REST and records every call.
function createFakeGh() {
    const issues = new Map();
    for (let number = 1; number <= ISSUES; number += 1) {
        issues.set(number, { number, title: `Issue ${number}`, state: "open", labels: [], assignees: [], comments: [], updated_at: "2026-11-20T00:00:00Z" });
    }
    const pullRequests = [9001, 9002, 9003].map((number) => ({ number, pull_request: {}, title: "PR", state: "open" }));
    const calls = [];
    let clock = 0;
    const bump = (issue) => {
        issue.updated_at = new Date(Date.UTC(2026, 10, 24, 0, 0, clock++)).toISOString();
    };
    const fail = (code) => Object.assign(new Error(`gh: HTTP ${code}`), { stderr: `gh: Not Found (HTTP ${code})` });
    const view = (issue) => ({ ...issue, labels: issue.labels.map((name) => ({ name })), assignees: issue.assignees.map((login) => ({ login })) });

    async function runGh(args) {
        let method = "GET";
        const fields = {};
        const arrays = {};
        let path;
        for (let i = 0; i < args.length; i += 1) {
            if (args[i] === "--method") method = args[++i];
            else if (args[i] === "--raw-field") {
                const [key, ...rest] = args[++i].split("=");
                const value = rest.join("=");
                if (key.endsWith("[]")) (arrays[key.slice(0, -2)] ??= []).push(value);
                else fields[key] = value;
            } else path = args[i];
        }
        calls.push({ method, path, fields, arrays });
        const json = (value) => JSON.stringify(value);

        if (path === "user") return json({ login: "reviewer-a" });
        if (path === `repos/${OWNER}/${NAME}`) return json({ full_name: `${OWNER}/${NAME}` });
        if (path === "search/issues") return json({ total_count: ISSUES });
        const base = `repos/${OWNER}/${NAME}/issues`;
        if (path === base && method === "GET") {
            const all = [...issues.values()].map(view);
            all.splice(50, 0, pullRequests[0]);
            all.splice(150, 0, pullRequests[1]);
            all.splice(220, 0, pullRequests[2]);
            const page = Number(fields.page);
            return json(all.slice((page - 1) * 100, page * 100));
        }
        const match = path.match(new RegExp(`^${base}/(\\d+)(?:/(labels|assignees|comments)(?:/(.+))?)?$`));
        if (!match) throw fail(404);
        const issue = issues.get(Number(match[1]));
        if (!issue) throw fail(404);
        const [, , sub, label] = match;
        if (!sub && method === "GET") return json(view(issue));
        if (!sub && method === "PATCH") {
            Object.assign(issue, { state: fields.state, state_reason: fields.state_reason });
            bump(issue);
            return json(view(issue));
        }
        if (sub === "labels" && method === "POST") {
            for (const name of arrays.labels) if (!issue.labels.includes(name)) issue.labels.push(name);
            bump(issue);
            return json(issue.labels.map((name) => ({ name })));
        }
        if (sub === "labels" && method === "DELETE") {
            const name = decodeURIComponent(label);
            if (!issue.labels.includes(name)) throw fail(404);
            issue.labels = issue.labels.filter((candidate) => candidate !== name);
            bump(issue);
            return "";
        }
        if (sub === "assignees" && method === "POST") {
            issue.assignees.push(...arrays.assignees);
            bump(issue);
            return json(view(issue));
        }
        if (sub === "comments" && method === "GET") {
            const page = Number(fields.page ?? 1);
            return json(issue.comments.slice((page - 1) * 100, page * 100).map((body) => ({ body })));
        }
        if (sub === "comments" && method === "POST") {
            issue.comments.push(fields.body);
            bump(issue);
            return json({ html_url: `https://github.com/${OWNER}/${NAME}/issues/${issue.number}#c${issue.comments.length}` });
        }
        throw fail(404);
    }
    return { runGh, calls, issues, writes: () => calls.filter((call) => call.method !== "GET") };
}

const directory = mkdtempSync(join(tmpdir(), "merge-harbor-service-"));

try {
    const gh = createFakeGh();
    const events = [];
    const store = createDecisionStore(directory);
    const service = createDecisionService({ store, runGh: gh.runGh, broadcast: (event) => events.push(event) });
    const tool = (name) => service.tools.find((candidate) => candidate.name === name).handler;
    const post = (path, body) => service.handle("POST", path, body);

    // Reporting before inventory is refused: the agent can't invent the issue list.
    let refused;
    try {
        await tool("merge_harbor_report_issue_triage")({ owner: OWNER, name: NAME, noAction: [{ issue: 1, rationale: "x" }] });
    } catch (error) {
        refused = error;
    }
    assert(refused?.message.includes("get_issue_inventory"), "Triage before inventory must be refused.");

    // Inventory: three pages, PRs excluded, matches search total.
    const inventoryText = await tool("merge_harbor_get_issue_inventory")({ owner: OWNER, name: NAME });
    assert(inventoryText.includes(`${ISSUES} open issues enumerated across 3 page(s); 3 pull requests excluded.`), `Inventory text was: ${inventoryText.split("\n")[1]}`);
    assert(!inventoryText.includes("Inventory gaps"), "A complete inventory must not report gaps.");
    const boardId = `board-${OWNER}__${NAME}`;
    assert(store.read(boardId)?.viewer === "reviewer-a", "The board must record the assessing account.");

    // Triage in two calls; errors come back to the agent as text it can act on.
    let text = await tool("merge_harbor_report_issue_triage")({
        owner: OWNER,
        name: NAME,
        proposals: [
            { key: "explain-cause", issues: [3, 4], group: "token-expiry", action: { type: "comment", payload: { body: "Shared cause: token expiry." } }, rationale: "Same stack.", evidence: ["Both logs show 401 after 60m."] },
            { key: "label-cluster", issues: [3, 4], dependsOn: ["explain-cause"], action: { type: "add_labels", payload: { labels: ["auth"] } }, rationale: "Cluster label.", evidence: ["Same as explain-cause."] },
            { key: "drop-stale-label", issues: [5], action: { type: "remove_labels", payload: { labels: ["needs-repro"] } }, rationale: "Reproduced.", evidence: ["Repro in comment."] },
            { key: "close-6", issues: [6], action: { type: "close", payload: { reason: "not_planned" } }, rationale: "Out of scope.", evidence: ["Roadmap."] },
            { key: "bogus", issues: [999], action: { type: "close", payload: {} }, rationale: "x", evidence: ["x"] },
        ],
    });
    assert(text.includes("Recorded 4 new") && text.includes("outside the inventory (999)"), "The agent must learn what was rejected and why.");
    assert(text.includes("Uncovered issues"), "The agent must see what is still uncovered.");
    const rest = [...gh.issues.keys()].filter((n) => n > 6 || n < 3).map((issue) => ({ issue, rationale: "Fine as is." }));
    text = await tool("merge_harbor_report_issue_triage")({ owner: OWNER, name: NAME, noAction: rest });
    assert(text.includes("Triage is complete."), `Second report should complete coverage: ${text}`);
    assert(gh.writes().length === 0, "Inventory and triage must make no GitHub writes.");

    // Decide through routes. Reviewer comes from gh, not the request body.
    const id = (key) => `${OWNER}/${NAME}:${key}`.toLowerCase();
    let board = store.read(boardId);
    const rev = (key) => currentRevision(board, id(key));
    let response = await post("/api/decisions", { boardId, proposalId: id("close-6"), revision: rev("close-6").revision, digest: rev("close-6").digest, verdict: "approved", reviewer: "squad-impersonator" });
    assert(response.statusCode === 200, `Decision should succeed: ${JSON.stringify(response.body)}`);
    assert(response.body.board.decisions.at(-1).reviewer === "reviewer-a", "The reviewer must be the gh account, never the request body.");

    response = await post("/api/decisions", { boardId, proposalId: id("close-6"), revision: 1, digest: "forged", verdict: "approved" });
    assert(response.statusCode === 409 && response.body.code === "stale_revision", "A forged digest must be refused with 409.");

    response = await post("/api/decision-batches", { boardId, proposalIds: [id("explain-cause"), id("label-cluster"), id("drop-stale-label")], verdict: "approved" });
    assert(response.statusCode === 200 && response.body.manifest.members.length === 3, "Batch prepare must return the manifest.");
    response = await post("/api/decision-batches", { boardId, token: response.body.token });
    assert(response.statusCode === 200, `Batch confirm should succeed: ${JSON.stringify(response.body)}`);

    // Execute everything that's approved.
    response = await post("/api/decision-executions", { boardId, proposalIds: [id("close-6"), id("label-cluster"), id("explain-cause"), id("drop-stale-label")] });
    assert(response.statusCode === 200, `Execution should succeed: ${JSON.stringify(response.body)}`);
    const results = Object.fromEntries(response.body.results.map((r) => [r.proposalId, r.status]));
    assert(Object.values(results).every((status) => status === "succeeded"), `All approved actions should succeed: ${JSON.stringify(results)}`);
    assert(gh.issues.get(6).state === "closed" && gh.issues.get(6).state_reason === "not_planned", "Close must send state_reason.");
    assert(gh.issues.get(3).labels.includes("auth") && gh.issues.get(4).comments[0].includes("<!-- merge-harbor-decision-"), "Labels and marked comments must land.");

    const writes = gh.writes();
    assert(writes.length === 6, `Expected 6 writes (2 comments, 2 labels, 1 label delete, 1 close), got ${writes.length}.`);
    assert(writes.every((call) => call.path.startsWith(`repos/${OWNER}/${NAME}/issues/`)), "Writes must target only this repository's issues.");
    const commentIndex = writes.findIndex((call) => call.path.endsWith("/comments"));
    const labelIndex = writes.findIndex((call) => call.method === "POST" && call.path.endsWith("/labels"));
    assert(commentIndex < labelIndex, "Dependencies must execute before dependents.");

    // Re-running is a no-op; the absent label delete (404) counted as success.
    response = await post("/api/decision-executions", { boardId, proposalIds: [id("close-6"), id("explain-cause")] });
    assert(gh.writes().length === 6, "Re-executing completed work must not write again.");

    // Unknown routes fall through; organization view is served.
    assert((await service.handle("POST", "/api/decision-nope", {})) === undefined, "Unknown routes must fall through.");
    const org = await service.handle("GET", "/api/decision-boards", undefined, new URLSearchParams());
    assert(org.body.boards.length === 1 && org.body.organization.repositories[0].coverage.complete, "The organization view must report complete coverage.");
    assert(events.includes("board"), "Board changes must be broadcast to the canvas.");

    console.log(`Decision service tests passed (${ISSUES} issues over 3 pages, ${gh.calls.length} gh calls, ${gh.writes().length} approved writes).`);
} finally {
    rmSync(directory, { recursive: true, force: true });
}
