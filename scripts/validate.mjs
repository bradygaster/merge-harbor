import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPath = join(root, "extension", "extension.mjs");
const htmlPath = join(root, "extension", "merge-harbor.html");
const manifestPath = join(root, "extension", "copilot-extension.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.name !== "merge-harbor" || manifest.version !== 1) {
    throw new Error("copilot-extension.json must identify merge-harbor with manifest version 1.");
}

const syntax = spawnSync(process.execPath, ["--check", extensionPath], {
    encoding: "utf8",
});
if (syntax.status !== 0) {
    throw new Error(syntax.stderr || syntax.stdout || "extension.mjs syntax validation failed.");
}

const extensionSource = readFileSync(extensionPath, "utf8");
if (!extensionSource.includes('listen(0, "127.0.0.1"')) {
    throw new Error("The canvas server must bind to an ephemeral loopback port.");
}
if (extensionSource.includes("console.log(")) {
    throw new Error("console.log is not allowed because extension stdout is reserved for JSON-RPC.");
}

const html = readFileSync(htmlPath, "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!scripts.length) {
    throw new Error("merge-harbor.html must contain its application script.");
}
scripts.forEach((match, index) => {
    new vm.Script(match[1], { filename: `merge-harbor-inline-${index + 1}.js` });
});

console.info("Merge Harbor extension validation passed.");
