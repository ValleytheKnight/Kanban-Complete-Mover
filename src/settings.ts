import { App, PluginSettingTab, Setting } from 'obsidian';
import type KanbanCompleteMoverPlugin from './main';

export interface KanbanCompleteMoverSettings {
	enabled: boolean;
	targetLaneName: string;
	dateStampEnabled: boolean;
	dateFormat: string;
	excludedPaths: string[];
}

export const DEFAULT_SETTINGS: KanbanCompleteMoverSettings = {
	enabled: false,
	targetLaneName: 'Complete',
	dateStampEnabled: false,
	dateFormat: 'YYYY-MM-DD',
	excludedPaths: [],
};

export class KanbanCompleteMoverSettingTab extends PluginSettingTab {
	plugin: KanbanCompleteMoverPlugin;

	constructor(app: App, plugin: KanbanCompleteMoverPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Enable automatic move')
			.setDesc(
				'Move a card to the complete lane when its checkbox is checked. Off by default so nothing changes until you opt in.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enabled)
					.onChange(async (value) => {
						this.plugin.settings.enabled = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Complete lane name')
			.setDesc(
				'Lane that checked cards move to. A board can override this with a kanban-complete-lane frontmatter key. The lane is created at the bottom of the board when missing.',
			)
			.addText((text) =>
				text
					.setPlaceholder('Complete')
					.setValue(this.plugin.settings.targetLaneName)
					.onChange(async (value) => {
						this.plugin.settings.targetLaneName =
							value.trim() || DEFAULT_SETTINGS.targetLaneName;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Add completion date')
			.setDesc('Append the date to a card when it moves to the complete lane.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.dateStampEnabled)
					.onChange(async (value) => {
						this.plugin.settings.dateStampEnabled = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Date format')
			.setDesc('Moment format string for the completion date.')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.dateFormat)
					.onChange(async (value) => {
						this.plugin.settings.dateFormat =
							value.trim() || DEFAULT_SETTINGS.dateFormat;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Excluded boards')
			.setDesc('Vault paths of boards this plugin should never touch, one per line.')
			.addTextArea((text) =>
				text
					.setPlaceholder('Projects/Some Board.md')
					.setValue(this.plugin.settings.excludedPaths.join('\n'))
					.onChange(async (value) => {
						this.plugin.settings.excludedPaths = value
							.split('\n')
							.map((line) => line.trim())
							.filter((line) => line.length > 0);
						await this.plugin.saveSettings();
					}),
			);
	}
}
