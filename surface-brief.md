# Merge Harbor wall display

- **Scope:** `extension/merge-harbor.html`, the single-file canvas page served by the local extension server.
- **Mode:** Operate.
- **Audience and job:** Enterprise engineering teams using coding agents; understand merge health at a glance, find the next human intervention, and safely request a review-only assessment of one repository.
- **Content:** Live GitHub data for the signed-in account, a selected organization, or a personal cross-owner My repos list. Each repository shows full-queue lifecycle counts, and the most actionable recent pull request is surfaced for intervention. No demo or illustrative data is shown.
- **Constraints:** Wall-distance legibility, no color-only state, reduced-motion support, calm urgency, no fabricated benchmarks, and no remote writes from repository assessments.
- **Direction:** Ambient operations overview. One dominant blocked-PR number, an exclusive lifecycle distribution, and a short ranked "Act now" list read from a distance; repository rows and cards reward a closer look.
- **History:** The first concept, Harbor Panorama (repository berths converging on a central merge lock), was replaced by the operational views below. Its markup, styles, and illustrative states have been removed.

## Implementation inventory

| Ingredient | Medium | Commitment |
|---|---|---|
| Overview | Semantic HTML/CSS | Blocked-PR headline, exclusive lifecycle donut with linked counts, top three "Act now" pull requests, then repository list or cards |
| PR flow view (`convoy`) | Semantic HTML/CSS | Six lifecycle stages, each with its total, top five repositories, and a link to the full GitHub queue |
| Needs attention view (`watchtower`) | Semantic HTML | Up to eight ranked interventions with reason, age, Open PR, and Assess repository |
| Lifecycle queues | `extension/queue-telemetry.mjs` | One definition of the six mutually exclusive GitHub search filters, used for counts on the server and for queue links in the page |
| Attention signal | `extension/queue-telemetry.mjs` | Per repository, the most actionable of the 10 most recently updated open pull requests |
| Source data | Loopback HTTP + `gh api` | Browsing covers an owner's 100 most recently pushed repositories, 20 at a time; search reaches the rest. Refresh keeps every loaded page |
| Motion | CSS | Loading spinners and assessment panel expansion only; all motion respects reduced-motion |
| Repository assessments | Loopback HTTP + SDK session bridge | One click creates a durable mission and delegates bounded static, read-only inspection in an isolated local clone |
| Assessment review | Semantic HTML/CSS | Completed findings attach to their repository row or card; one repository panel opens per collection, with nested finding details and executive summaries |
| Assessment disclosure | Button-controlled region + native details | Repository triggers expose count and expanded state; findings summarize the proposed issue, root cause, severity, confidence, evidence, and dependencies before expansion |
| Assessment status | Repository row status note | Starting, running, and failed assessments show their phase or failure reason under the row's assessment button; there is no page-level assessments panel |
| Issue publication | Inline two-step finding action | A stored draft can become one plain GitHub issue only after repository/title confirmation; loading, retryable error, and durable success stay attached to the finding |
| Execution boundary | Prompt contract + mission state | Repository code never runs without separate approval and a secrets-free, network-restricted sandbox |
| Interruption recovery | Durable timestamps + bounded timer | Stale in-progress missions fail with a clear retry action instead of blocking future assessments |

## Design notes

Repository assessment refinement preserves the ambient hierarchy: assessment status and completed evidence appear only beside the repository that produced them. List disclosures span the row; expanded cards span the collection width; narrow layouts stack summary copy before metadata without changing DOM or focus order.

Ordinary dashboard refreshes preserve meaningful focus inside an open assessment. A repository outside the current owner, scope, or search keeps its results; they reappear when the repository is shown again.

Assessment remains read-only. Issue publication is a separate, explicit post-assessment remote write: the client submits only the durable mission/finding reference, the server derives repository and draft content from validated storage, and no labels, assignees, projects, comments, or automatic publication are permitted.
