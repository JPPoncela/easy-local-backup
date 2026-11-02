import { FileSystemAdapter, Notice, Plugin } from "obsidian";
import { promises as fsp } from "fs";
import * as path from "path";
import {
	DEFAULT_SETTINGS,
	EasyLocalBackupSettings,
	EasyLocalBackupSettingTab,
	validateDestination,
} from "./settings";

const PARTIAL_SUFFIX = ".partial";

export default class EasyLocalBackupPlugin extends Plugin {
	settings!: EasyLocalBackupSettings;
	private settingTab!: EasyLocalBackupSettingTab;
	private running = false;
	private abortController: AbortController | null = null;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("archive", "Easy Local Backup: back up vault", () => {
			void this.runBackup();
		});

		this.addCommand({
			id: "backup-vault",
			name: "Back up vault now",
			callback: () => void this.runBackup(),
		});

		this.settingTab = new EasyLocalBackupSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
	}

	onunload() {
		// Stop a running backup; it removes its own .partial folder as it exits.
		this.abortController?.abort();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Absolute path of the vault folder, or null if the vault isn't on the local file system. */
	getVaultPath(): string | null {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
	}

	async runBackup(): Promise<void> {
		if (this.running) {
			new Notice("A backup is already running.");
			return;
		}

		const vaultPath = this.getVaultPath();
		if (!vaultPath) {
			new Notice("Easy Local Backup only works with a local, file-based vault.");
			return;
		}

		const destRoot = this.settings.destination.trim();
		if (!destRoot) {
			new Notice("Choose a backup destination in the Easy Local Backup settings first.");
			return;
		}
		const problem = validateDestination(destRoot, vaultPath);
		if (problem) {
			new Notice(problem);
			return;
		}

		const source = path.resolve(vaultPath);
		const destination = path.resolve(destRoot);

		this.running = true;
		const abort = new AbortController();
		this.abortController = abort;
		const signal = abort.signal;
		const progress = new Notice("Backing up vault…", 0);
		let partialPath: string | null = null;

		try {
			await fsp.mkdir(destination, { recursive: true });

			const prefix = `${sanitize(this.app.vault.getName())}-backup-`;
			await removeStalePartials(destination, prefix);

			// Abort early, with a clear message, if the destination can't hold the backup.
			const needed = await dirSize(source, signal);
			const free = await freeSpace(destination);
			if (free !== null && free < needed) {
				throw new Error(
					`Not enough free space at the destination: the vault needs ${formatBytes(needed)} ` +
						`but only ${formatBytes(free)} is free.`
				);
			}

			const finalPath = await uniquePath(destination, `${prefix}${timestamp()}`);
			partialPath = finalPath + PARTIAL_SUFFIX;

			// 1. Copy everything into the .partial folder.
			const skipped = await copyDir(source, partialPath, signal);

			// 2. Only now does the backup become visible under its real name.
			throwIfAborted(signal);
			await fsp.rename(partialPath, finalPath);
			partialPath = null;

			this.settings.lastBackup = Date.now();
			this.settings.lastBackupName = path.basename(finalPath);
			await this.saveSettings();
			this.settingTab.renderLastBackup();

			progress.hide();
			new Notice(
				`Backup complete: ${finalPath}` +
					(skipped > 0 ? ` (${skipped} symlink/special item(s) skipped)` : ""),
				8000
			);
		} catch (error) {
			progress.hide();
			if (signal.aborted) {
				new Notice("Backup cancelled.");
			} else {
				console.error("Easy Local Backup: backup failed", error);
				new Notice(
					`Backup failed: ${error instanceof Error ? error.message : String(error)}`,
					10000
				);
			}
			if (partialPath) {
				await fsp.rm(partialPath, { recursive: true, force: true }).catch(() => undefined);
			}
		} finally {
			this.running = false;
			this.abortController = null;
		}
	}
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new Error("Backup cancelled.");
}

/** Makes a vault name safe to use inside a folder name on any OS. */
function sanitize(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "vault";
}

/** Local time as YYYY-MM-DD_HHmmss (no colons, so it is valid on Windows too). */
function timestamp(): string {
	const d = new Date();
	const p = (n: number) => ("0" + n).slice(-2);
	return (
		`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
		`${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}

async function exists(p: string): Promise<boolean> {
	try {
		await fsp.access(p);
		return true;
	} catch {
		return false;
	}
}

/** Returns dir/base, or dir/base-2, dir/base-3… if that name is already taken. */
async function uniquePath(dir: string, base: string): Promise<string> {
	let candidate = path.join(dir, base);
	for (let i = 2; (await exists(candidate)) || (await exists(candidate + PARTIAL_SUFFIX)); i++) {
		candidate = path.join(dir, `${base}-${i}`);
	}
	return candidate;
}

/** Deletes leftovers from backups that were interrupted (crash, power loss…). */
async function removeStalePartials(dir: string, prefix: string): Promise<void> {
	const entries = await fsp.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory() && entry.name.startsWith(prefix) && entry.name.endsWith(PARTIAL_SUFFIX)) {
			await fsp.rm(path.join(dir, entry.name), { recursive: true, force: true });
		}
	}
}

/** Total size in bytes of all regular files under dir (symlinks are ignored, as in copyDir). */
async function dirSize(dir: string, signal: AbortSignal): Promise<number> {
	let total = 0;
	for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
		throwIfAborted(signal);
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			total += await dirSize(full, signal);
		} else if (entry.isFile()) {
			total += (await fsp.stat(full)).size;
		}
	}
	return total;
}

/**
 * Free bytes available to this user on the volume holding `dir`, or null if it
 * can't be determined (fs.statfs needs Node 18.15+). In that case the check is skipped.
 */
async function freeSpace(dir: string): Promise<number | null> {
	try {
		const statfs = (fsp as any).statfs;
		if (typeof statfs !== "function") return null;
		const stats = await statfs.call(fsp, dir);
		return Number(stats.bavail) * Number(stats.bsize);
	} catch {
		return null;
	}
}

function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Recursively copies src into dest, preserving modification times.
 * Stops (by throwing) as soon as the signal is aborted; a file already being
 * copied finishes first.
 * Returns the number of entries skipped (symlinks and other special files).
 */
async function copyDir(src: string, dest: string, signal: AbortSignal): Promise<number> {
	await fsp.mkdir(dest, { recursive: true });
	let skipped = 0;

	for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
		throwIfAborted(signal);
		const from = path.join(src, entry.name);
		const to = path.join(dest, entry.name);

		if (entry.isDirectory()) {
			skipped += await copyDir(from, to, signal);
		} else if (entry.isFile()) {
			await fsp.copyFile(from, to);
			const stat = await fsp.stat(from);
			await fsp.utimes(to, stat.atime, stat.mtime);
		} else {
			skipped++;
		}
	}
	return skipped;
}
