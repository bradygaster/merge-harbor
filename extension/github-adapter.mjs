// GitHub access for the decision ledger, through the locally authenticated `gh` CLI.
// `runGh(args)` must resolve to gh's stdout (string) and reject with gh's error on failure.
// Nothing here decides anything: the ledger authorizes, this module only reads and writes.

function parseJson(stdout) {
    const text = String(stdout ?? "").trim();
    return text ? JSON.parse(text) : undefined;
}

function repoPath(owner, name) {
    return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function isNotFound(error) {
    return /HTTP 404|Not Found/i.test(`${error?.stderr ?? ""} ${error?.message ?? ""}`);
}

const pageSize = 100;
const maximumPages = 50; // 5,000 issues; beyond that the inventory reports a gap rather than hanging.

// Authoritative inventory, fetched by the extension rather than reported by the agent.
export async function loadIssueInventory(runGh, owner, name) {
    const pages = [];
    for (let page = 1; page <= maximumPages; page += 1) {
        const items = parseJson(await runGh([
            "--method", "GET",
            `${repoPath(owner, name)}/issues`,
            "--raw-field", "state=open",
            "--raw-field", `per_page=${pageSize}`,
            "--raw-field", `page=${page}`,
        ])) ?? [];
        pages.push(items);
        if (items.length < pageSize) break;
    }
    // The issues endpoint mixes in pull requests; search reports the issue-only total to check against.
    let expectedTotal;
    try {
        const search = parseJson(await runGh([
            "--method", "GET",
            "search/issues",
            "--raw-field", `q=repo:${owner}/${name} is:issue is:open`,
            "--raw-field", "per_page=1",
        ]));
        expectedTotal = Number.isInteger(search?.total_count) ? search.total_count : undefined;
    } catch {
        expectedTotal = undefined;
    }
    return { pages, expectedTotal, snapshotAt: new Date().toISOString() };
}

export function createGhDecisionAdapter({ runGh, owner, name }) {
    const base = repoPath(owner, name);

    async function commentMarkers(number) {
        const markers = [];
        for (let page = 1; page <= maximumPages; page += 1) {
            const comments = parseJson(await runGh([
                "--method", "GET",
                `${base}/issues/${number}/comments`,
                "--raw-field", `per_page=${pageSize}`,
                "--raw-field", `page=${page}`,
            ])) ?? [];
            for (const comment of comments) {
                for (const match of String(comment.body ?? "").matchAll(/<!-- (merge-harbor-decision-[0-9a-f]+) -->/g)) {
                    markers.push(match[1]);
                }
            }
            if (comments.length < pageSize) break;
        }
        return markers;
    }

    return {
        async context() {
            const [user, repo] = await Promise.all([
                runGh(["user"]).then(parseJson),
                runGh([base]).then(parseJson),
            ]);
            // full_name catches renames and transfers: the board's identity must still match.
            return { viewer: user?.login, repositoryKey: String(repo?.full_name ?? "").toLowerCase() };
        },

        async observe(numbers, { actionType } = {}) {
            const observed = {};
            for (const number of numbers) {
                let issue;
                try {
                    issue = parseJson(await runGh([`${base}/issues/${number}`]));
                } catch (error) {
                    if (isNotFound(error)) continue;
                    throw error;
                }
                observed[number] = {
                    updatedAt: issue.updated_at,
                    state: issue.state,
                    labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)),
                    assignees: (issue.assignees ?? []).map((user) => user.login),
                    commentMarkers: actionType === "comment" ? await commentMarkers(number) : [],
                };
            }
            return observed;
        },

        async apply({ number, action, marker }) {
            const issuePath = `${base}/issues/${number}`;
            const { type, payload } = action;
            if (type === "add_labels") {
                await runGh(["--method", "POST", `${issuePath}/labels`, ...payload.labels.flatMap((label) => ["--raw-field", `labels[]=${label}`])]);
            } else if (type === "remove_labels") {
                for (const label of payload.labels) {
                    try {
                        await runGh(["--method", "DELETE", `${issuePath}/labels/${encodeURIComponent(label)}`]);
                    } catch (error) {
                        if (!isNotFound(error)) throw error; // already absent is the desired state
                    }
                }
            } else if (type === "assign") {
                await runGh(["--method", "POST", `${issuePath}/assignees`, ...payload.assignees.flatMap((login) => ["--raw-field", `assignees[]=${login}`])]);
            } else if (type === "comment") {
                const comment = parseJson(await runGh(["--method", "POST", `${issuePath}/comments`, "--raw-field", `body=${payload.body}\n\n<!-- ${marker} -->`]));
                return { url: comment?.html_url };
            } else if (type === "close") {
                // GitHub's API records the reason but does not link duplicates; duplicateOf stays in the ledger as evidence.
                await runGh(["--method", "PATCH", issuePath, "--raw-field", "state=closed", "--raw-field", `state_reason=${payload.reason}`]);
            } else {
                throw new Error(`The GitHub adapter does not support "${type}".`);
            }
            return { url: `https://github.com/${owner}/${name}/issues/${number}` };
        },
    };
}
