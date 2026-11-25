// Pure pull request queue rules shared by the canvas server and the page.
// No I/O and no Copilot SDK imports, so the rules can be tested directly.

// GitHub search qualifiers for the six mutually exclusive lifecycle queues.
// "blocked" is counted as two searches (failing checks, and changes requested
// without failing checks) because a single OR search is not reliable for counts.
export const queueSearches = Object.freeze({
    failing: "status:failure",
    changesRequested: "review:changes_requested -status:failure",
    review: "review:required draft:false -status:failure",
    drafts: "draft:true -status:failure -review:changes_requested",
    checks: "status:pending draft:false -review:required -review:changes_requested",
    ready: "review:approved status:success draft:false",
});

// Qualifiers used to open each queue on github.com/pulls.
export const queueQualifiers = Object.freeze({
    blocked: "(status:failure OR review:changes_requested)",
    review: queueSearches.review,
    drafts: queueSearches.drafts,
    checks: queueSearches.checks,
    ready: queueSearches.ready,
    other: "",
});

export function ownerSearchQualifier(kind) {
    return kind === "user" ? "user" : "org";
}

export function repoKey(owner, name) {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function toRepoSummary(repo, owner = repo.owner.login) {
    return {
        owner,
        name: repo.name,
        url: repo.url,
        description: repo.description ?? "",
        pushedAt: repo.pushedAt,
        prs: repo.pullRequests.totalCount,
    };
}

// How many pull requests in the "checks" search really have checks running.
// GitHub search reports status:pending for a head commit with no statuses or
// check runs at all, so a repository without CI would otherwise show every PR
// as "Checks running" forever. Fetched nodes are counted only when their rollup
// is pending; matches beyond the fetched page are counted as reported.
export function runningChecksCount(search) {
    if (!search) return 0;
    const nodes = Array.isArray(search.nodes) ? search.nodes : [];
    const running = nodes.filter((pr) => ["PENDING", "EXPECTED"].includes(pr?.statusCheckRollup?.state)).length;
    return running + Math.max(0, (search.issueCount ?? 0) - nodes.length);
}

// Builds the six queue counts from the per-search issue counts and the total.
export function queueMetrics(counts, totalOpen) {
    const metrics = {
        blocked: (counts.failing ?? 0) + (counts.changesRequested ?? 0),
        ready: counts.ready ?? 0,
        review: counts.review ?? 0,
        drafts: counts.drafts ?? 0,
        checks: counts.checks ?? 0,
    };
    metrics.other = Math.max(0, totalOpen - Object.values(metrics).reduce((sum, value) => sum + value, 0));
    return metrics;
}

function classifyPullRequest(pr, now) {
    const checkState = pr.statusCheckRollup?.state ?? "UNKNOWN";
    const ageDays = Math.max(0, Math.floor((now - new Date(pr.updatedAt).getTime()) / 86400000));
    const signal = (kind, reason, action, priority) => ({ kind, reason, action, priority, ageDays, pr });
    if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
        return signal("conflict", "Merge conflict", "Resolve merge conflicts", 0);
    }
    if (checkState === "FAILURE" || checkState === "ERROR") {
        return signal("checks-failing", "Failing checks", "Fix failing checks", 1);
    }
    if (!pr.isDraft && pr.reviewDecision === "APPROVED" && checkState === "SUCCESS" && pr.mergeable === "MERGEABLE") {
        return signal("ready", "Approved and checks passing", "Merge when ready", 2);
    }
    if (pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewRequests?.totalCount > 0) {
        return signal("review", "Review required", "Complete requested review", 3);
    }
    if (pr.isDraft) {
        return signal("draft", "Draft pull request", "Mark ready when complete", 4);
    }
    if (checkState === "PENDING" || checkState === "EXPECTED") {
        return signal("checks-running", "Checks running", "Monitor checks", 5);
    }
    if (ageDays >= 7) {
        return signal("stale", `${ageDays} days without activity`, "Update or close", 6);
    }
    return signal("active", "Recently active", "No intervention needed", 7);
}

const byPriorityThenAge = (a, b) => a.priority - b.priority || b.ageDays - a.ageDays;

// Picks the one recent pull request in a repository that most deserves human
// attention. The sample's dominant condition decides which kinds compete, so a
// repository with several conflicts surfaces a conflict rather than a lone draft.
export function pickAttentionSignal(pullRequests, now = Date.now()) {
    const signals = pullRequests.map((pr) => classifyPullRequest(pr, now));
    const ofKinds = (kinds) => signals.filter((signal) => kinds.includes(signal.kind));
    const blocked = ofKinds(["conflict", "checks-failing"]);
    const ready = ofKinds(["ready"]);
    const waiting = ofKinds(["review", "draft", "stale"]);
    const blockThreshold = pullRequests.length >= 7 ? 2 : 1;
    let candidates;
    if (blocked.length >= blockThreshold) {
        candidates = blocked;
    } else if (ready.length > 0) {
        candidates = ready;
    } else if (waiting.length >= Math.max(1, Math.ceil(pullRequests.length * 0.4))) {
        candidates = waiting;
    } else {
        candidates = ofKinds(["checks-running", "active"]);
    }
    const chosen = [...candidates].sort(byPriorityThenAge)[0] ?? [...signals].sort(byPriorityThenAge)[0];
    if (!chosen) return undefined;
    return {
        kind: chosen.kind,
        reason: chosen.reason,
        action: chosen.action,
        ageDays: chosen.ageDays,
        number: chosen.pr.number,
        title: chosen.pr.title,
        url: chosen.pr.url,
        updatedAt: chosen.pr.updatedAt,
    };
}
