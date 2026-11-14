import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    beginAssessment,
    buildAssessmentPrompt,
    createMissionStore,
    normalizeRepositoryIdentity,
    recoverInterruptedMissions,
    validateMissionUpdate,
} from "../extension/assessment-core.mjs";

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function expectThrow(name, action, message) {
    try {
        action();
    } catch (error) {
        assert(error.message.includes(message), `${name}: expected "${message}", received "${error.message}".`);
        return;
    }
    throw new Error(`${name}: expected an error.`);
}

const directory = mkdtempSync(join(tmpdir(), "merge-harbor-assessment-"));

try {
    let clock = 0;
    const options = {
        now: () => `2026-11-13T18:27:1${clock++}.000Z`,
        idFactory: () => "mission-stable-1",
    };
    const store = createMissionStore(directory, options);
    const resolveRepository = async (owner, name) => ({
        owner,
        name,
        url: `https://github.com/${owner}/${name}`,
        viewerPermission: "READ",
        defaultBranch: "main",
        targetSha: "0123456789abcdef0123456789abcdef01234567",
    });

    expectThrow(
        "invalid identity",
        () => normalizeRepositoryIdentity({ owner: "octodemo", name: "../escape" }),
        "valid GitHub repository identity",
    );

    const invalidRequest = await beginAssessment({
        body: { owner: "", name: "repo" },
        store,
        resolveRepository,
    });
    assert(invalidRequest.statusCode === 400, "Invalid endpoint input must return 400.");

    const created = await beginAssessment({
        body: { owner: "octodemo", name: "sample-repo" },
        store,
        resolveRepository,
    });
    assert(created.statusCode === 202 && !created.body.duplicate, "First assessment request must create a mission.");
    assert(created.body.mission.id === "mission-stable-1", "Mission IDs must be stable domain identifiers.");

    const duplicate = await beginAssessment({
        body: { owner: "octodemo", name: "sample-repo" },
        store,
        resolveRepository,
    });
    assert(duplicate.statusCode === 200 && duplicate.body.duplicate, "Duplicate active clicks must reuse the mission.");
    assert(duplicate.body.mission.id === created.body.mission.id, "Duplicate clicks must not create another mission.");

    const reloadedStore = createMissionStore(directory);
    assert(reloadedStore.read(created.body.mission.id)?.repository?.targetSha === created.body.mission.repository.targetSha,
        "Mission state must survive store recreation.");

    const prompt = buildAssessmentPrompt(created.body.mission);
    [
        "isolated local clone or disposable worktree",
        "exact target commit",
        "Never use or modify the user's existing checkout",
        "Disable pushing",
        "no pushes, issue creation, pull request creation, label changes",
        "Default to static, read-only inspection",
        "Do not run repository tests, builds, scripts, hooks, package installs",
        "filesystem separation only; it is not execution isolation",
        "separate explicit user approval",
        "real isolated sandbox with secrets removed and outbound network access restricted",
        "at most three specialists",
        "Nothing may be published automatically",
        "merge_harbor_report_repository_assessment",
    ].forEach((clause) => assert(prompt.includes(clause), `Prompt is missing safety clause: ${clause}`));

    const update = validateMissionUpdate({
        missionId: created.body.mission.id,
        status: "completed",
        phase: "Consolidating findings",
        message: "Assessment complete.",
        findings: [{
            rootCause: "The cache key omits the repository owner.",
            severity: "high",
            confidence: "high",
            evidence: ["src/cache.mjs:42 constructs the key from name only."],
            dependencies: ["Repository catalog cache"],
            draftIssue: {
                title: "Include repository owner in cache keys",
                body: "## Problem\nCache entries can collide across owners.\n\n## Evidence\n`src/cache.mjs:42`.",
            },
        }],
    });
    const completed = reloadedStore.update(update.missionId, update);
    assert(completed.status === "completed" && completed.findings.length === 1,
        "Validated callback updates must persist structured findings.");

    expectThrow(
        "malformed completed result",
        () => validateMissionUpdate({
            missionId: created.body.mission.id,
            status: "completed",
            message: "Done",
            findings: [{ rootCause: "Missing evidence", severity: "high", confidence: "high", draftIssue: { title: "x", body: "y" } }],
        }),
        "requires evidence",
    );
    expectThrow(
        "invalid callback status",
        () => validateMissionUpdate({ missionId: "x", status: "published", message: "No." }),
        "status must be",
    );

    let recoveryClock = "2026-11-13T18:00:00.000Z";
    let recoveryId = 0;
    const recoveryStore = createMissionStore(join(directory, "recovery"), {
        now: () => recoveryClock,
        idFactory: () => `recovery-mission-${++recoveryId}`,
    });
    const interrupted = recoveryStore.create({
        owner: "octodemo",
        name: "interrupted-repo",
        key: "octodemo/interrupted-repo",
        defaultBranch: "main",
        targetSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    recoveryStore.update(interrupted.id, {
        status: "in_progress",
        phase: "Inspecting repository",
        message: "Repository assessment in progress",
    });
    recoveryClock = "2026-11-13T18:31:00.000Z";
    const recovered = recoverInterruptedMissions(recoveryStore, {
        nowMs: Date.parse(recoveryClock),
        staleAfterMs: 30 * 60 * 1000,
    });
    assert(recovered.length === 1, "A stale in-progress mission must be recovered after the bounded timeout.");
    assert(recovered[0].status === "failed", "Interrupted missions must stop blocking future assessments.");
    assert(recovered[0].message.includes("Assess repository"), "Interrupted mission copy must provide a clear retry action.");
    const retry = await beginAssessment({
        body: { owner: "octodemo", name: "interrupted-repo" },
        store: recoveryStore,
        resolveRepository: async (owner, name) => ({
            owner,
            name,
            defaultBranch: "main",
            targetSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
    });
    assert(retry.statusCode === 202 && retry.body.mission.id !== interrupted.id,
        "A recovered mission must allow a new assessment attempt.");

    const queued = recoveryStore.create({
        owner: "octodemo",
        name: "queued-repo",
        key: "octodemo/queued-repo",
        defaultBranch: "main",
        targetSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    recoveryClock = "2026-11-13T20:00:00.000Z";
    recoverInterruptedMissions(recoveryStore, {
        nowMs: Date.parse(recoveryClock),
        staleAfterMs: 30 * 60 * 1000,
    });
    assert(recoveryStore.read(queued.id).status === "queued",
        "Queued missions must remain available for safe startup requeue.");

    const malformedTimestamp = recoveryStore.create({
        owner: "octodemo",
        name: "malformed-time-repo",
        key: "octodemo/malformed-time-repo",
        defaultBranch: "main",
        targetSha: "cccccccccccccccccccccccccccccccccccccccc",
    });
    recoveryClock = "not-a-timestamp";
    recoveryStore.update(malformedTimestamp.id, { status: "in_progress" });
    recoverInterruptedMissions(recoveryStore, {
        nowMs: Date.parse("2026-11-13T20:00:00.000Z"),
        staleAfterMs: 30 * 60 * 1000,
    });
    assert(recoveryStore.read(malformedTimestamp.id).status === "failed",
        "Malformed durable timestamps must fail safe instead of blocking assessments indefinitely.");

    console.info("Repository assessment persistence, endpoint, prompt, callback, and malformed-result tests passed.");
} finally {
    rmSync(directory, { recursive: true, force: true });
}
