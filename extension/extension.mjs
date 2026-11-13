import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

const servers = new Map();
const execFileAsync = promisify(execFile);
const prototypeHtml = readFileSync(new URL("./merge-harbor.html", import.meta.url), "utf8");
const legacyPreferencesUrl = new URL("./preferences.json", import.meta.url);
const copilotHome = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
const preferencesDirectory = join(copilotHome, "extensions", "merge-harbor", "artifacts");
const preferencesPath = join(preferencesDirectory, "preferences.json");
const catalogCache = new Map();
const catalogCacheTtlMs = 5 * 60 * 1000;
const repositoryTelemetryCache = new Map();
const repositoryTelemetryCacheTtlMs = 5 * 60 * 1000;

function readPreferences() {
    let preferences;
    try {
        preferences = JSON.parse(readFileSync(preferencesPath, "utf8"));
    } catch {
        try {
            preferences = JSON.parse(readFileSync(legacyPreferencesUrl, "utf8"));
        } catch {
            preferences = {};
        }
    }
    const seen = new Set();
    const myRepos = Array.isArray(preferences.myRepos)
        ? preferences.myRepos
            .filter((repo) => repo && typeof repo.owner === "string" && typeof repo.name === "string")
            .map((repo) => ({ owner: repo.owner.trim(), name: repo.name.trim() }))
            .filter((repo) => repo.owner && repo.name)
            .filter((repo) => {
                const key = `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
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

function writePreferences(preferences) {
    mkdirSync(preferencesDirectory, { recursive: true });
    const temporaryPath = `${preferencesPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, preferencesPath);
}

async function ghApi(args) {
    const { stdout } = await execFileAsync("gh", ["api", ...args], {
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
    });
    return JSON.parse(stdout);
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
        organizations: organizations.map((org) => ({
            login: org.login,
            avatarUrl: org.avatar_url,
            description: org.description ?? "",
        })),
    };
}

function classifyPullRequests(pullRequests) {
    const now = Date.now();
    const signals = pullRequests.map((pr) => {
        const checkState = pr.statusCheckRollup?.state ?? "UNKNOWN";
        const ageDays = Math.max(0, Math.floor((now - new Date(pr.updatedAt).getTime()) / 86400000));
        if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
            return { kind: "conflict", reason: "Merge conflict", action: "Resolve merge conflicts", priority: 0, ageDays, pr };
        }
        if (checkState === "FAILURE" || checkState === "ERROR") {
            return { kind: "checks-failing", reason: "Failing checks", action: "Fix failing checks", priority: 1, ageDays, pr };
        }
        if (!pr.isDraft && pr.reviewDecision === "APPROVED" && checkState === "SUCCESS" && pr.mergeable === "MERGEABLE") {
            return { kind: "ready", reason: "Approved and checks passing", action: "Merge when ready", priority: 2, ageDays, pr };
        }
        if (pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewRequests?.totalCount > 0) {
            return { kind: "review", reason: "Review required", action: "Complete requested review", priority: 3, ageDays, pr };
        }
        if (pr.isDraft) {
            return { kind: "draft", reason: "Draft pull request", action: "Mark ready when complete", priority: 4, ageDays, pr };
        }
        if (checkState === "PENDING" || checkState === "EXPECTED") {
            return { kind: "checks-running", reason: "Checks running", action: "Monitor checks", priority: 5, ageDays, pr };
        }
        if (ageDays >= 7) {
            return { kind: "stale", reason: `${ageDays} days without activity`, action: "Update or close", priority: 6, ageDays, pr };
        }
        return { kind: "active", reason: "Recently active", action: "No intervention needed", priority: 7, ageDays, pr };
    });

    const count = (kinds) => signals.filter((signal) => kinds.includes(signal.kind)).length;
    const blocked = count(["conflict", "checks-failing"]);
    const ready = count(["ready"]);
    const waiting = count(["review", "draft", "stale"]);
    const flowing = count(["checks-running", "active"]);
    const blockThreshold = pullRequests.length >= 7 ? 2 : 1;
    let state;
    let detail;
    let candidates;

    if (blocked >= blockThreshold) {
        state = "blocked";
        detail = `${blocked} sampled PR${blocked === 1 ? "" : "s"} failing checks or conflicted`;
        candidates = signals.filter((signal) => ["conflict", "checks-failing"].includes(signal.kind));
    } else if (ready > 0) {
        state = "merging";
        detail = `${ready} sampled PR${ready === 1 ? "" : "s"} approved and checks passing`;
        candidates = signals.filter((signal) => signal.kind === "ready");
    } else if (waiting >= Math.max(1, Math.ceil(pullRequests.length * 0.4))) {
        state = "waiting";
        detail = `${waiting} sampled PR${waiting === 1 ? "" : "s"} awaiting review, draft completion, or activity`;
        candidates = signals.filter((signal) => ["review", "draft", "stale"].includes(signal.kind));
    } else {
        state = "flowing";
        detail = `${flowing} sampled PR${flowing === 1 ? "" : "s"} active or running checks`;
        candidates = signals.filter((signal) => ["checks-running", "active"].includes(signal.kind));
    }

    const signal = [...candidates].sort((a, b) => a.priority - b.priority || b.ageDays - a.ageDays)[0]
        ?? [...signals].sort((a, b) => a.priority - b.priority || b.ageDays - a.ageDays)[0];

    return {
        state,
        stateDetail: detail,
        sampleSize: pullRequests.length,
        counts: { blocked, ready, waiting, flowing },
        signal: signal ? {
            kind: signal.kind,
            reason: signal.reason,
            action: signal.action,
            ageDays: signal.ageDays,
            number: signal.pr.number,
            title: signal.pr.title,
            url: signal.pr.url,
            updatedAt: signal.pr.updatedAt,
        } : undefined,
    };
}

function classifyQueueTelemetry(metrics, total, recent) {
    const ratio = (value) => value / Math.max(1, total);
    let state;
    if (metrics.blocked >= Math.max(2, Math.ceil(total * 0.08))) {
        state = "blocked";
    } else if (metrics.ready > 0) {
        state = "merging";
    } else if (ratio(metrics.review) >= 0.4 || ratio(metrics.drafts) >= 0.35) {
        state = "waiting";
    } else {
        state = "flowing";
    }
    return {
        state,
        stateDetail: [
            `${metrics.blocked.toLocaleString()} blocked`,
            `${metrics.ready.toLocaleString()} ready`,
            `${metrics.review.toLocaleString()} review`,
            `${metrics.drafts.toLocaleString()} drafts`,
            `${metrics.checks.toLocaleString()} checks running`,
            `${metrics.other.toLocaleString()} other`,
        ].join(" · "),
        metrics,
        signal: recent.signal,
        sampleSize: recent.sampleSize,
        counts: recent.counts,
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

async function loadOrganizationCatalog(login) {
    const cached = catalogCache.get(login.toLowerCase());
    if (cached && Date.now() - cached.loadedAt < catalogCacheTtlMs) {
        return cached.value;
    }
    const query = `query($login:String!) {
      organization(login:$login) {
        login name avatarUrl
        repositories(first:100, orderBy:{field:PUSHED_AT,direction:DESC}) {
          totalCount
          nodes {
            name url description pushedAt
            pullRequests(states:OPEN) { totalCount }
          }
        }
      }
    }`;
    const result = await ghApi(["graphql", "-f", `query=${query}`, "-F", `login=${login}`]);
    const organization = result.data?.organization;
    if (!organization) throw new Error(`Organization "${login}" is not accessible.`);
    const repos = organization.repositories.nodes
        .map((repo) => ({
            owner: organization.login,
            name: repo.name,
            url: repo.url,
            description: repo.description ?? "",
            pushedAt: repo.pushedAt,
            prs: repo.pullRequests.totalCount,
        }))
        .sort((a, b) => b.prs - a.prs || a.name.localeCompare(b.name));
    const value = {
        owner: {
            login: organization.login,
            name: organization.name ?? organization.login,
            avatarUrl: organization.avatarUrl,
        },
        repos,
        organizationRepositoryCount: organization.repositories.totalCount,
    };
    catalogCache.set(login.toLowerCase(), { loadedAt: Date.now(), value });
    return value;
}

async function searchOrganizationRepositories(login, searchText, { offset = 0, limit = 5 } = {}) {
    const targetCount = Math.min(1000, offset + limit);
    const repositories = [];
    let repositoryCount = 0;
    let cursor;
    let hasNextPage = true;
    const searchQuery = `org:${login} ${searchText.trim()} in:name,description`;
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
        if (!search) throw new Error(`Repositories in "${login}" could not be searched.`);
        repositoryCount = Math.min(search.repositoryCount, 1000);
        repositories.push(...search.nodes
            .filter((repo) => repo?.owner?.login?.toLowerCase() === login.toLowerCase())
            .map((repo) => ({
                owner: repo.owner.login,
                name: repo.name,
                url: repo.url,
                description: repo.description ?? "",
                pushedAt: repo.pushedAt,
                prs: repo.pullRequests.totalCount,
            })));
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

async function enrichRepositoriesFresh(owner, repos) {
    if (!repos.length) return [];
    const telemetryChunks = [];
    for (let index = 0; index < repos.length; index += 5) {
        telemetryChunks.push(repos.slice(index, index + 5));
    }
    const telemetryPairs = (await Promise.all(telemetryChunks.map(async (chunk) => {
        const fields = chunk.map((repo, index) => {
            const base = `repo:${owner}/${repo.name} is:pr is:open`;
            return `
              r${index}f: search(query:${JSON.stringify(`${base} status:failure`)}, type:ISSUE, first:1) { issueCount }
              r${index}p: search(query:${JSON.stringify(`${base} status:pending draft:false -review:required -review:changes_requested`)}, type:ISSUE, first:1) { issueCount }
              r${index}m: search(query:${JSON.stringify(`${base} review:approved status:success draft:false`)}, type:ISSUE, first:1) { issueCount }
              r${index}r: search(query:${JSON.stringify(`${base} review:required draft:false -status:failure`)}, type:ISSUE, first:1) { issueCount }
              r${index}d: search(query:${JSON.stringify(`${base} draft:true -status:failure -review:changes_requested`)}, type:ISSUE, first:1) { issueCount }
              r${index}c: search(query:${JSON.stringify(`${base} review:changes_requested -status:failure`)}, type:ISSUE, first:1) { issueCount }`;
        }).join("\n");
        const telemetryResult = await ghApi(["graphql", "-f", `query=query { ${fields} }`]);
        const data = telemetryResult.data ?? {};
        return chunk.map((repo, index) => {
            const failing = data[`r${index}f`]?.issueCount ?? 0;
            const changesRequested = data[`r${index}c`]?.issueCount ?? 0;
            const metrics = {
                blocked: failing + changesRequested,
                ready: data[`r${index}m`]?.issueCount ?? 0,
                review: data[`r${index}r`]?.issueCount ?? 0,
                drafts: data[`r${index}d`]?.issueCount ?? 0,
                checks: data[`r${index}p`]?.issueCount ?? 0,
            };
            metrics.other = Math.max(0, repo.prs - Object.values(metrics).reduce((sum, value) => sum + value, 0));
            return [repo.name, metrics];
        });
    }))).flat();
    const telemetryByRepo = new Map(telemetryPairs);
    return mapLimit(repos, 4, async (repo) => {
        try {
            const detailResult = await ghApi([
                "graphql",
                "-f", `query=${detailQuery}`,
                "-F", `owner=${owner}`,
                "-F", `name=${repo.name}`,
            ]);
            const recent = classifyPullRequests(detailResult.data?.repository?.pullRequests?.nodes ?? []);
            return {
                ...repo,
                ...classifyQueueTelemetry(telemetryByRepo.get(repo.name), repo.prs, recent),
            };
        } catch (error) {
            return {
                ...repo,
                state: "unknown",
                stateDetail: `Pull request signals unavailable: ${error.message.split("\n")[0]}`,
                sampleSize: 0,
                counts: { blocked: 0, ready: 0, waiting: 0, flowing: 0 },
            };
        }
    });
}

async function enrichRepositories(owner, repos) {
    if (!repos.length) return [];
    const now = Date.now();
    const enrichedByName = new Map();
    const uncachedRepos = [];

    for (const repo of repos) {
        const key = `${owner.toLowerCase()}/${repo.name.toLowerCase()}`;
        const cached = repositoryTelemetryCache.get(key);
        if (cached && now - cached.loadedAt < repositoryTelemetryCacheTtlMs) {
            enrichedByName.set(repo.name, { ...repo, ...cached.telemetry });
        } else {
            uncachedRepos.push(repo);
        }
    }

    const newlyEnriched = await enrichRepositoriesFresh(owner, uncachedRepos);
    for (const repo of newlyEnriched) {
        const key = `${owner.toLowerCase()}/${repo.name.toLowerCase()}`;
        const { owner: _owner, name: _name, url: _url, description: _description, pushedAt: _pushedAt, prs: _prs, ...telemetry } = repo;
        repositoryTelemetryCache.set(key, { loadedAt: Date.now(), telemetry });
        enrichedByName.set(repo.name, repo);
    }

    return repos.map((repo) => enrichedByName.get(repo.name));
}

async function loadOrganization(login, { offset = 0, limit = 20, query = "" } = {}) {
    const catalog = await loadOrganizationCatalog(login);
    const normalizedQuery = query.trim().toLowerCase();
    const searchPage = normalizedQuery
        ? await searchOrganizationRepositories(catalog.owner.login, normalizedQuery, {
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
        catalogAvailableTotal: normalizedQuery ? catalog.organizationRepositoryCount : catalog.repos.length,
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
            return [{
                owner: repo.owner.login,
                name: repo.name,
                url: repo.url,
                description: repo.description ?? "",
                pushedAt: repo.pushedAt,
                prs: repo.pullRequests.totalCount,
            }];
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
        `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`,
        repo,
    ]));
    const repos = references
        .map((reference) => byKey.get(`${reference.owner.toLowerCase()}/${reference.name.toLowerCase()}`))
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
  })();
</script>`;
    return prototypeHtml.replace("</body>", `${bridge}</body>`);
}

function broadcast(entry, event, payload) {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of entry.clients) {
        response.write(message);
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
        if (req.url === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            res.write(`event: view\ndata: ${JSON.stringify({ view: entry.currentView })}\n\n`);
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
            const limit = Math.min(20, Math.max(1, Number.parseInt(requestUrl.searchParams.get("limit") ?? "20", 10) || 20));
            const query = requestUrl.searchParams.get("query") ?? "";
            loadOrganization(owner, { offset, limit, query })
                .then((result) => {
                    writePreferences({ ...readPreferences(), selectedOwner: result.owner.login });
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
                    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
                    const existing = preferences.myRepos.filter((repo) => `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}` !== key);
                    const myRepos = action === "add" ? [...existing, { owner, name }] : existing;
                    writePreferences({ ...preferences, myRepos });
                    writeJson(res, 200, { myRepos });
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

await joinSession({
    canvases: [
        createCanvas({
            id: "merge-harbor",
            displayName: "Merge Harbor",
            description: "Interactive ambient merge-operations display with personal and organization repository views.",
            inputSchema: {
                type: "object",
                properties: {
                    defaultView: {
                        type: "string",
                        enum: ["overview", "convoy", "watchtower"],
                    },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "show_view",
                    description: "Switch the open prototype to the harbor overview, convoy flow, or watchtower screen.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            view: {
                                type: "string",
                                enum: ["overview", "convoy", "watchtower"],
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
                    description: "Return the public demo-data scope and the prototype's current screen.",
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
                    status: "Personal and organization merge operations",
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
