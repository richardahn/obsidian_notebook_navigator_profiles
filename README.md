# Notebook Navigator Profiles

Notebook Navigator Profiles is an Obsidian v1.10.2 plugin that snapshots the configuration produced by the [Notebook Navigator](https://github.com/johansan/notebook-navigator) plugin and lets you switch between those snapshots as named profiles. It works on desktop and mobile vaults.

## Features

- Capture the current Notebook Navigator `data.json` file as a named profile.
- Activate profiles to overwrite Notebook Navigator's configuration with a single click.
- Update, rename, and delete stored profiles from the plugin settings tab.
- Automatically registers a command for each profile (`Activate profile <name>`).
- Keeps a single backup of the previous configuration whenever you activate a profile, with a one-click restore option.

## Requirements

- Obsidian 1.10.2 or newer.
- The Notebook Navigator plugin installed and configured (its data file must exist at `.obsidian/plugins/notebook-navigator/data.json` inside your vault).

## Usage

1. Open **Settings → Community Plugins → Notebook Navigator Profiles**.
2. Click **Create Profile** to save the current Notebook Navigator configuration.
3. Use the buttons next to each saved profile to:
   - **Activate**: replace Notebook Navigator's `data.json` with the profile.
   - **Update**: overwrite the profile with the current Notebook Navigator settings.
   - **Rename**: change the profile's display name and file name.
   - **Delete**: remove the stored profile file.
4. Trigger the profile specific commands (search for `Activate profile ...`) from the command palette or bind them to hotkeys.

All profile files are stored under `.obsidian/plugins/notebook-navigator-profiles/<profile-name>.json`.

## Development

```sh
npm install
npm run build
```

The build outputs `main.js` alongside `manifest.json` and `styles.css`. Copy these files into your vault's `.obsidian/plugins/notebook-navigator-profiles/` directory or zip them for release.

## Install via BRAT

Until the plugin is accepted into the official community list you can preload it with the [Beta Reviewers Auto-update Tester (BRAT)](https://github.com/TfTHacker/obsidian42-brat) plugin.

1. Install and enable BRAT.
2. Use **BRAT → Add Beta plugin**.
3. Enter the repository URL for this project (for example `https://github.com/<your-user>/obsidian_notebook_navigator_profiles`).
4. BRAT will download the latest release assets (`main.js`, `manifest.json`, `styles.css`, and `versions.json`) whenever you update.
