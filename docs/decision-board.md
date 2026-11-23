# Decision board: the decision ledger

Merge Harbor's ambient view tells a team *where* attention is needed. The decision board (#5) is what happens next: a repository-specific Squad reads the whole backlog and proposes concrete actions, a human decides on each one, and only approved actions reach GitHub.

The canvas is the window onto this. The underlying idea is a **ledger between agents and the world**: agents may propose anything, but only a human-approved, exact, still-current action can be executed, and every execution can be audited and reconciled.

`extension/decision-core.mjs` implements that ledger with no dependencies on the host, the network, or Squad. `scripts/decision.test.mjs` exercises it end to end against an in-memory GitHub with a 163-issue fixture.

## The flow

```
  Squad (coordinator + bounded delegates)          Human (canvas)                 Execution boundary
  ─────────────────────────────────────          ──────────────                 ──────────────────
  recordInventory ── every page, PRs out,
                     overlap deduped, totals
                     checked → gaps
  ingestTriage ───── proposals / no-action /
                     blocked per issue           coverage() → nothing silent
                                                 decide(rev, digest)
                                                 reviseProposal → new rev,
                                                   old approval superseded
                                                 prepareBatch → frozen manifest
                                                 confirmBatch(token)
                                                                                authorize() at dispatch
                                                                                intent persisted
                                                                                apply → observe → verify
                                                                                unknown → reconcile, not retry
```

## Invariants and where they live

| Invariant | Mechanism | Issue |
|---|---|---|
| Every enumerated issue has an outcome or an explicit gap | `recordInventory` dedupes across pages, excludes PRs, compares to the reported total; `coverage()` lists uncovered issues | #7 |
| Issue text is evidence, never permission | `ingestTriage` can only create proposals; unknown issues and unsupported action types are rejected visibly in `rejectedReports` | #7 |
| Re-running triage is idempotent | Proposal id = repo + agent-stable key; identical content produces no new revision | #7 |
| Approval binds to an exact revision | Each revision has a content digest; `decide` requires the current revision and digest | #8 |
| Revision invalidates approval | Any new revision makes the latest decision `superseded` | #8 |
| Agents cannot approve | `decide` rejects reviewers named `squad*` and requires a reviewer; triage has no path to decisions | #8 |
| Batches cannot grow | `prepareBatch` freezes an enumerated manifest; `confirmBatch` refuses if any member changed and never includes later arrivals | #8 |
| Approval is enforced at the boundary | `authorize` rechecks decision, revision, repository, account, dependencies, issue freshness, cancellation | #9 |
| Only a fixed vocabulary executes | `add_labels`, `remove_labels`, `assign`, `comment`, `close`; `implement`, `investigate`, `no_change` are recommendations only | #9 |
| No duplicate writes after interruption | Intent persisted before the write; a lost response records `unknown`; resume observes GitHub and reconciles; comments carry a hidden marker | #9 |
| Org view does not merge authority | `aggregate` groups repo-scoped proposals into shared blockers without carrying approval; inaccessible or stale repos are gaps, never zero | #10 |

### Freshness policy

An issue is fresh if its `updatedAt` equals the value captured at triage, or equals a value observed immediately after one of the board's own verified writes. That lets a dependent action (label after comment) proceed on an issue the board itself just touched, while any outside change (a new comment, an edit) forces re-triage and re-approval. A multi-issue action that partially landed will surface as stale for the remaining issues rather than silently finishing.

## Wiring

| Layer | File | Host-specific? |
|---|---|---|
| Ledger rules | `extension/decision-core.mjs` | No |
| GitHub reads and writes via `gh api` | `extension/github-adapter.mjs` | No |
| Agent tools and HTTP routes | `extension/decision-service.mjs` | No |
| Mounting into Copilot (`joinSession` tools, loopback server) | `extension/extension.mjs` | Yes |

Another host, such as an MCP server packaged as a Claude Code plugin, can mount `createDecisionService(...).tools` and `.handle` unchanged.

### Agent tools

- `merge_harbor_get_issue_inventory { owner, name, refresh? }` creates or resumes the board and returns the inventory **fetched by Merge Harbor**, plus coverage. The agent never supplies the issue list.
- `merge_harbor_report_issue_triage { owner, name, proposals, noAction, blocked }` ingests results, possibly over several calls. It returns what was recorded, what was rejected and why, and what is still uncovered.

Neither tool can approve anything or write to GitHub.

### Routes (loopback only)

| Route | Purpose |
|---|---|
| `GET /api/decision-boards[?id=]` | All boards plus the organization aggregate, or one board |
| `POST /api/decisions` | `{ boardId, proposalId, revision, digest, verdict, note? }` |
| `POST /api/decision-batches` | Prepare `{ boardId, proposalIds, verdict }` → `{ token, manifest }`; confirm `{ boardId, token }` |
| `POST /api/decision-executions` | `{ boardId, proposalIds }` → per proposal: `succeeded`, `refused`, `unknown`, or `not_dispatched` |
| `POST /api/decision-cancel` | `{ boardId }` |

Every decision is attributed to the account `gh` is signed in as; a `reviewer` field in the request body is ignored. A `DecisionError` returns 409 with a `code`. Writes to a board are serialized per board, and every change is broadcast over SSE as a `board` event.

Known limits:
- GitHub's API records `state_reason=duplicate` but does not link to the original issue, so `duplicateOf` is kept only as evidence in the ledger.
- Like the existing assessment routes, these routes rely on binding to 127.0.0.1 on a random port, not on a per-session token.

## Still to build

1. **Canvas.** A repo-level decision view that reads `/api/decision-boards`, listens for `board` events, shows `coverage()`, groups by `group`, and drives decisions and batches. Execution is a separate, explicit button for an approved set.
2. **Squad coordinator prompt.** Built like `buildAssessmentPrompt`: an isolated clone; any existing `squad init` and casting state preserved; cluster issues by root cause before delegating; report through the two tools; no remote writes. In Copilot this is dispatched with `session.send`. In a host without push, a slash command or skill starts it.

## Running the tests

```powershell
node scripts/decision.test.mjs
node scripts/decision-service.test.mjs
```

`scripts/validate.mjs` runs both, so CI covers them.
