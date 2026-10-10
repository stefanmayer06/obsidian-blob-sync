// Lints the plugin with Obsidian's official rules (the same family of checks the
// Community directory review runs). Run with `npm run lint`.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

export default defineConfig([
	// Tests and the build script run in Node, not in Obsidian.
	{ ignores: ["main.js", "node_modules/", "test/", "esbuild.config.mjs"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.mjs"] },
			},
		},
		rules: {
			// Product names and abbreviations the plugin's UI has to use as written.
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					brands: [...DEFAULT_BRANDS, "Azure", "Azurite"],
					acronyms: [...DEFAULT_ACRONYMS, "SAS"],
				},
			],
		},
	},
]);
