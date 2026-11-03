# Easy Local Backup

One-click backup of your Obsidian vault to a folder on your computer.

Click the backup button in the left ribbon (or run **Back up vault now** from the command palette) and the plugin copies your whole vault to the destination you chose in the plugin settings.

## Backups are never deleted automatically

Every backup is a **full, separate copy** of your vault in a new timestamped folder, for example `MyVault-backup-2026-10-30_143022`. The plugin never deletes old backups, so the destination folder grows by the size of your vault every time you back up.

For example, a 500 MB vault backed up daily uses about 15 GB in a month.

**You are responsible for removing old backups.** Delete the folders you no longer need from your destination folder from time to time. If the destination runs out of space, backups will stop with a "Not enough free space" message.

## Features

- **Ribbon button and command.** Back up from the left ribbon or the command palette.
- **Choose your destination.** Type a path or use **Browse…** to pick a folder.
- **Early warnings.** The settings page warns you right away if the destination isn't an absolute path or is inside the vault.
- **Complete or absent.** The vault is copied into a folder ending in `.partial` and renamed only when the whole copy succeeds, so you never end up with a half-finished backup that looks real.
- **Free space check.** Before copying, the plugin checks that the destination has enough room and stops early if it doesn't.
- **Last backup time.** The settings page shows when the last backup was made.
- **Clean cancel.** Disabling the plugin while a backup is running stops it and removes the incomplete copy.

## Installation

The plugin is not in the community plugin list. To install it manually:

1. Build it (see [Development](#development)) or take `main.js`, `manifest.json` and `styles.css` from a release.
2. Create the folder `<your vault>/.obsidian/plugins/easy-local-backup/`.
3. Copy those three files into it.
4. In Obsidian, open **Settings → Community plugins**, reload the list, and turn on **Easy Local Backup**.

## Usage

1. Open **Settings → Easy Local Backup**.
2. Click **Browse…** and pick the folder where backups should be stored (or type the path).
3. Click the backup button in the left ribbon.

A notice shows when the backup finishes and where it was saved.

## How it works

- Each backup is copied into `<destination>/<vault name>-backup-<date>_<time>.partial` first, then renamed to remove `.partial` once everything has been copied.
- If a backup is interrupted (crash, power loss, quitting Obsidian mid-backup), the leftover `.partial` folder is deleted automatically at the start of the next backup.
- File modification times are preserved in the copy.
- If a file is mid-copy when you cancel, that file finishes first, then the backup stops.

## Limitations

- **Desktop only.** The plugin uses your computer's file system, so it doesn't work on mobile.
- **The destination must be outside the vault.** Otherwise the backup would copy into itself.
- **Not a snapshot.** If files change while a backup is running (by Obsidian or a sync tool), the copy can contain a mix of old and new versions. For best results, avoid editing during a backup.
- **Symbolic links are skipped.** The completion message tells you how many items were skipped.
- **Free space check needs a recent Node version.** On older Obsidian versions where it isn't available, the check is skipped and the backup runs without it.
- **No restore feature.** To restore, close Obsidian and copy the files from a backup folder back into your vault folder, or open the backup folder as a vault.

## Development

```bash
npm install        # install dependencies
npm run dev        # build and watch for changes
npm run build      # type-check and build for production
npm run lint       # run ESLint
```

The source is in `src/` (`main.ts` and `settings.ts`). `manifest.json` and `styles.css` are in the project root. For development, put or clone the project folder in `<your vault>/.obsidian/plugins/easy-local-backup/` and reload Obsidian after each build.