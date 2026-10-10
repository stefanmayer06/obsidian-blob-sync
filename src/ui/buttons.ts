import { requireApiVersion, type ButtonComponent } from "obsidian";

/** Styles a button as destructive on every supported Obsidian version. */
export function makeDestructive(button: ButtonComponent): ButtonComponent {
	if (requireApiVersion("1.13.0")) return button.setDestructive();
	button.buttonEl.addClass("mod-warning");
	return button;
}
