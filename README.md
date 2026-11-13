# Merge Harbor

Merge Harbor is a user-level GitHub Copilot canvas for ambient visibility into pull request flow across large engineering organizations. It combines organization-wide repository search, personal cross-organization repository lists, lifecycle telemetry, and direct links to pull requests requiring action.

## Install

Prerequisites:

- GitHub Copilot with extension canvases enabled
- GitHub CLI (`gh`) installed and authenticated to the account whose organizations you want to monitor

Install this folder as a **User** extension:

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

Reinstall the extension from the same GitHub folder URL to pick up a newer release. User preferences remain in the extension artifact directory.

## Development

Run the dependency-free validation:

```shell
node scripts/validate.mjs
```

For local development, copy `extension/` to `$COPILOT_HOME/extensions/merge-harbor/`, reload extensions, and open the `merge-harbor` canvas.

## License

MIT
