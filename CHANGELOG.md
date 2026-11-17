# Changelog

## Unreleased

- Fixed the canvas scrolling past its tab bar when it opens or when Copilot switches views
- Fixed auto-refresh discarding repositories loaded by scrolling; refresh now reloads every loaded page
- Fixed tooltips staying visible after a click or scroll; focus tooltips now appear for keyboard focus only
- Clarified that browsing covers an owner's 100 most recently pushed repositories and that search reaches the rest
- Kept Needs attention ages on one line and PR links in the standard link color
- Removed the built-in `github` demo data and the invented fallback interventions; empty states now explain when nothing needs attention
- Escaped GitHub URLs before placing them in links
- Moved lifecycle queue filters and attention-signal rules into `extension/queue-telemetry.mjs` so counts and queue links share one definition
- A failed telemetry batch now affects only its own repositories, failed lookups are retried on the next refresh, and preferences are written only when the selected owner changes
- Copied preferences found beside the extension code into the artifacts directory once
- Removed the unused Harbor Panorama markup, styles, and server-side state classification
- Replaced source-text assertions in the validators with behavioral tests for queue telemetry, finding order, and focus preservation

## 0.3.0 - 2026-11-13

- Added one-click, read-only repository assessments from repository and attention views
- Added durable mission state, live SSE progress, and structured reviewable findings
- Added a globally unique callback tool for Copilot-coordinated specialist assessments
- Added dependency-free tests for mission persistence, idempotency, safety prompts, callback updates, and malformed results
- Kept issue publication, pull requests, pushes, and all other remote writes outside the assessment workflow
- Added a separate two-step action that can publish one completed stored finding as a plain GitHub issue, with durable idempotency, interruption reconciliation, retryable errors, and no additional mutations
- Defaulted assessments to static read-only inspection; repository code execution now requires separate approval and a secrets-free, network-restricted sandbox
- Added bounded recovery for interrupted in-progress missions so stale work cannot block retries
- Restored the signed-in personal account in the repository-owner selector with user-specific search, queue, and source links
- Removed the redundant repository status badge column while retaining full lifecycle telemetry
- Attached completed assessment findings directly to repository rows and cards with one-at-a-time progressive disclosure
- Added severity-grouped finding summaries with proposed issue titles, root causes, confidence, and evidence/dependency counts
- Routed Needs attention review actions back to the matching Overview repository and replaced the disabled future bulk control with restrained per-finding publication
- Preserved meaningful assessment focus across automatic dashboard rerenders
- Kept completed results reachable through a compact repository-attached recovery shortcut when filtering hides their repository

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
