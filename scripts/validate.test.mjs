import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const validatorPath = join(root, "scripts", "validate.mjs");

function runValidation(fixtureRoot) {
    return spawnSync(process.execPath, [validatorPath], {
        encoding: "utf8",
        env: {
            ...process.env,
            MERGE_HARBOR_ROOT: fixtureRoot,
        },
    });
}

function expectResult(name, result, expectedStatus, expectedMessage) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== expectedStatus || (expectedMessage && !output.includes(expectedMessage))) {
        throw new Error(
            `${name} validation returned ${result.status}; expected ${expectedStatus}. Output:\n${output}`,
        );
    }
    console.info(`${name}: observed expected exit ${expectedStatus}.`);
}

const fixtureRoot = mkdtempSync(join(tmpdir(), "merge-harbor-validation-"));

try {
    cpSync(root, fixtureRoot, {
        recursive: true,
        filter: (source) => basename(source) !== ".git",
    });

    expectResult("valid package", runValidation(fixtureRoot), 0, "validation passed");

    const marketplacePath = join(fixtureRoot, ".github", "plugin", "marketplace.json");
    const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
    marketplace.plugins[0].source = "./missing-plugin";
    writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
    expectResult(
        "nonexistent catalog source",
        runValidation(fixtureRoot),
        1,
        "Marketplace plugin source manifest is missing",
    );

    marketplace.plugins[0].source = ".";
    writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");

    const extensionPath = join(fixtureRoot, "extension", "extension.mjs");
    const extensionSource = readFileSync(extensionPath, "utf8");
    writeFileSync(
        extensionPath,
        extensionSource.replace("repositoryOwner(login:$login)", "organization(login:$login)"),
        "utf8",
    );
    expectResult(
        "missing personal owner catalog",
        runValidation(fixtureRoot),
        1,
        "Repository catalogs must support the signed-in user",
    );

    writeFileSync(
        extensionPath,
        extensionSource.replace(
            "repositories(first:100, affiliations:[OWNER]",
            "repositories(first:100",
        ),
        "utf8",
    );
    expectResult(
        "personal catalog includes collaborator repositories",
        runValidation(fixtureRoot),
        1,
        "Repository catalogs must support the signed-in user",
    );
    writeFileSync(extensionPath, extensionSource, "utf8");

    const htmlPath = join(fixtureRoot, "extension", "merge-harbor.html");
    const html = readFileSync(htmlPath, "utf8");
    writeFileSync(htmlPath, html.replace("</style>", ".repo-state { display: block; }</style>"), "utf8");
    expectResult(
        "restored repository status badge",
        runValidation(fixtureRoot),
        1,
        "Repository rows must not render the removed status badge column",
    );
    writeFileSync(htmlPath, html, "utf8");

    rmSync(join(fixtureRoot, "extension", "assets", "merge-harbor-captain.png"));
    expectResult(
        "missing packaged canvas asset",
        runValidation(fixtureRoot),
        1,
        "Merge Harbor captain asset is missing",
    );
} finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
}
