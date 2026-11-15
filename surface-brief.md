# Merge Harbor wall display

- **Scope:** `merge-harbor.html`, a self-contained concept artifact for a large shared engineering display.
- **Mode:** Operate.
- **Audience and job:** Enterprise engineering teams using coding agents; understand merge health at a glance, find the next human intervention, and safely request a review-only assessment of one repository.
- **Content:** Twenty public repositories from the `github` organization, current open pull-request totals, and clearly labeled illustrative operational states.
- **Constraints:** Wall-distance legibility, no color-only state, reduced-motion support, calm urgency, no fabricated benchmarks, and no remote writes from repository assessments.
- **Direction:** Harbor Signal Room. Repositories are berths, pull requests are vessels, and one central merge lock makes system flow visible.
- **Approved composition:** Harbor Panorama, informed by the generated comp at `.impeccable/mocks/harbor-panorama.png`.
- **Memorable moment:** Twenty repository lanes visibly converge on one shared merge lock.

## Implementation inventory

| Ingredient | Medium | Commitment |
|---|---|---|
| Twenty repository berths | Semantic HTML/CSS | Ten lanes flank each side of the lock |
| Central merge lock | HTML/CSS | Monumental vertical channel, visually dominant |
| PR vessels and signal states | CSS geometry + text | Shape, border, and labels supplement color |
| Human attention watch | Semantic HTML | Four persistent intervention cells |
| Convoy flow screen | Semantic HTML/CSS | Four checkpoints from agent work to merge |
| Watchtower screen | Semantic HTML/CSS | Semaphore stack plus ranked action queue |
| Motion | CSS | One slow tide/current movement only |
| Source data | Inline JavaScript | Current public open-PR totals; illustrative states labeled |
| Repository assessments | Loopback HTTP + SDK session bridge | One click creates a durable mission and delegates bounded static, read-only inspection in an isolated local clone |
| Assessment review | Semantic HTML/CSS | Completed findings attach to their repository row or card; one repository panel opens per collection, with nested finding details and executive summaries |
| Assessment disclosure | Button-controlled region + native details | Repository triggers expose count and expanded state; findings summarize the proposed issue, root cause, severity, confidence, evidence, and dependencies before expansion |
| Assessment recovery | Compact mission index + temporary repository entry | Completed results outside the current owner, scope, or search remain reachable without moving finding content back into the global mission area |
| Issue publication | Inline two-step finding action | A stored draft can become one plain GitHub issue only after repository/title confirmation; loading, retryable error, and durable success stay attached to the finding |
| Execution boundary | Prompt contract + mission state | Repository code never runs without separate approval and a secrets-free, network-restricted sandbox |
| Interruption recovery | Durable timestamps + bounded timer | Stale in-progress missions fail with a clear retry action instead of blocking future assessments |

## Deliberate translation from comp

The generated control-room architecture and photorealistic room are not literal product assets. The build preserves the panorama topology, berth density, central lock, signal grammar, and watch strip as semantic UI.

Repository assessment refinement preserves that ambient hierarchy: active mission status remains compact, while completed evidence appears only beside the repository that produced it. List disclosures span the row; expanded cards span the collection width; narrow layouts stack summary copy before metadata without changing DOM or focus order.

Ordinary dashboard refreshes preserve meaningful focus inside an open assessment. If filtering removes the repository, the compact mission index offers a temporary repository-attached shortcut rather than duplicating findings globally.

Assessment remains read-only. Issue publication is a separate, explicit post-assessment remote write: the client submits only the durable mission/finding reference, the server derives repository and draft content from validated storage, and no labels, assignees, projects, comments, or automatic publication are permitted.
