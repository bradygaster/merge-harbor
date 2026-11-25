// Decision ledger for the organization-wide decision board (#5).
//
// One board per repository. Agents (a repo-specific Squad) propose; humans decide;
// only the execution boundary acts. The invariants this module enforces:
//
//   - Approval to assess is not approval to act. Triage only ever creates proposals.
//   - The unit of approval is an immutable proposal revision, identified by digest.
//     Any revision, by agent or human, invalidates every earlier approval.
//   - A batch is an enumerated, frozen manifest. Confirming it cannot include anything
//     that was not listed when it was prepared, and refuses if any member changed.
//   - Execution re-checks approval, revision, account, repository, issue freshness, and
//     dependencies at the boundary, not in the UI or a prompt.
//   - An intent is recorded before every remote write. Uncertain outcomes are reconciled
//     by observing GitHub before any retry, so a resume never duplicates a write.
//
// Every transition is a pure function: (board, input) -> new board. Persistence and
// GitHub access are injected, which keeps the whole workflow testable without a network.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeRepositoryIdentity, writeFileAtomic } from "./assessment-core.mjs";

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value, maximum = 4000) {
    return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function cleanStringList(value, maximumItems = 20, maximumLength = 1000) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => cleanString(item, maximumLength)).filter(Boolean))].slice(0, maximumItems);
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
}

function digestOf(value, length = 24) {
    return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, length);
}

export class DecisionError extends Error {
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

// ---------------------------------------------------------------------------
// Action vocabulary. Only these types can ever reach the execution boundary.
// Each one normalizes its payload and can tell, from observed GitHub state,
// whether it has already been applied (the basis for reconciliation).
// ---------------------------------------------------------------------------

const closeReasons = new Set(["completed", "not_planned", "duplicate"]);

export const executableActions = {
    add_labels: {
        normalize(payload) {
            const labels = cleanStringList(payload?.labels, 10, 50);
            if (!labels.length) throw new Error("add_labels requires at least one label.");
            return { labels };
        },
        isSatisfied: (observed, payload) => payload.labels.every((label) => observed.labels.includes(label)),
    },
    remove_labels: {
        normalize(payload) {
            const labels = cleanStringList(payload?.labels, 10, 50);
            if (!labels.length) throw new Error("remove_labels requires at least one label.");
            return { labels };
        },
        isSatisfied: (observed, payload) => payload.labels.every((label) => !observed.labels.includes(label)),
    },
    assign: {
        normalize(payload) {
            const assignees = cleanStringList(payload?.assignees, 10, 39);
            if (!assignees.length) throw new Error("assign requires at least one assignee.");
            return { assignees };
        },
        isSatisfied: (observed, payload) => payload.assignees.every((login) => observed.assignees.includes(login)),
    },
    comment: {
        normalize(payload) {
            const body = cleanString(payload?.body, 8000);
            if (!body) throw new Error("comment requires a body.");
            return { body };
        },
        // Comments are the one action whose effect is not a state; a hidden marker makes them observable.
        isSatisfied: (observed, _payload, marker) => observed.commentMarkers.includes(marker),
    },
    close: {
        normalize(payload) {
            const reason = cleanString(payload?.reason, 20) || "completed";
            if (!closeReasons.has(reason)) throw new Error("close reason must be completed, not_planned, or duplicate.");
            const duplicateOf = reason === "duplicate" ? Number(payload?.duplicateOf) : undefined;
            if (reason === "duplicate" && !(Number.isInteger(duplicateOf) && duplicateOf > 0)) {
                throw new Error("close as duplicate requires duplicateOf.");
            }
            return duplicateOf ? { reason, duplicateOf } : { reason };
        },
        isSatisfied: (observed) => observed.state === "closed",
    },
};

// Recommendations a human should see but that the boundary will never execute directly.
// "implement" is handed to a separately approved, bounded remediation session (#9).
export const proposalOnlyKinds = new Set(["investigate", "implement", "no_change", "other"]);

function normalizeAction(action) {
    if (!isRecord(action)) throw new Error("A proposal requires an action.");
    const type = cleanString(action.type, 40);
    if (executableActions[type]) {
        return { type, payload: executableActions[type].normalize(action.payload ?? {}), executable: true };
    }
    if (proposalOnlyKinds.has(type)) {
        return { type, payload: { summary: cleanString(action.payload?.summary, 4000) }, executable: false };
    }
    throw new Error(`Unsupported action type "${type}".`);
}

// ---------------------------------------------------------------------------
// Board and inventory (#7: never silently narrow to the first page).
// ---------------------------------------------------------------------------

export function boardIdFor(repository) {
    return `board-${normalizeRepositoryIdentity(repository).key.replace("/", "__")}`;
}

export function createBoard({ repository, viewer, scope = "all open issues", now = () => new Date().toISOString() }) {
    const identity = normalizeRepositoryIdentity(repository);
    const timestamp = now();
    return {
        id: boardIdFor(identity),
        version: 1,
        repository: identity,
        viewer: cleanString(viewer, 39) || undefined,
        scope,
        inventory: undefined,
        outcomes: {},
        proposals: {},
        decisions: [],
        batches: {},
        executions: {},
        rejectedReports: [],
        cancelled: false,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
}

function touch(board, now) {
    board.updatedAt = now();
    return board;
}

export function recordInventory(board, { pages, expectedTotal, snapshotAt }, { now = () => new Date().toISOString() } = {}) {
    if (!Array.isArray(pages)) throw new Error("Inventory requires the fetched pages.");
    const next = structuredClone(board);
    const issues = {};
    let pullRequestsExcluded = 0;
    let duplicatesAcrossPages = 0;
    for (const page of pages) {
        for (const item of page ?? []) {
            if (item?.pull_request) {
                pullRequestsExcluded += 1;
                continue;
            }
            const number = Number(item?.number);
            if (!Number.isInteger(number) || number < 1) continue;
            if (issues[number]) duplicatesAcrossPages += 1;
            issues[number] = {
                number,
                title: cleanString(item.title, 256),
                state: item.state === "closed" ? "closed" : "open",
                updatedAt: cleanString(item.updated_at ?? item.updatedAt, 40),
            };
        }
    }
    const count = Object.keys(issues).length;
    const gaps = [];
    if (Number.isInteger(expectedTotal) && expectedTotal !== count) {
        gaps.push(`GitHub reported ${expectedTotal} issues in scope but ${count} were enumerated.`);
    }
    next.inventory = {
        snapshotAt: cleanString(snapshotAt, 40) || now(),
        pageCount: pages.length,
        expectedTotal: Number.isInteger(expectedTotal) ? expectedTotal : undefined,
        count,
        pullRequestsExcluded,
        duplicatesAcrossPages,
        gaps,
        issues,
    };
    return touch(next, now);
}

export function coverage(board) {
    const numbers = Object.keys(board.inventory?.issues ?? {}).map(Number);
    const tally = { proposal: 0, no_action: 0, blocked: 0 };
    const uncovered = [];
    for (const number of numbers) {
        const outcome = board.outcomes[number];
        if (outcome) tally[outcome.kind] += 1;
        else uncovered.push(number);
    }
    const gaps = board.inventory?.gaps ?? ["No inventory has been recorded."];
    return {
        total: numbers.length,
        proposed: tally.proposal,
        noAction: tally.no_action,
        blocked: tally.blocked,
        uncovered: uncovered.sort((a, b) => a - b),
        gaps,
        complete: Boolean(board.inventory) && uncovered.length === 0 && gaps.length === 0,
    };
}

// ---------------------------------------------------------------------------
// Proposals and revisions.
// ---------------------------------------------------------------------------

function revisionContent(proposal) {
    return {
        repository: proposal.repository,
        issues: proposal.issues,
        action: proposal.action,
        rationale: proposal.rationale,
        evidence: proposal.evidence,
        uncertainty: proposal.uncertainty,
        dependsOn: proposal.dependsOn,
    };
}

export function currentRevision(board, proposalId) {
    const proposal = board.proposals[proposalId];
    return proposal?.revisions[proposal.revisions.length - 1];
}

function appendRevision(next, proposalId, content, author, now) {
    const digest = digestOf(revisionContent(content));
    const existing = next.proposals[proposalId];
    const latest = existing?.revisions.at(-1);
    if (latest?.digest === digest) return false;
    const revision = { ...content, revision: (latest?.revision ?? 0) + 1, digest, author, createdAt: now() };
    if (existing) existing.revisions.push(revision);
    else next.proposals[proposalId] = { id: proposalId, group: content.group, revisions: [revision] };
    if (content.group) next.proposals[proposalId].group = content.group;
    return true;
}

// Accepts the coordinator's structured triage report. Issue and repository text is
// evidence, never permission: nothing here can produce anything but a proposal.
export function ingestTriage(board, report, { author = "squad", now = () => new Date().toISOString() } = {}) {
    if (!board.inventory) throw new DecisionError("no_inventory", "Record the issue inventory before triage.");
    if (!isRecord(report)) throw new DecisionError("invalid_report", "Triage report must be an object.");
    const next = structuredClone(board);
    const known = next.inventory.issues;
    const errors = [];
    const ingested = { created: 0, revised: 0, unchanged: 0 };

    const resolveIssues = (numbers, context) => {
        const list = [...new Set((Array.isArray(numbers) ? numbers : [numbers]).map(Number))];
        const unknown = list.filter((number) => !known[number]);
        if (!list.length || unknown.length) {
            errors.push(`${context}: references issues outside the inventory (${unknown.join(", ") || "none given"}).`);
            return undefined;
        }
        return list.sort((a, b) => a - b).map((number) => ({ number, updatedAt: known[number].updatedAt }));
    };

    const pending = [];
    for (const [index, raw] of (report.proposals ?? []).entries()) {
        const key = cleanString(raw?.key, 80).replace(/[^A-Za-z0-9._-]/g, "-");
        const context = `Proposal ${key || index + 1}`;
        if (!key) {
            errors.push(`${context}: requires a stable key.`);
            continue;
        }
        const issues = resolveIssues(raw.issues, context);
        if (!issues) continue;
        let action;
        try {
            action = normalizeAction(raw.action);
        } catch (error) {
            errors.push(`${context}: ${error.message}`);
            continue;
        }
        const evidence = cleanStringList(raw.evidence, 20, 2000);
        const rationale = cleanString(raw.rationale, 4000);
        if (!rationale || !evidence.length) {
            errors.push(`${context}: requires rationale and evidence.`);
            continue;
        }
        pending.push({
            id: `${next.repository.key}:${key}`,
            content: {
                repository: next.repository.key,
                issues,
                action,
                rationale,
                evidence,
                uncertainty: cleanString(raw.uncertainty, 2000),
                dependsOn: cleanStringList(raw.dependsOn, 20, 80).map((dep) => `${next.repository.key}:${dep}`),
                group: cleanString(raw.group, 120) || undefined,
            },
        });
    }

    const ids = new Set([...Object.keys(next.proposals), ...pending.map((item) => item.id)]);
    for (const item of pending) {
        const missing = item.content.dependsOn.filter((dep) => !ids.has(dep));
        if (missing.length) {
            errors.push(`Proposal ${item.id}: depends on unknown proposals (${missing.join(", ")}).`);
            continue;
        }
        const existed = Boolean(next.proposals[item.id]);
        const changed = appendRevision(next, item.id, item.content, author, now);
        ingested[!changed ? "unchanged" : existed ? "revised" : "created"] += 1;
        for (const issue of item.content.issues) {
            next.outcomes[issue.number] = { kind: "proposal", ref: item.id };
        }
    }

    for (const entry of report.noAction ?? []) {
        const issues = resolveIssues(entry?.issue, `No-action result for #${entry?.issue}`);
        const rationale = cleanString(entry?.rationale, 2000);
        if (!issues) continue;
        if (!rationale) {
            errors.push(`No-action result for #${entry.issue}: requires a rationale.`);
            continue;
        }
        if (next.outcomes[issues[0].number]?.kind !== "proposal") {
            next.outcomes[issues[0].number] = { kind: "no_action", rationale };
        }
    }
    for (const entry of report.blocked ?? []) {
        const issues = resolveIssues(entry?.issue, `Blocked result for #${entry?.issue}`);
        if (!issues) continue;
        if (!next.outcomes[issues[0].number]) {
            next.outcomes[issues[0].number] = { kind: "blocked", reason: cleanString(entry.reason, 2000) || "Blocked without a reason." };
        }
    }
    if (errors.length) next.rejectedReports.push({ at: now(), errors });
    return { board: touch(next, now), ingested, errors };
}

export function reviseProposal(board, proposalId, changes, { reviewer, now = () => new Date().toISOString() }) {
    const latest = currentRevision(board, proposalId);
    if (!latest) throw new DecisionError("unknown_proposal", `Proposal ${proposalId} was not found.`);
    if (!cleanString(reviewer, 39)) throw new DecisionError("reviewer_required", "A revision requires a reviewer.");
    const next = structuredClone(board);
    const content = {
        ...latest,
        action: changes.action ? normalizeAction(changes.action) : latest.action,
        rationale: cleanString(changes.rationale, 4000) || latest.rationale,
    };
    appendRevision(next, proposalId, content, `human:${reviewer}`, now);
    return touch(next, now);
}

// ---------------------------------------------------------------------------
// Decisions and batches (#8).
// ---------------------------------------------------------------------------

export function latestDecision(board, proposalId) {
    for (let index = board.decisions.length - 1; index >= 0; index -= 1) {
        if (board.decisions[index].proposalId === proposalId) return board.decisions[index];
    }
    return undefined;
}

// approved | rejected | undecided | superseded (a decision exists, but for an older revision)
export function decisionState(board, proposalId) {
    const decision = latestDecision(board, proposalId);
    if (!decision) return "undecided";
    const latest = currentRevision(board, proposalId);
    if (decision.digest !== latest?.digest) return "superseded";
    return decision.verdict;
}

function assertCurrent(board, { proposalId, revision, digest }) {
    const latest = currentRevision(board, proposalId);
    if (!latest) throw new DecisionError("unknown_proposal", `Proposal ${proposalId} was not found.`);
    if (latest.revision !== revision || latest.digest !== digest) {
        throw new DecisionError(
            "stale_revision",
            `Proposal ${proposalId} is now revision ${latest.revision}; the reviewed revision ${revision} is no longer current.`,
        );
    }
    return latest;
}

export function decide(board, { proposalId, revision, digest, verdict, reviewer, note }, { now = () => new Date().toISOString() } = {}) {
    if (!["approved", "rejected"].includes(verdict)) throw new DecisionError("invalid_verdict", "Verdict must be approved or rejected.");
    const who = cleanString(reviewer, 39);
    if (!who || who.startsWith("squad")) throw new DecisionError("reviewer_required", "Decisions require a human reviewer.");
    assertCurrent(board, { proposalId, revision, digest });
    const next = structuredClone(board);
    next.decisions.push({ proposalId, revision, digest, verdict, reviewer: who, note: cleanString(note, 2000) || undefined, decidedAt: now() });
    return touch(next, now);
}

export function prepareBatch(board, proposalIds, { verdict, now = () => new Date().toISOString() }) {
    if (!["approved", "rejected"].includes(verdict)) throw new DecisionError("invalid_verdict", "Verdict must be approved or rejected.");
    const ids = [...new Set(proposalIds)].sort();
    if (!ids.length) throw new DecisionError("empty_batch", "A batch requires at least one proposal.");
    const members = ids.map((proposalId) => {
        const latest = currentRevision(board, proposalId);
        if (!latest) throw new DecisionError("unknown_proposal", `Proposal ${proposalId} was not found.`);
        return { proposalId, revision: latest.revision, digest: latest.digest };
    });
    const inBatch = new Set(ids);
    const conflicts = verdict !== "approved" ? [] : members.flatMap(({ proposalId }) =>
        currentRevision(board, proposalId).dependsOn
            .filter((dep) => !inBatch.has(dep) && decisionState(board, dep) !== "approved")
            .map((dep) => ({ proposalId, dependsOn: dep, state: decisionState(board, dep) })));
    const manifest = {
        repository: board.repository.key,
        verdict,
        members,
        issues: [...new Set(members.flatMap(({ proposalId }) => currentRevision(board, proposalId).issues.map((issue) => issue.number)))].sort((a, b) => a - b),
        executable: members.filter(({ proposalId }) => currentRevision(board, proposalId).action.executable).length,
        conflicts,
    };
    const token = `batch-${digestOf(manifest, 20)}`;
    const next = structuredClone(board);
    next.batches[token] = { token, manifest, status: "prepared", preparedAt: now() };
    return { board: touch(next, now), token, manifest };
}

export function confirmBatch(board, token, { reviewer, now = () => new Date().toISOString() }) {
    const batch = board.batches[token];
    if (!batch) throw new DecisionError("unknown_batch", "The batch was not found.");
    if (batch.status !== "prepared") throw new DecisionError("batch_closed", `The batch is already ${batch.status}.`);
    if (batch.manifest.conflicts.length) {
        throw new DecisionError("dependency_conflict", "The batch approves proposals whose dependencies are not approved.", batch.manifest.conflicts);
    }
    const stale = batch.manifest.members.filter((member) => currentRevision(board, member.proposalId)?.digest !== member.digest);
    if (stale.length) {
        throw new DecisionError("stale_batch", "Proposals changed after the batch was prepared. Prepare and review a new batch.", stale);
    }
    let next = structuredClone(board);
    for (const member of batch.manifest.members) {
        next = decide(next, { ...member, verdict: batch.manifest.verdict, reviewer }, { now });
        next.decisions.at(-1).batch = token;
    }
    next.batches[token].status = "confirmed";
    next.batches[token].confirmedBy = reviewer;
    next.batches[token].confirmedAt = now();
    return touch(next, now);
}

// ---------------------------------------------------------------------------
// Execution boundary (#9).
// ---------------------------------------------------------------------------

export function executionKey(proposalId, revision) {
    return `${proposalId}@${revision.revision}:${revision.digest}`;
}

export function executionMarker(board, proposalId, revision) {
    return `merge-harbor-decision-${digestOf({ board: board.id, key: executionKey(proposalId, revision) }, 32)}`;
}

function refusal(code, reason) {
    return { ok: false, code, reason };
}

// Freshness policy: an issue is fresh if its updatedAt equals the evidence revision,
// or equals a timestamp observed right after one of this board's own verified writes.
// Any other change means someone or something else touched it: re-triage and re-approve.
function acceptedIssueVersions(board, number, evidenceUpdatedAt) {
    const versions = new Set([evidenceUpdatedAt]);
    for (const execution of Object.values(board.executions)) {
        if (execution.status === "succeeded") {
            for (const [issue, updatedAt] of Object.entries(execution.observedAfter ?? {})) {
                if (Number(issue) === number) versions.add(updatedAt);
            }
        }
    }
    return versions;
}

export function authorize(board, proposalId, { context, observed }) {
    if (board.cancelled) return refusal("cancelled", "The board's execution was cancelled.");
    const latest = currentRevision(board, proposalId);
    if (!latest) return refusal("unknown_proposal", `Proposal ${proposalId} was not found.`);
    if (!latest.action.executable) return refusal("not_executable", `"${latest.action.type}" is a recommendation, not an executable action.`);
    const state = decisionState(board, proposalId);
    if (state !== "approved") return refusal(state === "superseded" ? "stale_revision" : state, `Proposal is ${state}, not approved at revision ${latest.revision}.`);
    if (context?.repositoryKey !== board.repository.key) return refusal("wrong_repository", `Execution context targets ${context?.repositoryKey}, not ${board.repository.key}.`);
    if (board.viewer && context?.viewer !== board.viewer) return refusal("account_changed", `Signed in as ${context?.viewer}, but the board was assessed as ${board.viewer}.`);
    for (const dep of latest.dependsOn) {
        const depRevision = currentRevision(board, dep);
        const depDone = depRevision?.action.executable
            ? board.executions[executionKey(dep, depRevision)]?.status === "succeeded"
            : decisionState(board, dep) === "approved";
        if (!depDone) return refusal("dependency_blocked", `Depends on ${dep}, which is not complete.`);
    }
    for (const issue of latest.issues) {
        const current = observed?.[issue.number];
        if (!current) return refusal("issue_unavailable", `Issue #${issue.number} could not be observed.`);
        if (!acceptedIssueVersions(board, issue.number, issue.updatedAt).has(current.updatedAt)) {
            return refusal("stale_evidence", `Issue #${issue.number} changed after triage (${issue.updatedAt} → ${current.updatedAt}). Re-triage before acting.`);
        }
    }
    return { ok: true, revision: latest };
}

function dependencyOrder(board, proposalIds) {
    const wanted = new Set(proposalIds);
    const ordered = [];
    const seen = new Set();
    const visit = (id, trail) => {
        if (seen.has(id)) return;
        if (trail.has(id)) throw new DecisionError("dependency_cycle", `Dependency cycle at ${id}.`);
        trail.add(id);
        for (const dep of currentRevision(board, id)?.dependsOn ?? []) if (wanted.has(dep)) visit(dep, trail);
        trail.delete(id);
        seen.add(id);
        ordered.push(id);
    };
    for (const id of [...wanted].sort()) visit(id, new Set());
    return ordered;
}

// adapter: {
//   context(): Promise<{ viewer, repositoryKey }>
//   observe(numbers, { markers, actionType }): Promise<{ [number]: { updatedAt, state, labels, assignees, commentMarkers } }>
//   apply({ number, action, marker }): Promise<{ url? }>
// }
// persist(board) is awaited after every state change, so an intent is durable before its write.
export async function executeApproved(board, proposalIds, { adapter, persist = async () => {}, now = () => new Date().toISOString() }) {
    let current = structuredClone(board);
    const results = [];
    const save = async () => {
        touch(current, now);
        await persist(current);
    };
    const context = await adapter.context();

    for (const proposalId of dependencyOrder(current, proposalIds)) {
        if (current.cancelled) {
            results.push({ proposalId, status: "not_dispatched", code: "cancelled" });
            continue;
        }
        const latest = currentRevision(current, proposalId);
        const key = latest ? executionKey(proposalId, latest) : proposalId;
        const marker = latest ? executionMarker(current, proposalId, latest) : "";
        const prior = current.executions[key];
        if (prior?.status === "succeeded") {
            results.push({ proposalId, status: "succeeded", duplicate: true });
            continue;
        }
        const numbers = latest?.issues.map((issue) => issue.number) ?? [];
        const handler = latest && executableActions[latest.action.type];
        const observedBefore = numbers.length ? await adapter.observe(numbers, { markers: [marker], actionType: latest?.action.type }) : {};

        // Reconcile before retrying: a prior attempt may have landed without being recorded.
        if (prior && handler && numbers.every((n) => observedBefore[n] && handler.isSatisfied(observedBefore[n], latest.action.payload, marker))) {
            current.executions[key] = {
                ...prior,
                status: "succeeded",
                reconciled: true,
                observedAfter: Object.fromEntries(numbers.map((n) => [n, observedBefore[n].updatedAt])),
                completedAt: now(),
            };
            await save();
            results.push({ proposalId, status: "succeeded", reconciled: true });
            continue;
        }

        // The prior attempt changed the issue's updatedAt only if it landed; it didn't, so normal checks apply.
        const verdict = authorize(current, proposalId, { context, observed: observedBefore });
        if (!verdict.ok) {
            results.push({ proposalId, status: "refused", code: verdict.code, reason: verdict.reason });
            continue;
        }

        current.executions[key] = {
            key,
            proposalId,
            revision: latest.revision,
            digest: latest.digest,
            marker,
            status: "dispatching",
            attempts: (prior?.attempts ?? 0) + 1,
            approvedBy: latestDecision(current, proposalId).reviewer,
            startedAt: now(),
        };
        await save();

        const remote = [];
        try {
            for (const number of numbers) {
                remote.push({ number, ...(await adapter.apply({ number, action: latest.action, marker })) });
            }
        } catch (error) {
            // We cannot know whether the write landed. Never report success or failure we didn't observe.
            current.executions[key] = { ...current.executions[key], status: "unknown", error: cleanString(error.message, 1000) };
            await save();
            results.push({ proposalId, status: "unknown", reason: error.message });
            continue;
        }

        const observedAfter = await adapter.observe(numbers, { markers: [marker], actionType: latest?.action.type });
        const verified = numbers.every((n) => observedAfter[n] && handler.isSatisfied(observedAfter[n], latest.action.payload, marker));
        current.executions[key] = {
            ...current.executions[key],
            status: verified ? "succeeded" : "unknown",
            remote,
            observedAfter: verified ? Object.fromEntries(numbers.map((n) => [n, observedAfter[n].updatedAt])) : undefined,
            completedAt: now(),
        };
        await save();
        results.push({ proposalId, status: verified ? "succeeded" : "unknown", remote });
    }
    return { board: current, results };
}

export function cancel(board, { reviewer, now = () => new Date().toISOString() }) {
    const next = structuredClone(board);
    next.cancelled = { by: cleanString(reviewer, 39), at: now() };
    return touch(next, now);
}

// ---------------------------------------------------------------------------
// Organization view (#10). Groups are views over repo-scoped proposals; they
// never carry approval of their own, and missing data is a gap, never zero.
// ---------------------------------------------------------------------------

export function aggregate(boards, { accessible = () => true, staleBefore } = {}) {
    const repositories = [];
    const groups = new Map();
    for (const board of boards) {
        const key = board.repository.key;
        if (!accessible(key)) {
            repositories.push({ repository: key, status: "inaccessible", coverage: undefined });
            continue;
        }
        const stats = { approved: 0, rejected: 0, undecided: 0, superseded: 0, executed: 0 };
        for (const proposalId of Object.keys(board.proposals)) {
            stats[decisionState(board, proposalId)] += 1;
            const latest = currentRevision(board, proposalId);
            if (board.executions[executionKey(proposalId, latest)]?.status === "succeeded") stats.executed += 1;
            const group = board.proposals[proposalId].group;
            if (group) {
                if (!groups.has(group)) groups.set(group, []);
                groups.get(group).push({ repository: key, proposalId, revision: latest.revision, state: decisionState(board, proposalId) });
            }
        }
        const stale = Boolean(staleBefore && board.inventory && board.inventory.snapshotAt < staleBefore);
        repositories.push({ repository: key, status: stale ? "stale" : "current", coverage: coverage(board), decisions: stats });
    }
    return {
        repositories,
        sharedBlockers: [...groups.entries()]
            .map(([group, members]) => ({ group, repositories: [...new Set(members.map((m) => m.repository))], members }))
            .filter((entry) => entry.members.length > 1)
            .sort((a, b) => b.repositories.length - a.repositories.length || b.members.length - a.members.length),
        gaps: repositories.filter((repo) => repo.status !== "current" || !repo.coverage?.complete).map((repo) => repo.repository),
    };
}

// ---------------------------------------------------------------------------
// Durable storage, one file per board, written atomically.
// ---------------------------------------------------------------------------

export function createDecisionStore(directory) {
    const boardDirectory = join(directory, "boards");
    const pathOf = (id) => join(boardDirectory, `${id}.json`);
    return {
        read(id) {
            try {
                return JSON.parse(readFileSync(pathOf(id), "utf8"));
            } catch {
                return undefined;
            }
        },
        write(board) {
            writeFileAtomic(pathOf(board.id), `${JSON.stringify(board, null, 2)}\n`);
            return board;
        },
        list() {
            let names = [];
            try {
                names = readdirSync(boardDirectory);
            } catch {
                return [];
            }
            return names.filter((name) => name.endsWith(".json")).map((name) => this.read(name.slice(0, -5))).filter(Boolean);
        },
    };
}
