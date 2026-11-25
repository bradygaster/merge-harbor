import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const activeStatuses = new Set(["queued", "in_progress"]);
export const assessmentInterruptionTimeoutMs = 30 * 60 * 1000;
const severities = new Set(["critical", "high", "medium", "low"]);
const confidences = new Set(["high", "medium", "low"]);

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value, maximum = 4000) {
    return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function cleanStringList(value, maximumItems = 20, maximumLength = 1000) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => cleanString(item, maximumLength))
        .filter(Boolean)
        .slice(0, maximumItems);
}

export function normalizeRepositoryIdentity(value) {
    if (!isRecord(value)) {
        throw new Error("Repository owner and name are required.");
    }
    const owner = cleanString(value.owner, 100);
    const name = cleanString(value.name, 100);
    const componentPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
    if (!componentPattern.test(owner) || !componentPattern.test(name) || name.endsWith(".git")) {
        throw new Error("Repository owner and name must form a valid GitHub repository identity.");
    }
    return { owner, name, key: `${owner.toLowerCase()}/${name.toLowerCase()}` };
}

export function buildAssessmentPrompt(mission) {
    return `Coordinate a conservative, read-only repository assessment for ${mission.repository.owner}/${mission.repository.name}.

Mission ID: ${mission.id}
Target: ${mission.repository.defaultBranch} at exact commit ${mission.repository.targetSha}

Non-negotiable safety boundaries:
- Create and use an isolated local clone or disposable worktree that you manage at the exact target commit. Never use or modify the user's existing checkout.
- Disable pushing in the assessment clone/worktree. Do not configure or use credentials for remote writes.
- Prohibit every remote write: no pushes, issue creation, pull request creation, label changes, comments, releases, workflow dispatches, repository settings changes, or code publication.
- Default to static, read-only inspection. Do not run repository tests, builds, scripts, hooks, package installs, package-manager commands, or any executable repository code.
- A local clone or worktree provides filesystem separation only; it is not execution isolation.
- If executing repository code is necessary, stop and request a separate explicit user approval. Execution may proceed only after that approval and only inside a real isolated sandbox with secrets removed and outbound network access restricted.
- Clean up disposable local clones and worktrees when the assessment is complete.
- Use a bounded temporary specialist team of at most three specialists, only where their scopes are distinct. Do not start organization-wide, cross-repository, remediation, or publication work.
- Consolidate duplicate symptoms into root causes. Report evidence, dependencies, severity, confidence, and reviewable draft issue title/body. Nothing may be published automatically.

Use the globally registered merge_harbor_report_repository_assessment tool to report progress and the final structured findings for mission ${mission.id}. Report failures through the same tool.`;
}

export function recoverInterruptedMissions(store, {
    nowMs = Date.now(),
    staleAfterMs = assessmentInterruptionTimeoutMs,
} = {}) {
    const recovered = [];
    for (const mission of store.list()) {
        if (mission.status !== "in_progress") continue;
        const updatedAtMs = Date.parse(mission.updatedAt);
        const ageMs = nowMs - updatedAtMs;
        if (Number.isFinite(updatedAtMs) && ageMs >= 0 && ageMs < staleAfterMs) continue;
        recovered.push(store.update(mission.id, {
            status: "failed",
            phase: "Assessment interrupted",
            message: "The assessment stopped before results were reported. Select Retry assessment to try again safely.",
            findings: [],
        }));
    }
    return recovered;
}

export function validateMissionUpdate(value) {
    if (!isRecord(value)) throw new Error("Mission update must be an object.");
    const missionId = cleanString(value.missionId, 120);
    const status = cleanString(value.status, 40);
    if (!missionId) throw new Error("missionId is required.");
    if (!["in_progress", "completed", "failed"].includes(status)) {
        throw new Error("status must be in_progress, completed, or failed.");
    }
    const phase = cleanString(value.phase, 120);
    const message = cleanString(value.message, 2000);
    if (!message) throw new Error("message is required.");
    const findings = status === "completed"
        ? validateFindings(value.findings)
        : [];
    return { missionId, status, phase, message, findings };
}

export function validateFindings(value) {
    if (!Array.isArray(value)) throw new Error("Completed missions require a findings array.");
    return value.map((finding, index) => {
        if (!isRecord(finding)) throw new Error(`Finding ${index + 1} must be an object.`);
        const rootCause = cleanString(finding.rootCause, 500);
        const severity = cleanString(finding.severity, 20).toLowerCase();
        const confidence = cleanString(finding.confidence, 20).toLowerCase();
        const evidence = cleanStringList(finding.evidence, 20, 2000);
        const dependencies = cleanStringList(finding.dependencies, 20, 500);
        const draftIssue = isRecord(finding.draftIssue) ? finding.draftIssue : {};
        const title = cleanString(draftIssue.title, 256);
        const body = cleanString(draftIssue.body, 12000);
        if (!rootCause || !severities.has(severity) || !confidences.has(confidence)) {
            throw new Error(`Finding ${index + 1} requires rootCause, severity, and confidence.`);
        }
        if (!evidence.length) throw new Error(`Finding ${index + 1} requires evidence.`);
        if (!title || !body) throw new Error(`Finding ${index + 1} requires a draft issue title and body.`);
        return { rootCause, severity, confidence, evidence, dependencies, draftIssue: { title, body } };
    }).slice(0, 50);
}

export function assessmentFindingIdentity(mission, findingIndex) {
    const finding = mission?.findings?.[findingIndex];
    if (!finding) return "";
    const digest = createHash("sha256")
        .update([
            mission.id,
            String(findingIndex),
            finding.rootCause,
            finding.draftIssue?.title,
            finding.draftIssue?.body,
        ].join("\0"))
        .digest("hex")
        .slice(0, 20);
    return `finding-${findingIndex}-${digest}`;
}

export function assessmentIssueMarker(mission, findingIndex) {
    const identity = assessmentFindingIdentity(mission, findingIndex);
    if (!identity) return "";
    const digest = createHash("sha256")
        .update(`${mission.id}\0${identity}`)
        .digest("hex")
        .slice(0, 32);
    return `merge-harbor-assessment-${digest}`;
}

function normalizePublishedIssue(issue) {
    const number = Number(issue?.number);
    const url = cleanString(issue?.url ?? issue?.html_url, 2000);
    if (!Number.isInteger(number) || number < 1 || !/^https:\/\/[^/]+\/.+/i.test(url)) {
        throw new Error("GitHub returned an invalid issue result.");
    }
    return { number, url };
}

export async function createAssessmentIssue({
    body,
    store,
    findExistingIssue,
    createIssue,
    now = () => new Date().toISOString(),
}) {
    if (!isRecord(body)) {
        return { statusCode: 400, body: { error: "Issue creation requires a mission and finding reference." } };
    }
    const missionId = cleanString(body.missionId, 120);
    const findingIndex = body.findingIndex;
    const findingIdentity = cleanString(body.findingIdentity, 120);
    if (!missionId || !Number.isInteger(findingIndex) || findingIndex < 0 || !findingIdentity) {
        return { statusCode: 400, body: { error: "The mission ID, finding index, and finding identity are required." } };
    }
    const mission = store.read(missionId);
    if (!mission) {
        return { statusCode: 404, body: { error: "The assessment mission was not found." } };
    }
    if (mission.status !== "completed") {
        return { statusCode: 409, body: { error: "Issues can be created only from a completed assessment." } };
    }
    let repository;
    try {
        repository = normalizeRepositoryIdentity(mission.repository);
    } catch {
        return { statusCode: 422, body: { error: "The assessment target repository is invalid." } };
    }
    if (repository.key !== mission.repository.key) {
        return { statusCode: 422, body: { error: "The assessment target repository does not match its stored identity." } };
    }
    let validatedFindings;
    try {
        validatedFindings = validateFindings(mission.findings);
    } catch {
        return { statusCode: 422, body: { error: "The completed assessment contains invalid finding data." } };
    }
    const storedFinding = mission.findings?.[findingIndex];
    const finding = validatedFindings[findingIndex];
    const expectedIdentity = assessmentFindingIdentity(mission, findingIndex);
    if (!finding || findingIdentity !== expectedIdentity) {
        return { statusCode: 400, body: { error: "The assessment finding reference is invalid or stale." } };
    }
    if (storedFinding.publication) {
        try {
            const issue = normalizePublishedIssue(storedFinding.publication);
            return { statusCode: 200, body: { issue, mission, duplicate: true } };
        } catch {
            return { statusCode: 500, body: { error: "The stored issue publication record is invalid." } };
        }
    }

    const marker = assessmentIssueMarker(mission, findingIndex);
    let issue;
    try {
        issue = await findExistingIssue({ mission, finding, findingIndex, marker });
    } catch (error) {
        return {
            statusCode: 502,
            body: { error: `GitHub could not check for an existing issue. ${error.message}` },
        };
    }
    const reconciled = Boolean(issue);
    if (!issue) {
        try {
            issue = await createIssue({ mission, finding, findingIndex, marker });
        } catch (error) {
            return {
                statusCode: 502,
                body: { error: `GitHub could not create the issue. ${error.message}` },
            };
        }
    }

    let normalizedIssue;
    try {
        normalizedIssue = normalizePublishedIssue(issue);
    } catch (error) {
        return { statusCode: 502, body: { error: error.message } };
    }
    const findings = mission.findings.map((candidate, index) => index === findingIndex
        ? {
            ...candidate,
            publication: {
                ...normalizedIssue,
                createdAt: now(),
            },
        }
        : candidate);
    const updatedMission = store.update(mission.id, { findings });
    return {
        statusCode: reconciled ? 200 : 201,
        body: {
            issue: normalizedIssue,
            mission: updatedMission,
            duplicate: reconciled,
        },
    };
}

// Writes through a temporary file and rename so readers never see a partial file.
export function writeFileAtomic(path, contents) {
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, contents, "utf8");
    renameSync(temporaryPath, path);
}

export function createMissionStore(directory, {
    now = () => new Date().toISOString(),
    idFactory = () => randomUUID(),
} = {}) {
    const missionDirectory = join(directory, "missions");

    function missionPath(id) {
        return join(missionDirectory, `${id}.json`);
    }

    function write(mission) {
        writeFileAtomic(missionPath(mission.id), `${JSON.stringify(mission, null, 2)}\n`);
        return mission;
    }

    function read(id) {
        try {
            const value = JSON.parse(readFileSync(missionPath(id), "utf8"));
            return isRecord(value) ? value : undefined;
        } catch {
            return undefined;
        }
    }

    function list() {
        let names;
        try {
            names = readdirSync(missionDirectory);
        } catch {
            return [];
        }
        return names
            .filter((name) => name.endsWith(".json"))
            .map((name) => read(name.slice(0, -5)))
            .filter(Boolean)
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }

    function findActive(repositoryKey, targetSha) {
        return list().find((mission) =>
            mission.repository?.key === repositoryKey
            && mission.repository?.targetSha === targetSha
            && activeStatuses.has(mission.status));
    }

    function create(repository) {
        const timestamp = now();
        return write({
            id: idFactory(),
            kind: "repository_assessment",
            status: "queued",
            phase: "Preparing isolated assessment",
            message: "Repository assessment in progress",
            repository,
            findings: [],
            createdAt: timestamp,
            updatedAt: timestamp,
        });
    }

    function update(id, change) {
        const current = read(id);
        if (!current) throw new Error(`Mission ${id} was not found.`);
        return write({ ...current, ...change, id: current.id, updatedAt: now() });
    }

    return { create, findActive, list, read, update };
}

export async function beginAssessment({ body, store, resolveRepository }) {
    let identity;
    try {
        identity = normalizeRepositoryIdentity(body);
    } catch (error) {
        return { statusCode: 400, body: { error: error.message } };
    }

    let repository;
    try {
        repository = await resolveRepository(identity.owner, identity.name);
    } catch (error) {
        return { statusCode: 502, body: { error: error.message } };
    }
    if (!repository?.defaultBranch || !repository?.targetSha) {
        return { statusCode: 422, body: { error: "The repository does not expose a readable default branch commit." } };
    }

    const normalizedRepository = {
        owner: repository.owner ?? identity.owner,
        name: repository.name ?? identity.name,
        key: identity.key,
        url: repository.url,
        defaultBranch: repository.defaultBranch,
        targetSha: repository.targetSha,
        viewerPermission: repository.viewerPermission,
    };
    const existing = store.findActive(identity.key, repository.targetSha);
    if (existing) {
        return { statusCode: 200, body: { mission: existing, duplicate: true } };
    }
    const mission = store.create(normalizedRepository);
    return { statusCode: 202, body: { mission, duplicate: false } };
}
