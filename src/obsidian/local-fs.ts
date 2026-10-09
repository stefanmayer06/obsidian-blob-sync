import { TFile, TFolder, normalizePath, type App } from "obsidian";
import type { LocalFileInfo, LocalFileSystem } from "../sync/types";

/**
 * LocalFileSystem implementation on top of the Obsidian vault API.
 * Regular notes/attachments go through the Vault (so Obsidian's index and
 * open editors stay in sync); files in the config folder use the adapter.
 */
export class ObsidianLocalFs implements LocalFileSystem {
	constructor(
		private readonly app: App,
		private readonly options: {
			includeConfigDir: () => boolean;
			/** Folders that are never walked (e.g. this plugin's own folder). */
			skipFolder: (path: string) => boolean;
		},
	) {}

	private get configDir(): string {
		return this.app.vault.configDir;
	}

	private isConfigPath(path: string): boolean {
		return path === this.configDir || path.startsWith(this.configDir + "/");
	}

	async listFiles(): Promise<LocalFileInfo[]> {
		const files: LocalFileInfo[] = this.app.vault
			.getFiles()
			.map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
		if (this.options.includeConfigDir()) {
			await this.walk(this.configDir, files);
		}
		return files;
	}

	private async walk(folder: string, out: LocalFileInfo[]): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (this.options.skipFolder(folder)) return;
		let listed;
		try {
			listed = await adapter.list(folder);
		} catch {
			return;
		}
		for (const file of listed.files) {
			const stat = await adapter.stat(file);
			if (stat && stat.type === "file") out.push({ path: file, mtime: stat.mtime, size: stat.size });
		}
		for (const sub of listed.folders) {
			const name = sub.slice(sub.lastIndexOf("/") + 1);
			if (name.startsWith(".")) continue;
			await this.walk(sub, out);
		}
	}

	async stat(path: string): Promise<LocalFileInfo | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			return { path, mtime: file.stat.mtime, size: file.stat.size };
		}
		if (file instanceof TFolder) return null;
		const stat = await this.app.vault.adapter.stat(path);
		if (!stat || stat.type !== "file") return null;
		return { path, mtime: stat.mtime, size: stat.size };
	}

	async read(path: string): Promise<ArrayBuffer> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) return this.app.vault.readBinary(file);
		return this.app.vault.adapter.readBinary(path);
	}

	async write(path: string, data: ArrayBuffer, mtime: number): Promise<void> {
		const options = mtime > 0 ? { mtime } : undefined;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, data, options);
			return;
		}
		if (existing instanceof TFolder) {
			throw new Error(`Cannot write "${path}": a folder with that name exists.`);
		}
		await this.ensureParentFolder(path);
		if (this.isConfigPath(path)) {
			await this.app.vault.adapter.writeBinary(path, data, options);
			return;
		}
		try {
			await this.app.vault.createBinary(path, data, options);
		} catch (e) {
			// The file exists on disk but isn't indexed yet.
			if (await this.app.vault.adapter.exists(path)) {
				await this.app.vault.adapter.writeBinary(path, data, options);
			} else {
				throw e;
			}
		}
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash <= 0) return;
		const folder = path.slice(0, slash);
		if (this.isConfigPath(folder)) {
			if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.adapter.mkdir(folder);
			return;
		}
		if (this.app.vault.getAbstractFileByPath(folder) instanceof TFolder) return;
		try {
			await this.app.vault.createFolder(folder);
		} catch {
			// Created concurrently or exists on disk already.
			if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.adapter.mkdir(folder);
		}
	}

	async delete(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			// Respects the user's "Deleted files" preference (system trash / .trash / permanent).
			await this.app.fileManager.trashFile(file);
		} else if (await this.app.vault.adapter.exists(path)) {
			await this.app.vault.adapter.remove(path);
		}
		if (!this.isConfigPath(path)) await this.removeEmptyParents(path);
	}

	/**
	 * Removes folders left empty by a remote deletion. Emptiness is checked on
	 * disk; the folder is trashed like Obsidian does it, so nothing is lost even
	 * if a file appeared at the same moment.
	 */
	private async removeEmptyParents(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		let slash = path.lastIndexOf("/");
		while (slash > 0) {
			const folderPath = normalizePath(path.slice(0, slash));
			try {
				const listed = await adapter.list(folderPath);
				if (listed.files.length > 0 || listed.folders.length > 0) return;
				const folder = this.app.vault.getAbstractFileByPath(folderPath);
				if (folder instanceof TFolder) {
					if (folder.isRoot()) return;
					await this.app.fileManager.trashFile(folder);
				} else {
					await adapter.rmdir(folderPath, false);
				}
			} catch {
				return;
			}
			slash = folderPath.lastIndexOf("/");
		}
	}
}
