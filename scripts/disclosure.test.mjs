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
    "captureAssessmentFocus()",
    "restoreAssessmentFocus(assessmentFocus)",
    "clearAssessmentDisclosureState()",
    'data-review-route="overview"',
    'data-recover-mission="${escapeHtml(mission.id)}"',
    "assessmentRecoveryEntry(recoveredMission)",
    "Show repository findings",
    'focus({ preventScroll: true })',
    'data-issue-action="prepare">Create issue</button>',
    'data-issue-action="create"',
    "Create on GitHub",
    "Creating issue…",
    "Retry on GitHub",
    'data-issue-action="cancel"',
    "Open issue #${finding.publication.number}",
    'fetch("/api/assessment-issues"',
    "issueCreationStateByFinding",
    "This is an explicit remote write.",
].forEach((clause) => assert(html.includes(clause), `Assessment disclosure is missing: ${clause}`));

assert(!html.includes("Create selected issues"), "Bulk issue publication controls must not be rendered.");
const findingSummaryEnd = html.indexOf("</summary>", html.indexOf("<details class=\"finding assessment-finding\""));
const issueActionStart = html.indexOf("${renderIssuePublication", html.indexOf("<details class=\"finding assessment-finding\""));
assert(issueActionStart > findingSummaryEnd, "Issue publication controls must remain outside the finding summary.");
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
assert(
    html.includes('active.tagName === "SUMMARY"')
    && html.includes('active.tagName === "PRE"')
    && html.includes('active.matches(".assessment-panel h2")')
    && html.includes('active.matches("[data-review-repository]")'),
    "Dashboard rerenders must preserve meaningful assessment focus targets.",
);
assert(
    html.includes('active.closest("[data-issue-action]")')
    && html.includes('kind: "issue-action"')
    && html.includes('finding?.querySelector(`[data-issue-action="${snapshot.issueAction}"]`)'),
    "Issue publication focus must survive ordinary dashboard rerenders.",
);
assert(
    html.includes('mission.status !== "completed" || mission.id === recoveredAssessmentMissionId')
    && html.includes("This completed assessment is outside the current repository set."),
    "Completed results outside the current collection must remain recoverable without a global findings wall.",
);

console.info("Repository assessment disclosure structure and interaction tests passed.");
