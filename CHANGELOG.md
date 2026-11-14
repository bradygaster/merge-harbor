# Changelog

## 0.3.0 - 2026-11-13

- Added one-click, read-only repository assessments from repository and attention views
- Added durable mission state, live SSE progress, and structured reviewable findings
- Added a globally unique callback tool for Copilot-coordinated specialist assessments
- Added dependency-free tests for mission persistence, idempotency, safety prompts, callback updates, and malformed results
- Kept issue publication, pull requests, pushes, and all other remote writes outside the assessment workflow
- Defaulted assessments to static read-only inspection; repository code execution now requires separate approval and a secrets-free, network-restricted sandbox
- Added bounded recovery for interrupted in-progress missions so stale work cannot block retries
- Restored the signed-in personal account in the repository-owner selector with user-specific search, queue, and source links
- Removed the redundant repository status badge column while retaining full lifecycle telemetry
- Attached completed assessment findings directly to repository rows and cards with one-at-a-time progressive disclosure
- Added severity-grouped finding summaries with proposed issue titles, root causes, confidence, and evidence/dependency counts
- Routed Needs attention review actions back to the matching Overview repository and removed the disabled future issue-publication control

## 0.2.0 - 2026-11-13

- Added an Agent Plugins 1.0 manifest and GitHub-hosted marketplace catalog
- Added a canonical Copilot app extension entrypoint that forwards to the existing canvas runtime
- Added dependency-free validation for catalog identity, plugin metadata, and contribution paths
- Documented plugin installation, marketplace visibility limits, lifecycle expectations, and compatibility

## 0.1.0 - 2026-11-13

- Initial user-level Merge Harbor canvas release
- Live organization and pull request telemetry
- Organization-wide repository search
- Persistent cross-organization My repos list
- List and card layouts with actionable lifecycle queues
- Automatic refresh and GitHub-native visual styling
