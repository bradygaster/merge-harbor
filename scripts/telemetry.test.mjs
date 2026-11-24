import {
    ownerSearchQualifier,
    pickAttentionSignal,
    queueMetrics,
    queueQualifiers,
    queueSearches,
    repoKey,
    runningChecksCount,
    toRepoSummary,
} from "../extension/queue-telemetry.mjs";

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const now = Date.parse("2026-11-16T12:00:00Z");
const daysAgo = (days) => new Date(now - days * 86400000).toISOString();
let nextNumber = 1;
function pr(overrides = {}) {
    const number = nextNumber++;
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/octo/repo/pull/${number}`,
        isDraft: false,
        updatedAt: daysAgo(1),
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: null,
        statusCheckRollup: { state: "SUCCESS" },
        reviewRequests: { totalCount: 0 },
        ...overrides,
    };
}

// Owner qualifiers: personal accounts search with user:, everything else with org:.
assert(ownerSearchQualifier("user") === "user", "Personal accounts must search with the user: qualifier.");
assert(ownerSearchQualifier("organization") === "org", "Organizations must search with the org: qualifier.");
assert(ownerSearchQualifier(undefined) === "org", "Unknown owner kinds default to org:.");

// Repository keys are case-insensitive.
assert(repoKey("Octo", "Repo") === repoKey("octo", "REPO"), "Repository keys must ignore case.");
assert(repoKey("octo", "repo") === "octo/repo", "Repository keys use owner/name.");

// Repository summaries keep only what the canvas needs.
const summary = toRepoSummary({
    name: "repo",
    url: "https://github.com/octo/repo",
    description: null,
    pushedAt: daysAgo(0),
    owner: { login: "octo" },
    pullRequests: { totalCount: 4 },
});
assert(summary.owner === "octo" && summary.prs === 4 && summary.description === "", "Repository summaries must normalize owner, count, and description.");
assert(toRepoSummary({ name: "x", pullRequests: { totalCount: 0 } }, "explicit").owner === "explicit", "An explicit owner must override the node owner.");

// Queue metrics are mutually exclusive and add up to the open total.
const metrics = queueMetrics({ failing: 3, changesRequested: 2, review: 4, drafts: 5, checks: 1, ready: 2 }, 20);
assert(metrics.blocked === 5, "Blocked must combine failing checks and requested changes.");
assert(metrics.other === 3, "Other must hold the open pull requests no queue claimed.");
assert(Object.values(metrics).reduce((sum, value) => sum + value, 0) === 20, "Queue metrics must sum to the open total.");
assert(queueMetrics({ failing: 30 }, 10).other === 0, "Other must never be negative.");

// GitHub search matches status:pending for PRs with no CI at all; those must not count as running.
const noCi = { statusCheckRollup: null };
const running = { statusCheckRollup: { state: "PENDING" } };
const expected = { statusCheckRollup: { state: "EXPECTED" } };
assert(runningChecksCount({ issueCount: 4, nodes: [noCi, noCi, noCi, noCi] }) === 0, "PRs without any checks must not count as checks running.");
assert(runningChecksCount({ issueCount: 3, nodes: [noCi, running, expected] }) === 2, "Only pending or expected rollups count as checks running.");
assert(runningChecksCount({ issueCount: 150, nodes: [running, noCi] }) === 149, "Matches beyond the fetched page are counted as reported.");
assert(runningChecksCount(undefined) === 0, "A missing search counts as zero.");

// The count searches and the link qualifiers describe the same queues.
for (const key of ["review", "drafts", "checks", "ready"]) {
    assert(queueQualifiers[key] === queueSearches[key], `The ${key} link must use the same filter as its count.`);
}
assert(queueQualifiers.blocked.includes(queueSearches.failing), "The blocked link must include failing checks.");
assert(queueQualifiers.blocked.includes("review:changes_requested"), "The blocked link must include requested changes.");
assert(queueQualifiers.other === "", "The other queue links to every open pull request.");

// Attention signals.
assert(pickAttentionSignal([], now) === undefined, "An empty sample has no signal.");

const conflict = pr({ mergeable: "CONFLICTING", updatedAt: daysAgo(3) });
let signal = pickAttentionSignal([pr({ isDraft: true }), conflict], now);
assert(signal.kind === "conflict" && signal.number === conflict.number, "A conflict must outrank a draft.");
assert(signal.ageDays === 3 && signal.url === conflict.url, "Signals must report age and the pull request link.");

const ready = pr({ reviewDecision: "APPROVED" });
signal = pickAttentionSignal([pr({ isDraft: true }), ready], now);
assert(signal.kind === "ready" && signal.action === "Merge when ready", "Approved, passing, mergeable pull requests must surface as ready.");

// With 7 or more sampled pull requests, a single failure no longer dominates.
const busy = [pr({ statusCheckRollup: { state: "FAILURE" } }), ...Array.from({ length: 6 }, () => pr({ reviewDecision: "APPROVED" }))];
assert(pickAttentionSignal(busy, now).kind === "ready", "One failure among many ready pull requests must not dominate.");
busy.push(pr({ statusCheckRollup: { state: "FAILURE" } }));
assert(pickAttentionSignal(busy, now).kind === "checks-failing", "Two failures in a large sample must surface as blocked.");

// Within a kind, the oldest pull request wins.
const older = pr({ isDraft: true, updatedAt: daysAgo(9) });
signal = pickAttentionSignal([pr({ isDraft: true, updatedAt: daysAgo(2) }), older], now);
assert(signal.number === older.number, "Ties within a kind must surface the oldest pull request.");

console.info("Queue telemetry, attention signal, and owner qualifier tests passed.");
