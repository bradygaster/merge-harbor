import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "extension", "merge-harbor.html"), "utf8");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

[
    'aria-controls="${missionPanelId(mission.id)}"',
    'role="region" aria-labelledby="${missionPanelId(mission.id)}-heading"',
    "<details class=\"finding assessment-finding\"",
    "<h4>Root cause</h4>",
    "<h4>Evidence</h4>",
    "<h4>Dependencies</h4>",
    "<h4>Proposed issue</h4>",
    "No reviewable root causes reported.",
    "openAssessmentRepositoryKey",
    "openFindingIndexesByRepository",
    "clearAssessmentDisclosureState()",
    'data-review-route="overview"',
    'focus({ preventScroll: true })',
].forEach((clause) => assert(html.includes(clause), `Assessment disclosure is missing: ${clause}`));

assert(!html.includes("Create selected issues"), "Future issue publication controls must not be rendered.");
assert(
    html.indexOf("<h4>Root cause</h4>") < html.indexOf("<h4>Evidence</h4>")
    && html.indexOf("<h4>Evidence</h4>") < html.indexOf("<h4>Dependencies</h4>")
    && html.indexOf("<h4>Dependencies</h4>") < html.indexOf("<h4>Proposed issue</h4>"),
    "Expanded findings must preserve the required information order.",
);
assert(
    html.includes('severityOrder[a.finding.severity] - severityOrder[b.finding.severity]')
    && html.includes('confidenceOrder[a.finding.confidence] - confidenceOrder[b.finding.confidence]')
    && html.includes("a.originalIndex - b.originalIndex"),
    "Findings must sort by severity, confidence, then original order.",
);
assert(
    html.includes('.repo-collection.card-view .repo-entry.assessment-open')
    && html.includes("grid-column: 1 / -1"),
    "Expanded assessment cards must span the collection width.",
);

console.info("Repository assessment disclosure structure and interaction tests passed.");
