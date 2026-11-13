# Merge Harbor

Merge Harbor is a user-level GitHub Copilot canvas for ambient visibility into pull request flow across large engineering organizations. It combines organization-wide repository search, personal cross-organization repository lists, lifecycle telemetry, and direct links to pull requests requiring action.

## Install as a plugin

Prerequisites:

- GitHub Copilot with extension canvases enabled
- GitHub CLI (`gh`) installed and authenticated to the account whose organizations you want to monitor

1. In GitHub Copilot, open **Customize**.
2. Open the marketplace settings beside the marketplace selector and add `bradygaster/merge-harbor`.
3. Find and install the **merge-harbor** plugin.
4. Reload extensions, then start a new session and open **Merge Harbor**.

The marketplace catalog is `.github/plugin/marketplace.json`. It installs the repository-root Agent Plugin described by `plugin.json`. The app discovers the canvas at `com.github.copilot/extensions/merge-harbor/`; that entrypoint forwards to the existing `extension/` implementation rather than maintaining a second runtime.

### Marketplace visibility

This is a custom marketplace, not a globally featured listing. It appears only for users who add `bradygaster/merge-harbor` as a marketplace and who have GitHub read access to the repository. Adding the marketplace makes the plugin available in **Customize** > **Browse**; installing it makes the plugin manageable in **Customize** > **Installed**.

The plugin supplies the Merge Harbor canvas, but the public app documentation does not guarantee that every custom plugin canvas also receives a separate listing under **Customize** > **Canvas**. That view may be curated, so the supported discovery path is the plugin listing in the configured marketplace.

The catalog intentionally uses no canvas-specific or category metadata. Those fields are not required to load the canvas from the documented Copilot-specific plugin directory.

## Install the extension directly

Direct user-scope installation remains available:

<https://github.com/bradygaster/merge-harbor/tree/main/extension>

In GitHub Copilot, choose **Install extension from GitHub**, paste the URL above, and select **User** scope. You can also ask Copilot to install that extension URL for you.

After installation, ask Copilot to open **Merge Harbor**.

## Why user scope?

The extension follows you across repositories and sessions. Its source is installed under:

```text
$COPILOT_HOME/extensions/merge-harbor/
```

Personal preferences are kept outside the repository under:

```text
$COPILOT_HOME/extensions/merge-harbor/artifacts/preferences.json
```

Reinstalling or updating the extension does not intentionally overwrite that artifact.

## Capabilities

- Select any GitHub organization visible to the authenticated account
- Search the full organization repository inventory as you type
- Save repositories from multiple organizations into My repos
- Persist organization and personal-list preferences
- View mutually exclusive Blocked, Review, Drafts, Checks, Ready, and Other queues
- Open actionable pull requests and GitHub queue searches directly
- Automatically refresh live telemetry
- Switch between list and card layouts

## Security and data

- The embedded web server binds only to `127.0.0.1`.
- GitHub data is read through the locally authenticated `gh` CLI.
- The extension does not require an external service or send preferences to a Merge Harbor backend.
- Repository access is limited to what the authenticated GitHub account can access.

## Update

Update the plugin from **Customize** > **Installed**, or reinstall the extension from the same GitHub folder URL. User preferences remain in the extension artifact directory.

## Compatibility

- Plugin release version: `0.2.0`
- Extension manifest format version: `1`
- Validated app build: `1.0.106-8.unstable.r43162459260.gbfc9f50`
- Plugin layout: Agent Plugins 1.0 `plugin.json`, `.github/plugin/marketplace.json`, and `com.github.copilot/extensions/merge-harbor/`

The app may require an extension reload, app restart, or new session after plugin installation or enable/disable changes. Plugin installation also requires GitHub read access to this repository. Merge Harbor itself continues to use the locally authenticated `gh` CLI and a loopback-only web server.

## Development

Run the dependency-free validation:

```shell
node scripts/validate.mjs
```

For local extension development, copy `extension/` to `$COPILOT_HOME/extensions/merge-harbor/`, reload extensions, and open the `merge-harbor` canvas. For plugin packaging changes, add this repository as a local or GitHub-hosted marketplace and install `merge-harbor@merge-harbor`.

Marketplace and app behavior follow the official GitHub documentation:

- [Creating and sharing a plugin marketplace on GitHub](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/create-and-share-plugin-marketplaces)
- [Plugin and marketplace reference](https://docs.github.com/en/copilot/reference/plugin-and-marketplace-reference)
- [Customizing the GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app)

## License

MIT
