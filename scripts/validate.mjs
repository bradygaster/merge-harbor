import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = resolve(process.env.MERGE_HARBOR_ROOT ?? scriptRoot);
const extensionPath = join(root, "extension", "extension.mjs");
const htmlPath = join(root, "extension", "merge-harbor.html");
const manifestPath = join(root, "extension", "copilot-extension.json");
const pluginExtensionPath = join(root, "com.github.copilot", "extensions", "merge-harbor", "extension.mjs");
const pluginPath = join(root, "plugin.json");
const marketplacePath = join(root, ".github", "plugin", "marketplace.json");
const readmePath = join(root, "README.md");
const changelogPath = join(root, "CHANGELOG.md");
const assessmentCorePath = join(root, "extension", "assessment-core.mjs");
const assessmentTestPath = join(root, "scripts", "assessment.test.mjs");

function requireFile(path, label) {
    if (!existsSync(path)) {
        throw new Error(`${label} is missing: ${relative(root, path)}`);
    }
}

[
    [extensionPath, "Canvas runtime"],
    [htmlPath, "Canvas HTML"],
    [manifestPath, "Direct extension manifest"],
    [pluginExtensionPath, "Plugin canvas entrypoint"],
    [pluginPath, "Plugin manifest"],
    [marketplacePath, "Marketplace catalog"],
    [readmePath, "README"],
    [changelogPath, "Changelog"],
    [assessmentCorePath, "Assessment mission core"],
    [assessmentTestPath, "Assessment mission tests"],
].forEach(([path, label]) => requireFile(path, label));

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.name !== "merge-harbor" || manifest.version !== 1) {
    throw new Error("copilot-extension.json must identify merge-harbor with manifest version 1.");
}

const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
if (plugin.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
    throw new Error("plugin.json must use the Agent Plugins 1.0 schema.");
}
if (plugin.name !== "merge-harbor" || !/^\d+\.\d+\.\d+$/.test(plugin.version)) {
    throw new Error("plugin.json must identify merge-harbor with a semantic release version.");
}
if (!plugin.extensions || typeof plugin.extensions["com.github.copilot"] !== "object") {
    throw new Error("plugin.json must declare GitHub Copilot app compatibility.");
}

const pluginExtensionSource = readFileSync(pluginExtensionPath, "utf8").trim();
if (pluginExtensionSource !== 'import "../../../extension/extension.mjs";') {
    throw new Error("The plugin canvas entrypoint must forward to the existing direct-install extension.");
}

const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
const marketplacePlugin = marketplace.plugins?.find((entry) => entry.name === "merge-harbor");
if (marketplace.name !== plugin.name || marketplace.plugins?.length !== 1 || !marketplacePlugin) {
    throw new Error("marketplace.json must publish the merge-harbor plugin.");
}
if (typeof marketplacePlugin.source !== "string" || !marketplacePlugin.source.trim()) {
    throw new Error("marketplace.json must declare a non-empty local plugin source.");
}
if (isAbsolute(marketplacePlugin.source)) {
    throw new Error("marketplace.json plugin source must be repository-relative.");
}
const marketplaceSourcePath = resolve(root, marketplacePlugin.source);
const sourceRelativePath = relative(root, marketplaceSourcePath);
if (sourceRelativePath === ".." || sourceRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("marketplace.json plugin source must stay within the repository.");
}
const sourcePluginPath = join(marketplaceSourcePath, "plugin.json");
requireFile(sourcePluginPath, "Marketplace plugin source manifest");
if (JSON.stringify(JSON.parse(readFileSync(sourcePluginPath, "utf8"))) !== JSON.stringify(plugin)) {
    throw new Error("The marketplace source plugin manifest must match repository-root plugin.json.");
}
if (
    marketplacePlugin.source !== "." ||
    marketplacePlugin.version !== plugin.version ||
    marketplacePlugin.description !== plugin.description
) {
    throw new Error("marketplace.json must publish the repository-root plugin at the plugin release version.");
}
if (marketplace.metadata?.version !== plugin.version) {
    throw new Error("marketplace metadata and plugin release versions must match.");
}
if (
    JSON.stringify(marketplacePlugin.author) !== JSON.stringify(plugin.author) ||
    marketplacePlugin.homepage !== plugin.repository ||
    marketplacePlugin.repository !== plugin.repository ||
    marketplacePlugin.license !== plugin.license ||
    JSON.stringify(marketplacePlugin.keywords) !== JSON.stringify(plugin.keywords)
) {
    throw new Error("marketplace listing metadata must match the repository-root plugin identity.");
}
if ("canvas" in marketplacePlugin || "canvases" in marketplacePlugin) {
    throw new Error("marketplace.json must not invent unsupported canvas metadata.");
}

const readme = readFileSync(readmePath, "utf8");
const changelog = readFileSync(changelogPath, "utf8");
if (!readme.includes(`Plugin release version: \`${plugin.version}\``)) {
    throw new Error("README compatibility information must match the plugin release version.");
}
if (!changelog.includes(`## ${plugin.version} -`)) {
    throw new Error("CHANGELOG must contain the plugin release version.");
}

const syntax = spawnSync(process.execPath, ["--check", extensionPath], {
    encoding: "utf8",
});
if (syntax.status !== 0) {
    throw new Error(syntax.stderr || syntax.stdout || "extension.mjs syntax validation failed.");
}
const pluginSyntax = spawnSync(process.execPath, ["--check", pluginExtensionPath], {
    encoding: "utf8",
});
if (pluginSyntax.status !== 0) {
    throw new Error(pluginSyntax.stderr || pluginSyntax.stdout || "plugin extension entrypoint syntax validation failed.");
}

const extensionSource = readFileSync(extensionPath, "utf8");
const assessmentCoreSource = readFileSync(assessmentCorePath, "utf8");
if (!extensionSource.includes('listen(0, "127.0.0.1"')) {
    throw new Error("The canvas server must bind to an ephemeral loopback port.");
}
if (extensionSource.includes("console.log(")) {
    throw new Error("console.log is not allowed because extension stdout is reserved for JSON-RPC.");
}
if (!extensionSource.includes("session.send({ prompt: buildAssessmentPrompt")) {
    throw new Error("Repository assessments must use the supported session.send bridge.");
}
if (!extensionSource.includes('name: "merge_harbor_report_repository_assessment"')) {
    throw new Error("Repository assessments must expose the globally unique callback tool.");
}
[
    "isolated local clone or disposable worktree",
    "Never use or modify the user's existing checkout",
    "Disable pushing",
    "no pushes, issue creation, pull request creation, label changes",
    "Default to static, read-only inspection",
    "Do not run repository tests, builds, scripts, hooks, package installs",
    "it is not execution isolation",
    "separate explicit user approval",
    "real isolated sandbox with secrets removed and outbound network access restricted",
    "Nothing may be published automatically",
].forEach((clause) => {
    if (!assessmentCoreSource.includes(clause)) {
        throw new Error(`Assessment prompt safety clause is missing: ${clause}`);
    }
});
if (!extensionSource.includes('candidate.status === "queued"') && !extensionSource.includes('mission.status === "queued"')) {
    throw new Error("Queued assessment missions must be safely requeued after extension startup.");
}
if (!extensionSource.includes("recoverInterruptedMissions(missionStore)")) {
    throw new Error("Interrupted in-progress missions must be recovered after a bounded timeout.");
}
if (
    !extensionSource.includes("repositoryOwner(login:$login)") ||
    !extensionSource.includes("repositories(first:100, affiliations:[OWNER]") ||
    !extensionSource.includes('kind: "user"') ||
    !extensionSource.includes('owner.kind === "user" ? "user" : "org"')
) {
    throw new Error("Repository catalogs must support the signed-in user and organizations with owner-kind search.");
}

const html = readFileSync(htmlPath, "utf8");
const assetPaths = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)]
    .map((match) => join(root, "extension", "assets", match[1]));
assetPaths.forEach((path) => requireFile(path, "Packaged canvas asset"));
if (
    !html.includes("(personal)") ||
    !html.includes('currentOwnerKind === "user"') ||
    !html.includes("?tab=repositories")
) {
    throw new Error("The owner selector and links must preserve personal-account owner kind.");
}
if (html.includes(".repo-state") || html.includes('class="repo-state')) {
    throw new Error("Repository rows must not render the removed status badge column.");
}
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!scripts.length) {
    throw new Error("merge-harbor.html must contain its application script.");
}
scripts.forEach((match, index) => {
    new vm.Script(match[1], { filename: `merge-harbor-inline-${index + 1}.js` });
});
const assessmentTest = spawnSync(process.execPath, [assessmentTestPath], {
    encoding: "utf8",
});
if (assessmentTest.status !== 0) {
    throw new Error(assessmentTest.stderr || assessmentTest.stdout || "assessment.test.mjs failed.");
}

console.info(`Merge Harbor plugin ${plugin.version} and extension manifest ${manifest.version} validation passed.`);
