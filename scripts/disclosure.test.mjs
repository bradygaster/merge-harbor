import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "extension", "merge-harbor.html"), "utf8");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

// Pulls named function declarations out of the page script so their behavior
// can be tested without a browser. Template literals keep braces balanced.
function loadPageFunctions(names, globals = {}) {
    const sources = names.map((name) => {
        const start = html.indexOf(`function ${name}(`);
        assert(start !== -1, `merge-harbor.html must define ${name}().`);
        let depth = 0;
        for (let index = html.indexOf("{", start); index < html.length; index += 1) {
            if (html[index] === "{") depth += 1;
            if (html[index] === "}" && --depth === 0) return html.slice(start, index + 1);
        }
        throw new Error(`Could not read ${name}() from merge-harbor.html.`);
    });
    const context = vm.createContext({ ...globals });
    vm.runInContext(`${sources.join("\n")}\nthis.exports = { ${names.join(", ")} };`, context);
    return context.exports;
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

{
    // Assessments live only in their repository rows; there is no page-level assessments panel.
    assert(!html.includes('id="mission-center"'), "Repository assessments must not render in a page-level panel.");
    const { assessmentStatusNote } = loadPageFunctions(["assessmentStatusNote"], {
        escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
    });
    assert(assessmentStatusNote(undefined) === "", "Repositories without an assessment show no status note.");
    assert(assessmentStatusNote({ status: "completed" }) === "", "Completed assessments use the findings toggle, not a status note.");
    const running = assessmentStatusNote({ status: "in_progress", phase: "Coordinating specialists" });
    assert(running.includes("Assessment in progress") && running.includes("Coordinating specialists"), "Running assessments must show their phase in the row.");
    assert(assessmentStatusNote({ status: "queued" }).includes("Starting assessment"), "Queued assessments must show that they are starting.");
    const failed = assessmentStatusNote({ status: "failed", message: "Copilot could not start <the> assessment" });
    assert(failed.includes("Assessment failed") && failed.includes("&lt;the&gt;"), "Failed assessments must show their escaped reason in the row.");
}
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
{
    const { groupFindings } = loadPageFunctions(["groupFindings"]);
    const groups = groupFindings([
        { severity: "low", confidence: "high" },
        { severity: "high", confidence: "low" },
        { severity: "critical", confidence: "medium" },
        { severity: "high", confidence: "high" },
        { severity: "high", confidence: "low" },
    ]);
    assert(
        JSON.stringify(groups.map((group) => group.label)) === JSON.stringify(["Critical and high", "Low"]),
        "Findings must group as critical and high, medium, then low, omitting empty groups.",
    );
    assert(
        JSON.stringify(groups[0].items.map((item) => item.originalIndex)) === JSON.stringify([2, 3, 1, 4]),
        "Findings must sort by severity, confidence, then original order.",
    );
}
assert(
    html.includes('.repo-collection.card-view .repo-entry.assessment-open')
    && html.includes("grid-column: 1 / -1"),
    "Expanded assessment cards must span the collection width.",
);
{
    // A minimal element model: enough selector support for the focus helpers.
    class HTMLElement {
        constructor({ tagName = "DIV", selectors = [], dataset = {}, parent, children = [] } = {}) {
            Object.assign(this, { tagName, selectors, dataset, parent, children, isConnected: true });
            children.forEach((child) => { child.parent = this; });
        }
        matches(selector) { return this.selectors.includes(selector); }
        closest(selector) {
            for (let node = this; node; node = node.parent) if (node.matches(selector)) return node;
            return null;
        }
        querySelectorAll(selector) {
            return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
        focus() { focused = this; }
    }
    let focused;
    const document = { activeElement: undefined, body: {}, querySelectorAll: () => [] };
    const { captureAssessmentFocus, restoreAssessmentFocus } = loadPageFunctions(
        ["captureAssessmentFocus", "restoreAssessmentFocus"],
        { HTMLElement, document, requestAnimationFrame: (callback) => callback() },
    );

    const build = () => {
        const summary = new HTMLElement({ tagName: "SUMMARY", selectors: ["summary"] });
        const draft = new HTMLElement({ tagName: "PRE", selectors: ["pre"] });
        const issueButton = new HTMLElement({ tagName: "BUTTON", selectors: ['[data-issue-action]', '[data-issue-action="create"]'], dataset: { issueAction: "create" } });
        const finding = new HTMLElement({ selectors: [".assessment-finding"], dataset: { findingIndex: "2" }, children: [summary, draft, issueButton] });
        const heading = new HTMLElement({ tagName: "H2", selectors: [".assessment-panel h2"] });
        const trigger = new HTMLElement({ tagName: "BUTTON", selectors: ["[data-review-repository]"] });
        const entry = new HTMLElement({ selectors: [".repo-entry[data-repository-key]"], dataset: { repositoryKey: "octo/repo" }, children: [trigger, heading, finding] });
        return { entry, trigger, heading, summary, draft, issueButton };
    };

    for (const target of ["trigger", "heading", "summary", "draft", "issueButton"]) {
        const before = build();
        document.activeElement = before[target];
        const snapshot = captureAssessmentFocus();
        assert(snapshot?.repositoryKey === "octo/repo", `Focus on the ${target} must be captured with its repository.`);

        const after = build();
        document.activeElement = document.body;
        document.querySelectorAll = () => [after.entry];
        focused = undefined;
        restoreAssessmentFocus(snapshot);
        assert(focused === after[target], `Focus on the ${target} must survive a dashboard rerender.`);
    }

    document.activeElement = new HTMLElement({ selectors: [] });
    assert(captureAssessmentFocus() === undefined, "Focus outside a repository entry must not be captured.");
}

console.info("Repository assessment disclosure structure and interaction tests passed.");
