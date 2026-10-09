import { App, Modal, Notice, Setting } from "obsidian";

export type DeletionDecision = "delete" | "keep" | "dismiss";

/** Asks before applying a large number of deletions. */
export class ConfirmDeletionModal extends Modal {
	private decided = false;

	constructor(
		app: App,
		private readonly local: string[],
		private readonly remote: string[],
		private readonly onDecision: (decision: DeletionDecision) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Azure Blob Sync: confirm deletions");
		const parts: string[] = [];
		if (this.local.length) parts.push(`${this.local.length} file(s) from this device (moved to trash)`);
		if (this.remote.length) parts.push(`${this.remote.length} file(s) from Azure`);
		contentEl.createEl("p", {
			text:
				`This sync would delete ${parts.join(" and ")}. That is a large part of your vault, so it was ` +
				`held back as a safety measure. Delete them only if this is what you expect (for example, you ` +
				`deleted a folder on another device). "Keep files" restores them where they are missing instead. ` +
				`If you close this dialog, the deletions stay on hold until you decide.`,
		});
		const list = contentEl.createEl("ul", { cls: "azure-blob-sync-list" });
		const shown = [
			...this.local.map((p) => `This device: ${p}`),
			...this.remote.map((p) => `Azure: ${p}`),
		];
		for (const line of shown.slice(0, 15)) list.createEl("li", { text: line });
		if (shown.length > 15) list.createEl("li", { text: `… and ${shown.length - 15} more` });

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Keep files").onClick(() => {
					this.decide("keep");
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Delete files")
					.setWarning()
					.onClick(() => {
						this.decide("delete");
					}),
			);
	}

	private decide(decision: DeletionDecision): void {
		this.decided = true;
		this.close();
		this.onDecision(decision);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.decided) this.onDecision("dismiss");
	}
}

/** Shows the recent sync log. */
export class LogModal extends Modal {
	constructor(
		app: App,
		private readonly lines: string[],
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Azure Blob Sync log");
		const text = this.lines.length ? this.lines.join("\n") : "Nothing logged yet.";
		contentEl.createEl("pre", { text, cls: "azure-blob-sync-log" });
		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Copy to clipboard").onClick(async () => {
				await navigator.clipboard.writeText(text);
				new Notice("Log copied");
			}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
