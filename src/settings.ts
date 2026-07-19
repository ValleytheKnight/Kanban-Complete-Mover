import { App, moment, PluginSettingTab, Setting } from 'obsidian';
import type KanbanCompleteMoverPlugin from './main';

export type TimeOption = 'none' | 'hour' | 'minutes' | 'seconds';

export interface KanbanCompleteMoverSettings {
	enabled: boolean;
	targetLaneName: string;
	dateStampEnabled: boolean;
	datePreset: string;
	timeOption: TimeOption;
	clock24: boolean;
	customFormat: string;
	excludedPaths: string[];
}

export const DEFAULT_SETTINGS: KanbanCompleteMoverSettings = {
	enabled: false,
	targetLaneName: 'Complete',
	dateStampEnabled: false,
	datePreset: 'YYYY-MM-DD',
	timeOption: 'none',
	clock24: false,
	customFormat: 'YYYY-MM-DD',
	excludedPaths: [],
};

const DATE_PRESETS = [
	'YYYY-MM-DD',
	'MM/DD/YYYY',
	'DD/MM/YYYY',
	'DD.MM.YYYY',
	'MMM D, YYYY',
	'D MMM YYYY',
	'dddd, MMMM D, YYYY',
];

const TIME_TOKENS: Record<'12' | '24', Record<Exclude<TimeOption, 'none'>, string>> = {
	'24': { hour: 'HH', minutes: 'HH:mm', seconds: 'HH:mm:ss' },
	'12': { hour: 'h A', minutes: 'h:mm A', seconds: 'h:mm:ss A' },
};

export function composeDateStampFormat(settings: KanbanCompleteMoverSettings): string {
	if (settings.datePreset === 'custom') {
		return settings.customFormat;
	}
	if (settings.timeOption === 'none') {
		return settings.datePreset;
	}
	const clock = settings.clock24 ? '24' : '12';
	return `${settings.datePreset} ${TIME_TOKENS[clock][settings.timeOption]}`;
}

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
			.setDesc('Append a stamp to a card when it moves to the complete lane.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.dateStampEnabled)
					.onChange(async (value) => {
						this.plugin.settings.dateStampEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.dateStampEnabled) {
			new Setting(containerEl)
				.setName('Date format')
				.setDesc('How the date part of the stamp is written.')
				.addDropdown((dropdown) => {
					for (const preset of DATE_PRESETS) {
						dropdown.addOption(preset, moment().format(preset));
					}
					dropdown.addOption('custom', 'Custom');
					dropdown
						.setValue(this.plugin.settings.datePreset)
						.onChange(async (value) => {
							this.plugin.settings.datePreset = value;
							await this.plugin.saveSettings();
							this.display();
						});
				});

			if (this.plugin.settings.datePreset === 'custom') {
				new Setting(containerEl)
					.setName('Custom format')
					.setDesc(
						'Moment format string. Include time tokens here if you want them, the time options below are skipped for custom formats.',
					)
					.addText((text) =>
						text
							.setValue(this.plugin.settings.customFormat)
							.onChange(async (value) => {
								this.plugin.settings.customFormat =
									value.trim() || DEFAULT_SETTINGS.customFormat;
								await this.plugin.saveSettings();
								this.updatePreview();
							}),
					);
			} else {
				new Setting(containerEl)
					.setName('Time stamp')
					.setDesc('How much of the time to include after the date.')
					.addDropdown((dropdown) =>
						dropdown
							.addOption('none', 'None')
							.addOption('hour', 'Hour')
							.addOption('minutes', 'Hour and minutes')
							.addOption('seconds', 'Hour, minutes, and seconds')
							.setValue(this.plugin.settings.timeOption)
							.onChange(async (value) => {
								this.plugin.settings.timeOption = value as TimeOption;
								await this.plugin.saveSettings();
								this.display();
							}),
					);

				if (this.plugin.settings.timeOption !== 'none') {
					new Setting(containerEl)
						.setName('Use 24-hour clock')
						.setDesc('Off means 12-hour time with am and pm.')
						.addToggle((toggle) =>
							toggle
								.setValue(this.plugin.settings.clock24)
								.onChange(async (value) => {
									this.plugin.settings.clock24 = value;
									await this.plugin.saveSettings();
									this.updatePreview();
								}),
						);
				}
			}

			new Setting(containerEl)
				.setName('Stamp preview')
				.setDesc(this.previewText())
				.setClass('kanban-complete-mover-preview');
		}

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

	private previewText(): string {
		return `✅ ${moment().format(composeDateStampFormat(this.plugin.settings))}`;
	}

	private updatePreview(): void {
		const preview = this.containerEl.querySelector(
			'.kanban-complete-mover-preview .setting-item-description',
		);
		if (preview) {
			preview.textContent = this.previewText();
		}
	}
}
