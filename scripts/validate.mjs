import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPath = join(root, "extension", "extension.mjs");
const htmlPath = join(root, "extension", "merge-harbor.html");
const captainImagePath = join(root, "extension", "assets", "merge-harbor-captain.png");
const manifestPath = join(root, "extension", "copilot-extension.json");
const pluginExtensionPath = join(root, "com.github.copilot", "extensions", "merge-harbor", "extension.mjs");
const pluginPath = join(root, "plugin.json");
const marketplacePath = join(root, ".github", "plugin", "marketplace.json");

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
if (!extensionSource.includes('listen(0, "127.0.0.1"')) {
    throw new Error("The canvas server must bind to an ephemeral loopback port.");
}
if (extensionSource.includes("console.log(")) {
    throw new Error("console.log is not allowed because extension stdout is reserved for JSON-RPC.");
}
if (!extensionSource.includes('requestUrl.pathname === "/assets/merge-harbor-captain.png"')) {
    throw new Error("The canvas server must serve the Merge Harbor captain asset.");
}

const html = readFileSync(htmlPath, "utf8");
if (!html.includes('src="/assets/merge-harbor-captain.png"')) {
    throw new Error("The dashboard header must include the Merge Harbor captain asset.");
}
const captainImage = readFileSync(captainImagePath);
if (captainImage.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("The Merge Harbor captain asset must be a PNG.");
}
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!scripts.length) {
    throw new Error("merge-harbor.html must contain its application script.");
}
scripts.forEach((match, index) => {
    new vm.Script(match[1], { filename: `merge-harbor-inline-${index + 1}.js` });
});

console.info(`Merge Harbor plugin ${plugin.version} and extension manifest ${manifest.version} validation passed.`);
