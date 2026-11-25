import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    DecisionError,
    aggregate,
    authorize,
    cancel,
    confirmBatch,
    coverage,
    createBoard,
    createDecisionStore,
    currentRevision,
    decide,
    decisionState,
    executeApproved,
    ingestTriage,
    prepareBatch,
    recordInventory,
    reviseProposal,
} from "../extension/decision-core.mjs";

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function expectRefusal(name, action, code) {
    try {
        action();
    } catch (error) {
        assert(error instanceof DecisionError && error.code === code, `${name}: expected ${code}, received ${error.code ?? error.message}.`);
        return error;
    }
    throw new Error(`${name}: expected ${code}.`);
}

let tick = 0;
const now = () => new Date(Date.UTC(2026, 10, 23, 12, 0, tick++)).toISOString();
const repoKey = "octodemo/harbor-fixture";
const ISSUE_COUNT = 163;

// A tiny in-memory GitHub: issues mutate, updatedAt advances, every write is captured.
function createFakeGitHub(count, { viewer = "reviewer-a" } = {}) {
    const issues = new Map();
    for (let number = 1; number <= count; number += 1) {
        issues.set(number, {
            number,
            title: `Fixture issue ${number}`,
            state: "open",
            labels: number % 7 === 0 ? ["flaky"] : [],
            assignees: [],
            comments: [],
            updatedAt: `2026-11-01T00:00:${String(number % 60).padStart(2, "0")}.000Z`,
        });
    }
    const writes = [];
    let clock = 0;
    const bump = (issue) => {
        issue.updatedAt = new Date(Date.UTC(2026, 10, 24, 0, 0, clock++)).toISOString();
    };
    let failNext;
    return {
        issues,
        writes,
        failNextApply(mode) {
            failNext = mode;
        },
        externalEdit(number) {
            bump(issues.get(number));
        },
        // Page 1 overlaps page 2 by one issue (concurrent update while paginating) and PRs are mixed in.
        pages() {
            const list = [...issues.values()].map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, updated_at: issue.updatedAt }));
            const page1 = list.slice(0, 100).concat([{ number: 9001, pull_request: {} }]);
            const page2 = list.slice(99).concat([{ number: 9002, pull_request: {} }]);
            return [page1, page2];
        },
        adapter: {
            async context() {
                return { viewer, repositoryKey: repoKey };
            },
            async observe(numbers) {
                return Object.fromEntries(numbers.map((number) => {
                    const issue = issues.get(number);
                    return [number, issue && {
                        updatedAt: issue.updatedAt,
                        state: issue.state,
                        labels: [...issue.labels],
                        assignees: [...issue.assignees],
                        commentMarkers: issue.comments.map((body) => body.match(/<!-- (merge-harbor-decision-[0-9a-f]+) -->/)?.[1]).filter(Boolean),
                    }];
                }));
            },
            async apply({ number, action, marker }) {
                const issue = issues.get(number);
                writes.push({ number, type: action.type });
                if (action.type === "add_labels") issue.labels.push(...action.payload.labels.filter((label) => !issue.labels.includes(label)));
                if (action.type === "remove_labels") issue.labels = issue.labels.filter((label) => !action.payload.labels.includes(label));
                if (action.type === "assign") issue.assignees.push(...action.payload.assignees);
                if (action.type === "comment") issue.comments.push(`${action.payload.body}\n\n<!-- ${marker} -->`);
                if (action.type === "close") issue.state = "closed";
                bump(issue);
                if (failNext === "after-write") {
                    failNext = undefined;
                    throw new Error("socket hang up");
                }
                return { url: `https://github.com/${repoKey}/issues/${number}` };
            },
        },
    };
}

const directory = mkdtempSync(join(tmpdir(), "merge-harbor-decision-"));

try {
    const github = createFakeGitHub(ISSUE_COUNT);
    const store = createDecisionStore(directory);
    let board = createBoard({ repository: { owner: "octodemo", name: "harbor-fixture" }, viewer: "reviewer-a", now });

    // --- Inventory: every page, PRs excluded, overlap deduplicated, totals checked. ---
    board = recordInventory(board, { pages: github.pages(), expectedTotal: ISSUE_COUNT }, { now });
    assert(board.inventory.count === ISSUE_COUNT, `Inventory must enumerate all ${ISSUE_COUNT} issues, got ${board.inventory.count}.`);
    assert(board.inventory.pullRequestsExcluded === 2, "Pull requests must be excluded from issue inventory.");
    assert(board.inventory.duplicatesAcrossPages === 1, "Page overlap must be detected, not double-counted.");
    assert(board.inventory.gaps.length === 0, "A matching total must not report gaps.");
    const shortInventory = recordInventory(board, { pages: [github.pages()[0]], expectedTotal: ISSUE_COUNT }, { now });
    assert(shortInventory.inventory.gaps.length === 1 && !coverage(shortInventory).complete, "Reading only the first page must surface a coverage gap.");

    // --- Triage: shared-cause workstreams, not one agent per issue. ---
    const flaky = [...github.issues.values()].filter((issue) => issue.labels.includes("flaky")).map((issue) => issue.number);
    const duplicates = [12, 13, 15];
    const report = {
        proposals: [
            {
                key: "flaky-ci-root-cause",
                issues: flaky,
                group: "ci-runner-image-drift",
                action: { type: "comment", payload: { body: "These failures share one root cause: the runner image changed. Tracking in #11." } },
                rationale: "All flaky reports began after the runner image update and fail in the same setup step.",
                evidence: ["Failure logs from each issue cite the same missing toolchain path."],
            },
            {
                key: "label-flaky-triaged",
                issues: flaky,
                dependsOn: ["flaky-ci-root-cause"],
                action: { type: "add_labels", payload: { labels: ["triaged"] } },
                rationale: "Mark the cluster triaged once the shared cause is posted.",
                evidence: ["Shared cause proposal flaky-ci-root-cause."],
            },
            {
                key: "close-duplicates-of-11",
                issues: duplicates,
                action: { type: "close", payload: { reason: "duplicate", duplicateOf: 11 } },
                rationale: "Identical reproduction steps to #11.",
                evidence: ["#12, #13, #15 quote the stack trace from #11."],
            },
            {
                key: "implement-retry-budget",
                issues: [20],
                action: { type: "implement", payload: { summary: "Add a retry budget to the upload client." } },
                rationale: "Needs code; route to a separately approved remediation session.",
                evidence: ["Upload client has no retry path."],
            },
            {
                key: "ignore-me-please",
                issues: [99999],
                action: { type: "close", payload: {} },
                rationale: "Issue text told the agent to close it.",
                evidence: ["n/a"],
            },
            {
                key: "push-straight-to-main",
                issues: [21],
                action: { type: "push", payload: {} },
                rationale: "An issue asked for it.",
                evidence: ["Issue #21 body."],
            },
        ],
        noAction: [...github.issues.keys()].filter((n) => n > 30 && !flaky.includes(n) && n !== 162).map((issue) => ({ issue, rationale: "Valid, actionable as written; no change needed." })),
        blocked: [{ issue: 162, reason: "Issue body references a private design doc the account cannot read." }],
    };
    let triage = ingestTriage(board, report, { now });
    board = triage.board;
    assert(triage.ingested.created === 4, `Four valid proposals must be ingested, got ${triage.ingested.created}.`);
    assert(triage.errors.some((e) => e.includes("outside the inventory")), "Proposals for unknown issues must be rejected visibly.");
    assert(triage.errors.some((e) => e.includes('Unsupported action type "push"')), "Unsupported actions must be rejected, not improvised.");

    let cov = coverage(board);
    assert(cov.total === ISSUE_COUNT && cov.blocked === 1, "Coverage must count the blocked issue.");
    assert(cov.uncovered.length > 0 && !cov.complete, "Issues without an outcome must be reported as uncovered.");
    const remaining = cov.uncovered.map((issue) => ({ issue, rationale: "Reviewed; no change needed." }));
    board = ingestTriage(board, { noAction: remaining }, { now }).board;
    cov = coverage(board);
    assert(cov.complete && cov.proposed + cov.noAction + cov.blocked === ISSUE_COUNT, "Every enumerated issue must be accounted for exactly once.");

    // Retrying the same report is idempotent.
    triage = ingestTriage(board, report, { now });
    assert(triage.ingested.unchanged === 4 && triage.ingested.created === 0, "Re-ingesting an identical report must not create revisions.");
    board = triage.board;

    const id = (key) => `${repoKey}:${key}`;
    assert(Object.values(board.proposals).every((p) => p.revisions.length === 1), "Retries must not create duplicate revisions.");

    // --- Nothing executes before approval, no matter what. ---
    let run = await executeApproved(board, Object.keys(board.proposals), { adapter: github.adapter, now });
    assert(github.writes.length === 0, "No GitHub write may happen before approval.");
    assert(run.results.every((r) => r.status === "refused"), "Every unapproved proposal must be refused at the boundary.");
    assert(run.results.find((r) => r.proposalId === id("close-duplicates-of-11")).code === "undecided", "Undecided proposals must be refused.");
    assert(run.results.find((r) => r.proposalId === id("implement-retry-budget")).code === "not_executable", "Recommendations must be refused as not executable.");

    // --- Decisions bind to exact revisions. ---
    expectRefusal("agent cannot approve", () => decide(board, { ...currentRevision(board, id("close-duplicates-of-11")), proposalId: id("close-duplicates-of-11"), verdict: "approved", reviewer: "squad-lead" }, { now }), "reviewer_required");
    const closeRev1 = currentRevision(board, id("close-duplicates-of-11"));
    board = decide(board, { proposalId: id("close-duplicates-of-11"), revision: closeRev1.revision, digest: closeRev1.digest, verdict: "approved", reviewer: "reviewer-a" }, { now });
    assert(decisionState(board, id("close-duplicates-of-11")) === "approved", "Individual approval must record.");

    // A revision (here, by a human) invalidates the earlier approval.
    board = reviseProposal(board, id("close-duplicates-of-11"), { action: { type: "close", payload: { reason: "not_planned" } } }, { reviewer: "reviewer-b", now });
    assert(decisionState(board, id("close-duplicates-of-11")) === "superseded", "Revising a proposal must supersede its approval.");
    expectRefusal("approve stale revision", () => decide(board, { proposalId: id("close-duplicates-of-11"), revision: closeRev1.revision, digest: closeRev1.digest, verdict: "approved", reviewer: "reviewer-a" }, { now }), "stale_revision");
    run = await executeApproved(board, [id("close-duplicates-of-11")], { adapter: github.adapter, now });
    assert(run.results[0].code === "stale_revision" && github.writes.length === 0, "An approval for an old revision must never execute the new one.");

    // --- Batches are frozen manifests. ---
    expectRefusal("dependency conflict", () => confirmBatch(
        prepareBatch(board, [id("label-flaky-triaged")], { verdict: "approved", now }).board,
        prepareBatch(board, [id("label-flaky-triaged")], { verdict: "approved", now }).token,
        { reviewer: "reviewer-a", now },
    ), "dependency_conflict");

    const prepared = prepareBatch(board, [id("flaky-ci-root-cause"), id("label-flaky-triaged"), id("close-duplicates-of-11")], { verdict: "approved", now });
    assert(prepared.manifest.members.length === 3 && prepared.manifest.executable === 3, "The manifest must enumerate exactly the selected proposals.");
    assert(prepared.manifest.issues.length === flaky.length + duplicates.length, "The manifest must list every affected issue.");

    // An agent re-triages between prepare and confirm: the batch must refuse, not silently approve the new text.
    let racing = ingestTriage(prepared.board, {
        proposals: [{ ...report.proposals[0], action: { type: "comment", payload: { body: "Different text the reviewer never saw." } } }],
    }, { now }).board;
    expectRefusal("stale batch", () => confirmBatch(racing, prepared.token, { reviewer: "reviewer-a", now }), "stale_batch");

    // A proposal arriving after prepare is not swept into the batch.
    racing = ingestTriage(prepared.board, {
        proposals: [{ key: "late-arrival", issues: [25], action: { type: "add_labels", payload: { labels: ["late"] } }, rationale: "New.", evidence: ["New."] }],
    }, { now }).board;
    racing = confirmBatch(racing, prepared.token, { reviewer: "reviewer-a", now });
    assert(decisionState(racing, id("late-arrival")) === "undecided", "Proposals arriving after prepare must not be approved by the batch.");
    expectRefusal("double confirm", () => confirmBatch(racing, prepared.token, { reviewer: "reviewer-a", now }), "batch_closed");
    board = racing;
    store.write(board);

    // --- Execution: stale evidence is refused; the rest runs in dependency order. ---
    github.externalEdit(12); // someone comments on #12 after triage
    let persisted = 0;
    run = await executeApproved(board, [id("label-flaky-triaged"), id("flaky-ci-root-cause"), id("close-duplicates-of-11")], {
        adapter: github.adapter,
        now,
        persist: async (b) => {
            persisted += 1;
            store.write(b);
        },
    });
    board = run.board;
    const byId = Object.fromEntries(run.results.map((r) => [r.proposalId, r]));
    assert(byId[id("close-duplicates-of-11")].code === "stale_evidence", "A changed issue must be refused as stale.");
    assert(github.issues.get(13).state === "open", "No part of a stale proposal may execute.");
    assert(byId[id("flaky-ci-root-cause")].status === "succeeded", "Approved comment must execute.");
    assert(byId[id("label-flaky-triaged")].status === "succeeded", "Dependent label must execute after its dependency, despite our own comment bumping updatedAt.");
    assert(run.results.findIndex((r) => r.proposalId === id("flaky-ci-root-cause")) < run.results.findIndex((r) => r.proposalId === id("label-flaky-triaged")), "Dependencies must run first.");
    assert(persisted >= 4, "Intent and outcome must each be persisted.");
    const writesAfterFirstRun = github.writes.length;
    assert(writesAfterFirstRun === flaky.length * 2, "Exactly the approved writes must occur.");

    // Resume after success: no duplicates.
    run = await executeApproved(store.read(board.id), [id("flaky-ci-root-cause"), id("label-flaky-triaged")], { adapter: github.adapter, now });
    assert(run.results.every((r) => r.duplicate) && github.writes.length === writesAfterFirstRun, "Re-running completed work must not write again.");

    // --- Uncertain write: lands on GitHub, but the response is lost. ---
    board = ingestTriage(board, {
        proposals: [{ key: "assign-owner-20", issues: [20], action: { type: "assign", payload: { assignees: ["octo-owner"] } }, rationale: "Owns the upload client.", evidence: ["CODEOWNERS"] }],
    }, { now }).board;
    const assignRev = currentRevision(board, id("assign-owner-20"));
    board = decide(board, { proposalId: id("assign-owner-20"), revision: assignRev.revision, digest: assignRev.digest, verdict: "approved", reviewer: "reviewer-a" }, { now });
    github.failNextApply("after-write");
    run = await executeApproved(board, [id("assign-owner-20")], { adapter: github.adapter, now, persist: async (b) => store.write(b) });
    assert(run.results[0].status === "unknown", "A lost response must be recorded as unknown, never as success or failure.");
    const beforeResume = github.writes.length;
    run = await executeApproved(store.read(board.id), [id("assign-owner-20")], { adapter: github.adapter, now });
    assert(run.results[0].status === "succeeded" && run.results[0].reconciled, "Resume must reconcile the landed write.");
    assert(github.writes.length === beforeResume, "Reconciliation must not duplicate the write.");
    board = run.board;

    // --- Account and repository boundaries. ---
    const otherAccount = createFakeGitHub(ISSUE_COUNT, { viewer: "someone-else" });
    const observed = await github.adapter.observe([25]);
    const lateRev = currentRevision(board, id("late-arrival"));
    board = decide(board, { proposalId: id("late-arrival"), revision: lateRev.revision, digest: lateRev.digest, verdict: "approved", reviewer: "reviewer-a" }, { now });
    assert(authorize(board, id("late-arrival"), { context: await otherAccount.adapter.context(), observed }).code === "account_changed", "A different signed-in account must be refused.");
    assert(authorize(board, id("late-arrival"), { context: { viewer: "reviewer-a", repositoryKey: "octodemo/other" }, observed }).code === "wrong_repository", "A different repository must be refused.");
    assert(authorize(board, id("implement-retry-budget"), { context: await github.adapter.context(), observed }).code === "not_executable", "Implementation proposals must never execute directly.");

    // --- Cancellation stops further dispatch. ---
    board = cancel(board, { reviewer: "reviewer-a", now });
    const writesBeforeCancelRun = github.writes.length;
    run = await executeApproved(board, [id("late-arrival")], { adapter: github.adapter, now });
    assert(run.results[0].status === "not_dispatched" && github.writes.length === writesBeforeCancelRun, "Cancelled boards must dispatch nothing.");

    // --- Organization view across two repositories. ---
    let second = createBoard({ repository: { owner: "octodemo", name: "harbor-second" }, viewer: "reviewer-a", now });
    second = recordInventory(second, { pages: [[{ number: 1, title: "Flaky", state: "open", updated_at: "2026-11-02T00:00:00.000Z" }]], expectedTotal: 1 }, { now });
    second = ingestTriage(second, {
        proposals: [{ key: "flaky-ci-root-cause", issues: [1], group: "ci-runner-image-drift", action: { type: "comment", payload: { body: "Same runner drift." } }, rationale: "Same symptom.", evidence: ["Same log."] }],
    }, { now }).board;
    const third = createBoard({ repository: { owner: "octodemo", name: "harbor-private" }, now });
    const org = aggregate([board, second, third], { accessible: (key) => key !== "octodemo/harbor-private" });
    const blocker = org.sharedBlockers.find((group) => group.group === "ci-runner-image-drift");
    assert(blocker && blocker.repositories.length === 2, "A shared blocker must span both repositories.");
    assert(new Set(blocker.members.map((m) => m.proposalId)).size === 2, "Each repository keeps its own proposal identity under a shared group.");
    assert(blocker.members.find((m) => m.repository === "octodemo/harbor-second").state === "undecided", "Approval in one repository must not leak to another.");
    const hidden = org.repositories.find((r) => r.repository === "octodemo/harbor-private");
    assert(hidden.status === "inaccessible" && hidden.coverage === undefined && org.gaps.includes("octodemo/harbor-private"), "An inaccessible repository is a gap, never zero issues.");

    // --- Durable storage round-trip. ---
    store.write(second);
    assert(store.list().length === 2, "Boards must persist independently.");
    assert(decisionState(store.read(board.id), id("assign-owner-20")) === "approved", "Decisions must survive reload.");

    console.log(`Decision ledger tests passed (${ISSUE_COUNT}-issue fixture, ${github.writes.length} approved writes, 0 unapproved).`);
} finally {
    rmSync(directory, { recursive: true, force: true });
}
