import { App, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
import * as path from "path";
import type EasyLocalBackupPlugin from "./main";

export interface EasyLocalBackupSettings {
	/** Absolute path of the folder that will hold the backups. */
	destination: string;
	/** Epoch milliseconds of the last successful backup, or null if none yet. */
	lastBackup: number | null;
	/** Folder name of the last successful backup. */
	lastBackupName: string;
}

export const DEFAULT_SETTINGS: EasyLocalBackupSettings = {
	destination: "",
	lastBackup: null,
	lastBackupName: "",
};

/** True if `child` is the same as, or located inside, `parent`. */
function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	if (rel === "") return true;
	return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/**
 * Checks a destination path. Returns a human-readable problem, or null if the
 * path is fine. An empty destination returns null: it is "not set yet", not invalid.
 * Used by both the settings tab (as you type) and the backup itself.
 */
export function validateDestination(destination: string, vaultPath: string | null): string | null {
	const value = destination.trim();
	if (!value) return null;

	if (!path.isAbsolute(value)) {
		return "The destination must be an absolute path, such as C:\\Backups or /home/me/backups.";
	}
	if (vaultPath && isInside(path.resolve(vaultPath), path.resolve(value))) {
		return "The destination can't be inside the vault. Pick a folder outside it.";
	}
	return null;
}

/**
 * Opens a native "choose folder" dialog and resolves with the chosen
 * absolute path, or null if the user cancelled.
 */
async function pickFolder(defaultPath: string): Promise<string | null> {
	const electron = (window as any).require?.("electron");

	// Preferred: native Electron dialog.
	const dialog = electron?.remote?.dialog;
	if (dialog) {
		const result = await dialog.showOpenDialog({
			title: "Choose backup destination",
			defaultPath: defaultPath || undefined,
			properties: ["openDirectory", "createDirectory"],
		});
		if (result.canceled || !result.filePaths?.length) return null;
		return result.filePaths[0];
	}

	// Fallback: hidden <input webkitdirectory>. Works only for non-empty folders.
	return new Promise<string | null>((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.webkitdirectory = true;
		input.addEventListener("cancel", () => resolve(null));
		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (!file) {
				resolve(null);
				return;
			}

			const absolute: string | undefined =
				electron?.webUtils?.getPathForFile?.(file) ?? (file as any).path;
			if (!absolute) {
				resolve(null);
				return;
			}

			// webkitRelativePath is "PickedFolder/sub/file.txt"; walk back up to PickedFolder.
			const depth = file.webkitRelativePath.split("/").length - 1;
			let folder = absolute;
			for (let i = 0; i < depth; i++) folder = path.dirname(folder);
			resolve(folder);
		});
		input.click();
	});
}

export class EasyLocalBackupSettingTab extends PluginSettingTab {
	plugin: EasyLocalBackupPlugin;
	private lastBackupSetting: Setting | null = null;
	private warningEl: HTMLElement | null = null;

	constructor(app: App, plugin: EasyLocalBackupPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		let destinationInput: TextComponent;

		const destinationSetting = new Setting(containerEl)
			.setName("Backup destination")
			.setDesc(
				"Folder where backups are stored. Each backup is a new timestamped subfolder. " +
					"It must be outside this vault."
			)
			.addText((text) => {
				destinationInput = text;
				text
					.setPlaceholder("C:\\Backups  or  /home/me/backups")
					.setValue(this.plugin.settings.destination)
					.onChange(async (value) => {
						this.plugin.settings.destination = value.trim();
						this.updateDestinationWarning();
						await this.plugin.saveSettings();
					});
				text.inputEl.style.width = "280px";
			})
			.addButton((button) =>
				button
					.setButtonText("Browse…")
					.setTooltip("Pick the destination folder")
					.onClick(async () => {
						try {
							const picked = await pickFolder(this.plugin.settings.destination);
							if (!picked) return;
							this.plugin.settings.destination = picked;
							destinationInput.setValue(picked);
							this.updateDestinationWarning();
							await this.plugin.saveSettings();
						} catch (error) {
							console.error("Easy Local Backup: folder picker failed", error);
							new Notice("Could not open the folder picker. Type the path manually instead.");
						}
					})
			);

		// Inline warning shown under the description when the destination is invalid.
		this.warningEl = destinationSetting.descEl.createDiv();
		this.warningEl.style.color = "var(--text-error)";
		this.updateDestinationWarning();

		this.lastBackupSetting = new Setting(containerEl).setName("Last backup");
		this.renderLastBackup();
	}

	private updateDestinationWarning(): void {
		if (!this.warningEl) return;
		const problem = validateDestination(
			this.plugin.settings.destination,
			this.plugin.getVaultPath()
		);
		this.warningEl.setText(problem ? `⚠ ${problem}` : "");
		this.warningEl.style.display = problem ? "" : "none";
	}

	/** Refreshes the "Last backup" line; also called by the plugin after each backup. */
	renderLastBackup(): void {
		if (!this.lastBackupSetting) return;
		const { lastBackup, lastBackupName } = this.plugin.settings;
		this.lastBackupSetting.setDesc(
			lastBackup
				? `${new Date(lastBackup).toLocaleString()}${lastBackupName ? ` (${lastBackupName})` : ""}`
				: "No backup has been made yet."
		);
	}
}
