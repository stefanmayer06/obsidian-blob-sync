/**
 * Decides which vault paths take part in syncing.
 *
 * Pattern syntax (one per line, "#" starts a comment):
 *   *.tmp          - no slash: matches a file or folder name at any depth
 *   Private/       - trailing slash: a folder (and everything in it) at any depth
 *   /Archive       - leading slash: anchored at the vault root
 *   Daily/2023/**  - globs with "/" are matched against the full path from the root
 *   *  any characters except "/",  **  anything (including "/"),  ?  one character
 */

export interface PathFilterOptions {
	/** The vault's config folder, usually ".obsidian". */
	configDir: string;
	/** This plugin's folder; never synced (holds device specific state and the SAS token). */
	pluginDir: string;
	/** Also sync the config folder (themes, plugins, settings). */
	syncConfigDir: boolean;
	ignorePatterns: string[];
}

function escapeRegExp(s: string): string {
	return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globBody(glob: string): string {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				if (glob[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else {
			out += escapeRegExp(c);
		}
	}
	return out;
}

export function globToRegExp(pattern: string): RegExp | null {
	let p = pattern.trim().replace(/\\/g, "/");
	if (!p || p.startsWith("#")) return null;
	const anchored = p.startsWith("/");
	if (anchored) p = p.replace(/^\/+/, "");
	p = p.replace(/\/+$/, "");
	if (!p) return null;
	const body = globBody(p);
	if (!anchored && !p.includes("/")) {
		return new RegExp(`(?:^|/)${body}(?:/|$)`);
	}
	return new RegExp(`^${body}(?:/|$)`);
}

export function parsePatterns(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
}

export function createPathFilter(options: PathFilterOptions): (path: string) => boolean {
	const configDir = options.configDir.replace(/\/+$/, "");
	const pluginDir = options.pluginDir.replace(/\/+$/, "");
	const alwaysExcluded = [
		`${configDir}/workspace.json`,
		`${configDir}/workspace-mobile.json`,
		`${configDir}/workspace`,
	];
	const userPatterns = options.ignorePatterns
		.map((p) => globToRegExp(p))
		.filter((r): r is RegExp => r !== null);

	return (path: string): boolean => {
		if (!path || path.startsWith("/") || path.split("/").some((s) => s === "" || s === "..")) {
			return false;
		}
		if (path === pluginDir || path.startsWith(pluginDir + "/")) return false;
		if (alwaysExcluded.includes(path)) return false;

		const inConfigDir = path.startsWith(configDir + "/");
		if (inConfigDir) {
			if (!options.syncConfigDir) return false;
			// Hidden entries inside the config folder (e.g. .git, .DS_Store) stay excluded.
			const rest = path.slice(configDir.length + 1);
			if (rest.split("/").some((s) => s.startsWith("."))) return false;
		} else if (path.split("/").some((s) => s.startsWith("."))) {
			// Hidden files/folders (.trash, .git, .DS_Store, ...) aren't part of the vault.
			return false;
		}

		for (const re of userPatterns) {
			if (re.test(path)) return false;
		}
		return true;
	};
}
