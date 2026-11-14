# Merge Harbor

Merge Harbor is a user-level GitHub Copilot canvas for ambient visibility into pull request flow across large engineering organizations. It combines organization-wide repository search, personal cross-organization repository lists, lifecycle telemetry, and direct links to pull requests requiring action.

Merge Harbor also provides a conservative one-click **Assess repository** action. It creates a durable mission, asks the current Copilot session to coordinate up to three bounded specialists in an isolated disposable local clone or worktree at the exact default-branch commit, and returns reviewable root causes and draft issue text. The clone or worktree, mission state, and any approved experimental file changes stay on the user's machine, but assessment is not offline: relevant repository content is processed through the GitHub Copilot service, and GitHub metadata is read using the user's authenticated `gh` access. Assessments default to static, read-only inspection and never run repository tests, builds, scripts, hooks, package installs, package-manager commands, or executable repository code. A clone or worktree is filesystem separation, not execution isolation. Any execution requires separate explicit user approval and a real isolated sandbox with secrets removed and outbound network access restricted. Assessments never push, publish code, create issues or pull requests, change labels, or modify the user's existing checkout.

## Install from the marketplace

Prerequisites:

- GitHub Copilot desktop app with custom plugins and extension canvases enabled
- GitHub read access to `bradygaster/merge-harbor`
- GitHub CLI (`gh`) installed and authenticated to the account whose organizations you want to monitor

1. In GitHub Copilot, open **Customize**.
2. Open the marketplace settings beside the marketplace selector.
3. Add the marketplace repository `bradygaster/merge-harbor`.
4. Return to **Browse**, select that marketplace, and find **merge-harbor**.
5. Install and enable the plugin.
6. Reload extensions if prompted, start a new session, and ask Copilot to open **Merge Harbor**.
7. Select your personal account, an organization, or open **My repos**. Merge Harbor reads only repositories and pull requests visible to the account authenticated in `gh`.

The marketplace catalog is `.github/plugin/marketplace.json`. It installs the repository-root Agent Plugin described by `plugin.json`. The app discovers the canvas at `com.github.copilot/extensions/merge-harbor/`; that entrypoint forwards to the existing `extension/` implementation rather than maintaining a second runtime.

### Marketplace visibility

This is a custom marketplace, not a globally featured listing. It appears only for users who add `bradygaster/merge-harbor` as a marketplace and who have GitHub read access to the repository. Adding the marketplace makes the plugin available in **Customize** > **Browse**; installing it makes the plugin manageable in **Customize** > **Installed**.

The plugin supplies the Merge Harbor canvas, but a custom plugin canvas is not guaranteed to receive a separate listing under **Customize** > **Canvas**. That view may be curated. Use the plugin listing in **Customize** > **Browse** or **Installed**, then open the canvas from a session.

The catalog intentionally uses no canvas-specific or category metadata. Those fields are not required to load the canvas from the documented Copilot-specific plugin directory.

## Install the extension directly

Direct user-scope installation remains available:

<https://github.com/bradygaster/merge-harbor/tree/main/extension>

In GitHub Copilot, choose **Install extension from GitHub**, paste the URL above, and select **User** scope. You can also ask Copilot to install that extension URL for you.

After installation, ask Copilot to open **Merge Harbor**.

## Update, disable, and uninstall

- **Update:** Open **Customize** > **Installed**, select **merge-harbor**, and use the update action when the app offers one. If no update action is exposed, uninstall and reinstall from the same marketplace after confirming the marketplace points at the intended release.
- **Disable or re-enable:** Use the plugin controls under **Customize** > **Installed**, then reload extensions or start a new session if the canvas list does not refresh immediately.
- **Uninstall:** Remove **merge-harbor** from **Customize** > **Installed**. Removing the plugin does not imply removal of its separately stored preference artifact.
- **Remove the marketplace:** Remove `bradygaster/merge-harbor` from marketplace settings only after uninstalling if you no longer want the custom listing to appear.

The app's available lifecycle controls can vary by build. If **Update**, **Disable**, or **Uninstall** is not shown, record the app version and treat that action as an app limitation rather than using direct file copying as proof that the marketplace flow works.

## Preference persistence

The extension follows you across repositories and sessions. Its source is installed under:

```text
$COPILOT_HOME/extensions/merge-harbor/
```

Server-side preferences are kept outside the packaged repository under:

```text
$COPILOT_HOME/extensions/merge-harbor/artifacts/preferences.json
```

That file stores the selected organization and **My repos** list. Auto-refresh settings are browser-local settings for the canvas page. The plugin package does not write either preference store during installation. Updating, disabling, or reinstalling is therefore expected to preserve preferences unless the app removes the extension artifact directory or browser storage. Uninstall behavior is app-owned; back up the preference file before uninstalling if preserving the list is important.

## Capabilities

- Select the authenticated personal account or any visible GitHub organization
- Search the full selected-owner repository inventory as you type
- Save repositories from multiple owners into My repos
- Persist selected-owner and personal-list preferences
- View mutually exclusive Blocked, Review, Drafts, Checks, Ready, and Other queues
- Open actionable pull requests and GitHub queue searches directly
- Automatically refresh live telemetry
- Switch between list and card layouts
- Start one isolated local assessment from a repository or attention entry
- Track assessment progress across extension reloads
- Recover interrupted assessments after a bounded timeout so users can retry
- Review completed findings inline with the repository that produced them
- Scan executive summaries before expanding evidence, dependencies, and draft issue text
- Recover completed findings from the compact mission index when their repository is outside the current owner, scope, or search

## Security and data

- The embedded web server binds only to `127.0.0.1`.
- GitHub data is read through the locally authenticated `gh` CLI.
- The extension does not require an external service or send preferences to a Merge Harbor backend.
- Repository access is limited to what the authenticated GitHub account can access.
- Assessment clones or worktrees, mission state, and approved experimental file changes remain local, but relevant repository content is processed through the GitHub Copilot service; assessments are not offline.
- Assessment missions prohibit remote writes and default to static inspection in disposable local clones or worktrees coordinated by the current Copilot session.
- Repository code execution is blocked unless the user separately approves it and a secrets-free, network-restricted sandbox is available.
- Findings remain local drafts. Issue publication is not included and requires a separate explicit user-approved workflow.

## Compatibility

- Plugin release version: `0.3.0`
- Extension manifest format version: `1`
- App build used for runtime smoke: `1.4.0`
- Plugin layout: Agent Plugins 1.0 `plugin.json`, `.github/plugin/marketplace.json`, and `com.github.copilot/extensions/merge-harbor/`

The app may require an extension reload, app restart, or new session after plugin installation or enable/disable changes. Merge Harbor itself continues to use the locally authenticated `gh` CLI and a loopback-only web server.

## Verification status

The dependency-free validator checks the real marketplace source, plugin identity and release consistency, the Copilot contribution path, JavaScript syntax, and every packaged `/assets/` reference. Its fixture tests prove that a nonexistent catalog source and a missing packaged canvas asset fail with a nonzero exit code.

The `1.4.0` app build opened the already installed user-scope Merge Harbor canvas and started its loopback server. Read-only `gh` smoke checks also confirmed access to `octodemo/octocat_supply-potential-succotash` and its open pull requests without changing repository contents. These checks demonstrate runtime and GitHub-access viability, but they are **not** evidence of a first-time marketplace install: the active user installation could mask packaging defects.

A disposable Windows Sandbox, VM, or throwaway Windows user with a separate app profile is still required to capture native UI evidence for add marketplace, install, update, disable/re-enable, uninstall, and preference persistence. Setting `COPILOT_HOME` alone is not full app-profile isolation. Do not alter the active user's AppData, Copilot home, credentials, or installed extension to manufacture that evidence.

### Troubleshooting

- **Marketplace is empty or unavailable:** Confirm repository read access and that the marketplace repository is exactly `bradygaster/merge-harbor`.
- **Install succeeds but the canvas is missing:** Reload extensions, start a new session, and ask Copilot to open **Merge Harbor**. Do not rely on a separate **Customize** > **Canvas** listing.
- **GitHub data fails to load:** Run `gh auth status`, confirm the intended account and SSO authorization, and verify that account can read the target organization and repositories.
- **Preferences appear reset:** Check whether `$COPILOT_HOME/extensions/merge-harbor/artifacts/preferences.json` still exists and whether the app used the same user profile.
- **Packaging validation fails:** Run both commands below. The error identifies the missing source, manifest, contribution, asset, or release mismatch.

## Development

Run the dependency-free validation:

```shell
node scripts/validate.mjs
node scripts/validate.test.mjs
node scripts/assessment.test.mjs
node scripts/disclosure.test.mjs
```

For local extension development, copy `extension/` to `$COPILOT_HOME/extensions/merge-harbor/`, reload extensions, and open the `merge-harbor` canvas. For plugin packaging changes, add this repository as a local or GitHub-hosted marketplace and install `merge-harbor@merge-harbor`.

Marketplace and app behavior follow the official GitHub documentation:

- [Creating and sharing a plugin marketplace on GitHub](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/create-and-share-plugin-marketplaces)
- [Plugin and marketplace reference](https://docs.github.com/en/copilot/reference/plugin-and-marketplace-reference)
- [Customizing the GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app)

## License

MIT
