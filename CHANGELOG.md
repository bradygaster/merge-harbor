# Changelog

## 0.3.0 - 2026-11-13

- Added one-click, read-only repository assessments from repository and attention views
- Added durable mission state, live SSE progress, and structured reviewable findings
- Added a globally unique callback tool for Copilot-coordinated specialist assessments
- Added dependency-free tests for mission persistence, idempotency, safety prompts, callback updates, and malformed results
- Kept issue publication, pull requests, pushes, and all other remote writes outside the assessment workflow
- Defaulted assessments to static read-only inspection; repository code execution now requires separate approval and a secrets-free, network-restricted sandbox
- Added bounded recovery for interrupted in-progress missions so stale work cannot block retries

## 0.2.0 - 2026-11-13

- Added an Agent Plugins 1.0 manifest and GitHub-hosted marketplace catalog
- Added a canonical Copilot app extension entrypoint that forwards to the existing canvas runtime
- Added dependency-free validation for catalog identity, plugin metadata, and contribution paths
- Documented plugin installation, marketplace visibility limits, lifecycle expectations, and compatibility
- Added the Merge Harbor captain artwork to the dashboard masthead

## 0.1.0 - 2026-11-13

- Initial user-level Merge Harbor canvas release
- Live organization and pull request telemetry
- Organization-wide repository search
- Persistent cross-organization My repos list
- List and card layouts with actionable lifecycle queues
- Automatic refresh and GitHub-native visual styling
