import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
import {
    assessmentFindingIdentity,
    beginAssessment,
    buildAssessmentPrompt,
    createAssessmentIssue,
    createMissionStore,
    assessmentInterruptionTimeoutMs,
    recoverInterruptedMissions,
    validateMissionUpdate,
    writeFileAtomic,
} from "./assessment-core.mjs";
import {
    ownerSearchQualifier,
    pickAttentionSignal,
    queueMetrics,
    queueQualifiers,
    queueSearches,
    repoKey,
    toRepoSummary,
} from "./queue-telemetry.mjs";
import { createDecisionStore } from "./decision-core.mjs";
import { createDecisionService } from "./decision-service.mjs";

const servers = new Map();
const execFileAsync = promisify(execFile);
const pageHtml = readFileSync(new URL("./merge-harbor.html", import.meta.url), "utf8");
const legacyPreferencesUrl = new URL("./preferences.json", import.meta.url);
const copilotHome = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
const preferencesDirectory = join(copilotHome, "extensions", "merge-harbor", "artifacts");
const preferencesPath = join(preferencesDirectory, "preferences.json");
const missionStore = createMissionStore(preferencesDirectory);
const catalogCache = new Map();
const catalogCacheTtlMs = 5 * 60 * 1000;
const repositoryTelemetryCache = new Map();
const repositoryTelemetryCacheTtlMs = 5 * 60 * 1000;
const missionTimeouts = new Map();
const issueCreationPromises = new Map();
const decisionService = createDecisionService({
    store: createDecisionStore(preferencesDirectory),
    runGh: ghRaw,
    broadcast: (event, payload) => broadcastAll(event, payload),
});

function readPreferences() {
    let preferences;
    try {
        preferences = JSON.parse(readFileSync(preferencesPath, "utf8"));
    } catch {
        preferences = migrateLegacyPreferences();
    }
    const seen = new Set();
    const myRepos = Array.isArray(preferences.myRepos)
        ? preferences.myRepos
            .filter((repo) => repo && typeof repo.owner === "string" && typeof repo.name === "string")
            .map((repo) => ({ owner: repo.owner.trim(), name: repo.name.trim() }))
            .filter((repo) => repo.owner && repo.name)
            .filter((repo) => {
                const key = repoKey(repo.owner, repo.name);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
        : [];
    return {
        selectedOwner: typeof preferences.selectedOwner === "string" ? preferences.selectedOwner : undefined,
        myRepos,
    };
}

// Preferences beside the extension code can be deleted by an update or
// reinstall. Copy any found there into the artifacts directory once.
function migrateLegacyPreferences() {
    let legacy;
    try {
        legacy = JSON.parse(readFileSync(legacyPreferencesUrl, "utf8"));
    } catch {
        return {};
    }
    try {
        writePreferences(legacy);
    } catch {
        // Keep using the legacy values for this read; the next write persists them.
    }
    return legacy;
}

function writePreferences(preferences) {
    writeFileAtomic(preferencesPath, `${JSON.stringify(preferences, null, 2)}\n`);
}

function rememberSelectedOwner(login) {
    const preferences = readPreferences();
    if (preferences.selectedOwner !== login) {
        writePreferences({ ...preferences, selectedOwner: login });
    }
}

async function ghApi(args) {
    const { stdout } = await execFileAsync("gh", ["api", ...args], {
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
    });
    return JSON.parse(stdout);
}

// Raw stdout for callers that handle empty responses (DELETE) and their own parsing.
async function ghRaw(args) {
    const { stdout } = await execFileAsync("gh", ["api", ...args], {
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
    });
    return stdout;
}

function ghFailureMessage(error) {
    const message = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    return message ? message.slice(0, 1000) : "The authenticated GitHub CLI request failed.";
}

async function findExistingAssessmentIssue({ mission, marker }) {
    try {
        const query = `repo:${mission.repository.owner}/${mission.repository.name} is:issue in:body ${marker}`;
        const result = await ghApi([
            "--method", "GET",
            "search/issues",
            "--raw-field", `q=${query}`,
            "--raw-field", "per_page=10",
        ]);
        const issue = result.items?.find((candidate) => candidate.body?.includes(`<!-- ${marker} -->`));
        return issue ? { number: issue.number, url: issue.html_url } : undefined;
    } catch (error) {
        throw new Error(ghFailureMessage(error));
    }
}

async function publishAssessmentIssue({ mission, finding, marker }) {
    try {
        const repositoryPath = `repos/${encodeURIComponent(mission.repository.owner)}/${encodeURIComponent(mission.repository.name)}/issues`;
        const issue = await ghApi([
            "--method", "POST",
            repositoryPath,
            "--raw-field", `title=${finding.draftIssue.title}`,
            "--raw-field", `body=${finding.draftIssue.body}\n\n<!-- ${marker} -->`,
        ]);
        return { number: issue.number, url: issue.html_url };
    } catch (error) {
        throw new Error(ghFailureMessage(error));
    }
}

function createAssessmentIssueOnce(body) {
    const key = `${body?.missionId ?? ""}:${body?.findingIndex ?? ""}:${body?.findingIdentity ?? ""}`;
    const pending = issueCreationPromises.get(key);
    if (pending) return pending;
    const promise = createAssessmentIssue({
        body,
        store: missionStore,
        findExistingIssue: findExistingAssessmentIssue,
        createIssue: publishAssessmentIssue,
    }).finally(() => issueCreationPromises.delete(key));
    issueCreationPromises.set(key, promise);
    return promise;
}

async function listOrganizations() {
    const preferences = readPreferences();
    const [viewer, organizations] = await Promise.all([
        ghApi(["user"]),
        ghApi(["-X", "GET", "user/orgs", "-f", "per_page=100"]),
    ]);
    return {
        viewer: { login: viewer.login, avatarUrl: viewer.avatar_url },
        selectedOwner: preferences.selectedOwner,
        personalRepos: preferences.myRepos,
        organizations: [
            {
                login: viewer.login,
                name: viewer.name ?? viewer.login,
                avatarUrl: viewer.avatar_url,
                description: viewer.bio ?? "",
                kind: "user",
            },
            ...organizations.map((org) => ({
                login: org.login,
                name: org.login,
                avatarUrl: org.avatar_url,
                description: org.description ?? "",
                kind: "organization",
            })),
        ],
    };
}

async function resolveAssessmentRepository(owner, name) {
    const query = `query($owner:String!, $name:String!) {
      repository(owner:$owner, name:$name) {
        name url viewerPermission
        owner { login }
        defaultBranchRef { name target { oid } }
      }
    }`;
    const result = await ghApi([
        "graphql",
        "-f", `query=${query}`,
        "-F", `owner=${owner}`,
        "-F", `name=${name}`,
    ]);
    const repository = result.data?.repository;
    if (!repository) throw new Error(`Repository "${owner}/${name}" is not accessible.`);
    return {
        owner: repository.owner.login,
        name: repository.name,
        url: repository.url,
        viewerPermission: repository.viewerPermission,
        defaultBranch: repository.defaultBranchRef?.name,
        targetSha: repository.defaultBranchRef?.target?.oid,
    };
}

async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
}

async function loadOwnerCatalog(login) {
    const cached = catalogCache.get(login.toLowerCase());
    if (cached && Date.now() - cached.loadedAt < catalogCacheTtlMs) {
        return cached.value;
    }
    const query = `query($login:String!) {
      repositoryOwner(login:$login) {
        __typename
        login avatarUrl
        ... on User {
          name
          repositories(first:100, affiliations:[OWNER], orderBy:{field:PUSHED_AT,direction:DESC}) {
            totalCount
            nodes {
              name url description pushedAt
              pullRequests(states:OPEN) { totalCount }
            }
          }
        }
        ... on Organization {
          name
          repositories(first:100, orderBy:{field:PUSHED_AT,direction:DESC}) {
            totalCount
            nodes {
              name url description pushedAt
              pullRequests(states:OPEN) { totalCount }
            }
          }
        }
      }
    }`;
    const result = await ghApi(["graphql", "-f", `query=${query}`, "-F", `login=${login}`]);
    const account = result.data?.repositoryOwner;
    if (!account) throw new Error(`GitHub owner "${login}" is not accessible.`);
    const kind = account.__typename === "User" ? "user" : "organization";
    const repos = account.repositories.nodes
        .map((repo) => toRepoSummary(repo, account.login))
        .sort((a, b) => b.prs - a.prs || a.name.localeCompare(b.name));
    const value = {
        owner: {
            login: account.login,
            name: account.name ?? account.login,
            avatarUrl: account.avatarUrl,
            kind,
        },
        repos,
        organizationRepositoryCount: account.repositories.totalCount,
    };
    catalogCache.set(login.toLowerCase(), { loadedAt: Date.now(), value });
    return value;
}

async function searchOwnerRepositories(owner, searchText, { offset = 0, limit = 5 } = {}) {
    const targetCount = Math.min(1000, offset + limit);
    const repositories = [];
    let repositoryCount = 0;
    let cursor;
    let hasNextPage = true;
    const ownerQualifier = ownerSearchQualifier(owner.kind);
    const searchQuery = `${ownerQualifier}:${owner.login} ${searchText.trim()} in:name,description`;
    const query = `query($q:String!, $first:Int!, $after:String) {
      search(query:$q, type:REPOSITORY, first:$first, after:$after) {
        repositoryCount
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on Repository {
            name url description pushedAt
            owner { login }
            pullRequests(states:OPEN) { totalCount }
          }
        }
      }
    }`;

    while (repositories.length < targetCount && hasNextPage) {
        const first = Math.min(100, targetCount - repositories.length);
        const args = ["graphql", "-f", `query=${query}`, "-F", `q=${searchQuery}`, "-F", `first=${first}`];
        if (cursor) args.push("-F", `after=${cursor}`);
        const result = await ghApi(args);
        const search = result.data?.search;
        if (!search) throw new Error(`Repositories owned by "${owner.login}" could not be searched.`);
        repositoryCount = Math.min(search.repositoryCount, 1000);
        repositories.push(...search.nodes
            .filter((repo) => repo?.owner?.login?.toLowerCase() === owner.login.toLowerCase())
            .map((repo) => toRepoSummary(repo)));
        hasNextPage = search.pageInfo.hasNextPage && repositories.length < repositoryCount;
        cursor = search.pageInfo.endCursor;
    }

    return {
        repos: repositories.slice(offset, offset + limit),
        total: repositoryCount,
    };
}

const detailQuery = `query($owner:String!, $name:String!) {
  repository(owner:$owner, name:$name) {
    pullRequests(first:10, states:OPEN, orderBy:{field:UPDATED_AT,direction:DESC}) {
      nodes {
        number title url isDraft createdAt updatedAt
        mergeable mergeStateStatus reviewDecision
        statusCheckRollup { state }
        reviewRequests(first:1) { totalCount }
      }
    }
  }
}`;

async function loadQueueMetrics(owner, chunk) {
    const fields = chunk.map((repo, index) => {
        const base = `repo:${owner}/${repo.name} is:pr is:open`;
        return Object.entries(queueSearches)
            .map(([key, qualifier]) => `r${index}_${key}: search(query:${JSON.stringify(`${base} ${qualifier}`)}, type:ISSUE, first:1) { issueCount }`)
            .join("\n");
    }).join("\n");
    try {
        const result = await ghApi(["graphql", "-f", `query=query { ${fields} }`]);
        const data = result.data ?? {};
        return chunk.map((repo, index) => {
            const counts = Object.fromEntries(Object.keys(queueSearches)
                .map((key) => [key, data[`r${index}_${key}`]?.issueCount ?? 0]));
            return [repo.name, queueMetrics(counts, repo.prs)];
        });
    } catch {
        // One failed batch leaves only these repositories without telemetry.
        return chunk.map((repo) => [repo.name, undefined]);
    }
}

async function enrichRepositoriesFresh(owner, repos) {
    if (!repos.length) return [];
    const chunks = [];
    for (let index = 0; index < repos.length; index += 5) {
        chunks.push(repos.slice(index, index + 5));
    }
    const metricsByRepo = new Map((await Promise.all(chunks.map((chunk) => loadQueueMetrics(owner, chunk)))).flat());
    return mapLimit(repos, 4, async (repo) => {
        const metrics = metricsByRepo.get(repo.name);
        try {
            const detailResult = await ghApi([
                "graphql",
                "-f", `query=${detailQuery}`,
                "-F", `owner=${owner}`,
                "-F", `name=${repo.name}`,
            ]);
            const signal = pickAttentionSignal(detailResult.data?.repository?.pullRequests?.nodes ?? []);
            return { ...repo, metrics, signal };
        } catch {
            return { ...repo, metrics };
        }
    });
}

async function enrichRepositories(owner, repos) {
    if (!repos.length) return [];
    const now = Date.now();
    const enrichedByName = new Map();
    const uncachedRepos = [];

    for (const repo of repos) {
        const key = repoKey(owner, repo.name);
        const cached = repositoryTelemetryCache.get(key);
        if (cached && now - cached.loadedAt < repositoryTelemetryCacheTtlMs) {
            enrichedByName.set(repo.name, { ...repo, ...cached.telemetry });
        } else {
            uncachedRepos.push(repo);
        }
    }

    const newlyEnriched = await enrichRepositoriesFresh(owner, uncachedRepos);
    for (const repo of newlyEnriched) {
        if (repo.metrics) {
            // Failed lookups are not cached so the next refresh retries them.
            repositoryTelemetryCache.set(repoKey(owner, repo.name), {
                loadedAt: Date.now(),
                telemetry: { metrics: repo.metrics, signal: repo.signal },
            });
        }
        enrichedByName.set(repo.name, repo);
    }

    return repos.map((repo) => enrichedByName.get(repo.name));
}

async function loadOrganization(login, { offset = 0, limit = 20, query = "" } = {}) {
    const catalog = await loadOwnerCatalog(login);
    const normalizedQuery = query.trim().toLowerCase();
    const searchPage = normalizedQuery
        ? await searchOwnerRepositories(catalog.owner, normalizedQuery, {
            offset,
            limit: Math.min(limit, 5),
        })
        : undefined;
    const repos = searchPage
        ? searchPage.repos
        : catalog.repos.slice(offset, offset + limit);
    const enrichedRepos = await enrichRepositories(catalog.owner.login, repos);
    const matchingTotal = searchPage?.total ?? catalog.repos.length;
    return {
        owner: catalog.owner,
        repos: enrichedRepos,
        openPullRequests: enrichedRepos.reduce((sum, repo) => sum + repo.prs, 0),
        offset,
        limit,
        catalogTotal: matchingTotal,
        organizationRepositoryCount: catalog.organizationRepositoryCount,
        hasMore: offset + enrichedRepos.length < matchingTotal,
        query,
        refreshedAt: new Date().toISOString(),
    };
}

async function loadRepositoriesByName(owner, names) {
    const repositories = [];
    for (let offset = 0; offset < names.length; offset += 20) {
        const chunk = names.slice(offset, offset + 20);
        const fields = chunk.map((name, index) => `
          r${index}: repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) {
            name url description pushedAt
            owner { login }
            pullRequests(states:OPEN) { totalCount }
          }`).join("\n");
        const result = await ghApi(["graphql", "-f", `query=query { ${fields} }`]);
        const data = result.data ?? {};
        repositories.push(...chunk.flatMap((_, index) => {
            const repo = data[`r${index}`];
            if (!repo) return [];
            return [toRepoSummary(repo)];
        }));
    }
    return repositories;
}

async function loadPersonalRepositories(references) {
    if (!references.length) {
        return {
            repos: [],
            openPullRequests: 0,
            refreshedAt: new Date().toISOString(),
        };
    }
    const grouped = new Map();
    for (const reference of references) {
        const owner = reference.owner.toLowerCase();
        if (!grouped.has(owner)) grouped.set(owner, []);
        grouped.get(owner).push(reference.name.toLowerCase());
    }
    const enrichedGroups = await mapLimit([...grouped.entries()], 2, async ([owner, names]) => {
        const repos = await loadRepositoriesByName(owner, names);
        return enrichRepositories(owner, repos);
    });
    const byKey = new Map(enrichedGroups.flat().map((repo) => [
        repoKey(repo.owner, repo.name),
        repo,
    ]));
    const repos = references
        .map((reference) => byKey.get(repoKey(reference.owner, reference.name)))
        .filter(Boolean);
    return {
        repos,
        openPullRequests: repos.reduce((sum, repo) => sum + repo.prs, 0),
        refreshedAt: new Date().toISOString(),
    };
}

async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) throw new Error("Request body is too large.");
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(res, status, value) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
}

function renderHtml(defaultView) {
    const bridge = `
<script>
  (() => {
    const activate = (view) => {
      const button = document.querySelector('[data-view="' + view + '"]');
      if (button) button.click();
    };
    activate(${JSON.stringify(defaultView)});
    const events = new EventSource("/events");
    events.addEventListener("view", (event) => activate(JSON.parse(event.data).view));
    events.addEventListener("missions", (event) => window.dispatchEvent(new CustomEvent("merge-harbor:missions", { detail: JSON.parse(event.data) })));
    events.addEventListener("mission", (event) => window.dispatchEvent(new CustomEvent("merge-harbor:mission", { detail: JSON.parse(event.data) })));
    events.addEventListener("board", (event) => window.dispatchEvent(new CustomEvent("merge-harbor:board", { detail: JSON.parse(event.data) })));
  })();
</script>`;
    // Queue definitions live in queue-telemetry.mjs; hand them to the page before its script runs.
    const queueDefinitions = `<script>window.mergeHarborQueueQualifiers = ${JSON.stringify(queueQualifiers)};</script>`;
    return pageHtml
        .replace("</head>", `${queueDefinitions}</head>`)
        .replace("</body>", `${bridge}</body>`);
}

function broadcast(entry, event, payload) {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of entry.clients) {
        response.write(message);
    }
}

function broadcastAll(event, payload) {
    for (const entry of servers.values()) {
        broadcast(entry, event, payload);
    }
}

function publicMission(mission) {
    if (!mission) return undefined;
    return {
        id: mission.id,
        status: mission.status,
        phase: mission.phase,
        message: mission.message,
        repository: mission.repository,
        findings: (mission.findings ?? []).map((finding, findingIndex) => ({
            ...finding,
            identity: assessmentFindingIdentity(mission, findingIndex),
        })),
        createdAt: mission.createdAt,
        updatedAt: mission.updatedAt,
    };
}

function clearMissionTimeout(missionId) {
    const timer = missionTimeouts.get(missionId);
    if (timer) clearTimeout(timer);
    missionTimeouts.delete(missionId);
}

function scheduleMissionTimeout(mission) {
    clearMissionTimeout(mission.id);
    if (mission.status !== "in_progress") return;
    const updatedAtMs = Date.parse(mission.updatedAt);
    const remaining = Number.isFinite(updatedAtMs)
        ? Math.max(0, assessmentInterruptionTimeoutMs - (Date.now() - updatedAtMs))
        : 0;
    const timer = setTimeout(() => {
        missionTimeouts.delete(mission.id);
        const recovered = recoverInterruptedMissions(missionStore);
        for (const interrupted of recovered) {
            broadcastAll("mission", publicMission(interrupted));
        }
    }, remaining);
    timer.unref?.();
    missionTimeouts.set(mission.id, timer);
}

async function dispatchAssessment(mission) {
    try {
        const inProgress = missionStore.update(mission.id, {
            status: "in_progress",
            phase: "Coordinating specialists",
            message: "Repository assessment in progress",
        });
        scheduleMissionTimeout(inProgress);
        broadcastAll("mission", publicMission(inProgress));
        await session.send({ prompt: buildAssessmentPrompt(inProgress) });
    } catch (error) {
        const failed = missionStore.update(mission.id, {
            status: "failed",
            phase: "Assessment could not start",
            message: `Copilot could not start the assessment: ${error.message}`,
        });
        clearMissionTimeout(failed.id);
        broadcastAll("mission", publicMission(failed));
    }
}

async function startServer(instanceId, defaultView) {
    const entry = {
        server: undefined,
        url: "",
        clients: new Set(),
        currentView: defaultView,
        currentOwner: undefined,
        lastSummary: undefined,
    };
    const server = createServer((req, res) => {
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        if (requestUrl.pathname === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            res.write(`event: view\ndata: ${JSON.stringify({ view: entry.currentView })}\n\n`);
            res.write(`event: missions\ndata: ${JSON.stringify({ missions: missionStore.list().map(publicMission) })}\n\n`);
            entry.clients.add(res);
            req.on("close", () => entry.clients.delete(res));
            return;
        }

        if (requestUrl.pathname === "/api/orgs") {
            listOrganizations()
                .then((result) => {
                    writeJson(res, 200, result);
                })
                .catch((error) => {
                    writeJson(res, 500, { error: error.message });
                });
            return;
        }

        if (requestUrl.pathname === "/api/repos") {
            const owner = requestUrl.searchParams.get("owner");
            if (!owner) {
                writeJson(res, 400, { error: "The owner query parameter is required." });
                return;
            }
            const offset = Math.max(0, Number.parseInt(requestUrl.searchParams.get("offset") ?? "0", 10) || 0);
            const limit = Math.min(100, Math.max(1, Number.parseInt(requestUrl.searchParams.get("limit") ?? "20", 10) || 20));
            const query = requestUrl.searchParams.get("query") ?? "";
            loadOrganization(owner, { offset, limit, query })
                .then((result) => {
                    rememberSelectedOwner(result.owner.login);
                    entry.currentOwner = result.owner.login;
                    entry.lastSummary = {
                        scope: "organization",
                        repositories: result.repos.length,
                        openPullRequests: result.openPullRequests,
                        refreshedAt: result.refreshedAt,
                    };
                    writeJson(res, 200, result);
                })
                .catch((error) => {
                    writeJson(res, 500, { error: error.message });
                });
            return;
        }

        if (requestUrl.pathname === "/api/my-repos" && req.method === "GET") {
            const preferences = readPreferences();
            loadPersonalRepositories(preferences.myRepos)
                .then((result) => {
                    entry.lastSummary = {
                        scope: "personal",
                        repositories: result.repos.length,
                        openPullRequests: result.openPullRequests,
                        refreshedAt: result.refreshedAt,
                    };
                    writeJson(res, 200, {
                        ...result,
                        references: preferences.myRepos,
                    });
                })
                .catch((error) => writeJson(res, 500, { error: error.message }));
            return;
        }

        if (requestUrl.pathname === "/api/my-repos" && req.method === "POST") {
            readJsonBody(req)
                .then((body) => {
                    const owner = typeof body.owner === "string" ? body.owner.trim() : "";
                    const name = typeof body.name === "string" ? body.name.trim() : "";
                    const action = body.action === "remove" ? "remove" : "add";
                    if (!owner || !name) {
                        writeJson(res, 400, { error: "Repository owner and name are required." });
                        return;
                    }

                    const preferences = readPreferences();
                    const key = repoKey(owner, name);
                    const existing = preferences.myRepos.filter((repo) => repoKey(repo.owner, repo.name) !== key);
                    const myRepos = action === "add" ? [...existing, { owner, name }] : existing;
                    writePreferences({ ...preferences, myRepos });
                    writeJson(res, 200, { myRepos });
                })
                .catch((error) => writeJson(res, 400, { error: error.message }));
            return;
        }

        if (requestUrl.pathname === "/api/assessments" && req.method === "GET") {
            const owner = requestUrl.searchParams.get("owner");
            const name = requestUrl.searchParams.get("name");
            let missions = missionStore.list();
            if (owner && name) {
                const identity = repoKey(owner, name);
                missions = missions.filter((mission) => mission.repository?.key === identity);
            }
            writeJson(res, 200, { missions: missions.map(publicMission) });
            return;
        }

        if (requestUrl.pathname === "/api/assessments" && req.method === "POST") {
            readJsonBody(req)
                .then((body) => beginAssessment({
                    body,
                    store: missionStore,
                    resolveRepository: resolveAssessmentRepository,
                }))
                .then((result) => {
                    writeJson(res, result.statusCode, result.body);
                    if (result.body.mission) {
                        broadcastAll("mission", publicMission(result.body.mission));
                        if (!result.body.duplicate) {
                            setTimeout(() => dispatchAssessment(result.body.mission), 0);
                        }
                    }
                })
                .catch((error) => writeJson(res, 400, { error: error.message }));
            return;
        }

        if (requestUrl.pathname === "/api/assessment-issues" && req.method === "POST") {
            readJsonBody(req)
                .then((body) => createAssessmentIssueOnce(body))
                .then((result) => {
                    const mission = result.body.mission;
                    writeJson(res, result.statusCode, {
                        ...result.body,
                        mission: publicMission(mission),
                    });
                    if (mission && result.statusCode < 300) {
                        broadcastAll("mission", publicMission(mission));
                    }
                })
                .catch((error) => writeJson(res, 400, { error: error.message }));
            return;
        }

        if (requestUrl.pathname.startsWith("/api/decision")) {
            const body = req.method === "POST" ? readJsonBody(req) : Promise.resolve(undefined);
            body
                .then((value) => decisionService.handle(req.method, requestUrl.pathname, value, requestUrl.searchParams))
                .then((result) => {
                    if (result) writeJson(res, result.statusCode, result.body);
                    else writeJson(res, 404, { error: "Not found" });
                })
                .catch((error) => writeJson(res, 400, { error: error.message }));
            return;
        }

        if (requestUrl.pathname === "/favicon.ico") {
            res.writeHead(204);
            res.end();
            return;
        }

        if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/index.html") {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
        }

        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
        });
        res.end(renderHtml(entry.currentView));
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    entry.server = server;
    entry.url = `http://127.0.0.1:${port}/`;
    servers.set(instanceId, entry);
    return entry;
}

const session = await joinSession({
    tools: [
        ...decisionService.tools.map((tool) => ({
            ...tool,
            handler: async (args) => {
                try {
                    return await tool.handler(args);
                } catch (error) {
                    return {
                        resultType: "failure",
                        textResultForLlm: `Merge Harbor rejected the request: ${ghFailureMessage(error) === "The authenticated GitHub CLI request failed." ? error.message : ghFailureMessage(error)}`,
                    };
                }
            },
        })),
        {
            name: "merge_harbor_report_repository_assessment",
            description: "Report progress, failure, or final structured findings for a Merge Harbor repository assessment mission.",
            parameters: {
                type: "object",
                properties: {
                    missionId: { type: "string" },
                    status: { type: "string", enum: ["in_progress", "completed", "failed"] },
                    phase: { type: "string" },
                    message: { type: "string" },
                    findings: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                rootCause: { type: "string" },
                                severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
                                confidence: { type: "string", enum: ["high", "medium", "low"] },
                                evidence: { type: "array", items: { type: "string" } },
                                dependencies: { type: "array", items: { type: "string" } },
                                draftIssue: {
                                    type: "object",
                                    properties: {
                                        title: { type: "string" },
                                        body: { type: "string" },
                                    },
                                    required: ["title", "body"],
                                    additionalProperties: false,
                                },
                            },
                            required: ["rootCause", "severity", "confidence", "evidence", "draftIssue"],
                            additionalProperties: false,
                        },
                    },
                },
                required: ["missionId", "status", "message"],
                additionalProperties: false,
            },
            handler: async (args) => {
                let update;
                try {
                    update = validateMissionUpdate(args);
                    const current = missionStore.read(update.missionId);
                    if (!current) throw new Error(`Mission ${update.missionId} was not found.`);
                    if (current.status === "completed" || current.status === "failed") {
                        if (current.status === update.status) {
                            return `Mission ${current.id} is already ${current.status}.`;
                        }
                        throw new Error(`Mission ${current.id} is already ${current.status} and cannot be changed.`);
                    }
                    const mission = missionStore.update(update.missionId, {
                        status: update.status,
                        phase: update.phase || current.phase,
                        message: update.message,
                        findings: update.findings,
                    });
                    scheduleMissionTimeout(mission);
                    broadcastAll("mission", publicMission(mission));
                    return `Merge Harbor mission ${mission.id} updated to ${mission.status}.`;
                } catch (error) {
                    return {
                        resultType: "failure",
                        textResultForLlm: `Merge Harbor rejected the mission update: ${error.message}`,
                    };
                }
            },
        },
    ],
    canvases: [
        createCanvas({
            id: "merge-harbor",
            displayName: "Merge Harbor",
            description: "Ambient merge operations with personal and organization views plus safe repository assessments.",
            inputSchema: {
                type: "object",
                properties: {
                    defaultView: {
                        type: "string",
                        enum: ["overview", "convoy", "watchtower", "decisions"],
                    },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "show_view",
                    description: "Switch the open canvas to the Overview (overview), PR flow (convoy), Needs attention (watchtower), or Decisions (decisions) view.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            view: {
                                type: "string",
                                enum: ["overview", "convoy", "watchtower", "decisions"],
                            },
                        },
                        required: ["view"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) {
                            return { changed: false, reason: "Canvas instance is not open." };
                        }
                        entry.currentView = ctx.input.view;
                        broadcast(entry, "view", { view: entry.currentView });
                        return { changed: true, view: entry.currentView };
                    },
                },
                {
                    name: "get_demo_summary",
                    description: "Return the active repository scope, its open pull request totals, and the canvas's current view.",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        return {
                            organization: entry?.currentOwner ?? "not selected",
                            repositories: entry?.lastSummary?.repositories ?? 0,
                            openPullRequests: entry?.lastSummary?.openPullRequests ?? 0,
                            refreshedAt: entry?.lastSummary?.refreshedAt,
                            currentView: entry?.currentView ?? "overview",
                            note: "The active personal or organization repository set drives full-queue telemetry; actionable watch items inspect up to 10 recent open pull requests per repository.",
                        };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, ctx.input?.defaultView ?? "overview");
                }
                return {
                    title: "Merge Harbor",
                    status: "Merge operations and safe repository assessments",
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (!entry) return;
                servers.delete(ctx.instanceId);
                for (const response of entry.clients) response.end();
                await new Promise((resolve) => entry.server.close(() => resolve()));
            },
        }),
    ],
});

recoverInterruptedMissions(missionStore);
for (const mission of missionStore.list()) {
    if (mission.status === "queued") {
        setTimeout(() => dispatchAssessment(mission), 0);
    } else {
        scheduleMissionTimeout(mission);
    }
}
