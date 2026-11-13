# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Engineering teams operating at enterprise scale who rely on coding agents and need a shared, ambient understanding of merge flow without opening individual repositories or pull requests.

The primary viewing context is a large wall display in an engineering area. People should understand the system's health in a few seconds while passing by, then move closer when a repository or merge needs attention.

## Product Purpose

Provide a continuously readable view of how agent-authored pull requests are progressing across many repositories. Success means the team can see whether work is flowing, identify blocked or aging merges, and notice where human attention will have the most leverage.

## Positioning

The product treats merge activity as an operational system rather than a list of pull requests: it compresses repository-level throughput, risk, aging, review, and automation state into one shared ambient scene.

## Operating Context

- Runs continuously on a large display in a shared engineering space.
- Aggregates activity across roughly 20 repositories.
- Uses GitHub pull request and repository data.
- Supports glanceable viewing from a distance and closer inspection nearby.
- The initial artifact demonstrates the concept with public repositories from the `github` organization.

## Capabilities and Constraints

- Show overall merge health, throughput, backlog, aging, and blocked states.
- Make repository hotspots and items needing human attention visually obvious.
- Distinguish agent activity, automation progress, review state, and merge readiness when data is available.
- Avoid fabricated business claims or performance benchmarks.
- Demo data may be sampled or derived from current public GitHub data and must be labeled accordingly.
- Product name and production data integration are open decisions.

## Evidence on Hand

- Current public GitHub organization repository and pull-request metadata can be used as representative demo content.
- No customer testimonials, private enterprise data, proprietary benchmarks, or committed brand assets were provided.

## Product Principles

- Ambient first: the system should communicate health before it asks for interaction.
- Attention over inventory: emphasize where people can unblock flow, not every available detail.
- Operational truth: clearly separate healthy movement, expected waiting, and exceptional blockage.
- Enterprise scale without visual overload: many repositories should feel comprehensible as one system.
- Calm urgency: serious problems must be unmistakable without turning the wall into an alarm panel.

## Accessibility & Inclusion

State must not rely on color alone. Text and critical indicators need high contrast and remain legible at wall-display distance. Motion must respect reduced-motion preferences and avoid persistent distraction.
