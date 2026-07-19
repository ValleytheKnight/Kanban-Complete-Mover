import { moment, normalizePath, Plugin, TFile } from 'obsidian';
import { checkedOutsideLane, moveCheckedCards } from './board';
import {
	composeDateStampFormat,
	DEFAULT_SETTINGS,
	KanbanCompleteMoverSettings,
	KanbanCompleteMoverSettingTab,
} from './settings';

const BOARD_FRONTMATTER_KEY = 'kanban-plugin';
const LANE_OVERRIDE_KEY = 'kanban-complete-lane';
const SCAN_DELAY_MS = 30;

export default class KanbanCompleteMoverPlugin extends Plugin {
	settings!: KanbanCompleteMoverSettings;

	private lastSeen = new Map<string, string>();
	private pendingScans = new Map<string, number>();
	private inFlight = new Set<string>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new KanbanCompleteMoverSettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile) {
					this.queueScan(file);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				const snapshot = this.lastSeen.get(oldPath);
				this.lastSeen.delete(oldPath);
				if (file instanceof TFile && snapshot !== undefined) {
					this.lastSeen.set(file.path, snapshot);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				this.lastSeen.delete(file.path);
			}),
		);
	}

	onunload() {
		for (const timer of this.pendingScans.values()) {
			window.clearTimeout(timer);
		}
		this.pendingScans.clear();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<KanbanCompleteMoverSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private isBoard(file: TFile): boolean {
		if (file.extension !== 'md') return false;
		const cache = this.app.metadataCache.getFileCache(file);
		return cache?.frontmatter?.[BOARD_FRONTMATTER_KEY] !== undefined;
	}

	private isExcluded(file: TFile): boolean {
		const path = normalizePath(file.path);
		return this.settings.excludedPaths.some(
			(excluded) => normalizePath(excluded) === path,
		);
	}

	private targetLaneFor(file: TFile): string {
		const cache = this.app.metadataCache.getFileCache(file);
		const override: unknown = cache?.frontmatter?.[LANE_OVERRIDE_KEY];
		if (typeof override === 'string' && override.trim().length > 0) {
			return override.trim();
		}
		return this.settings.targetLaneName;
	}

	private queueScan(file: TFile) {
		if (!this.settings.enabled) return;
		if (!this.isBoard(file) || this.isExcluded(file)) return;

		const existing = this.pendingScans.get(file.path);
		if (existing !== undefined) {
			window.clearTimeout(existing);
		}
		this.pendingScans.set(
			file.path,
			window.setTimeout(() => {
				this.pendingScans.delete(file.path);
				void this.processBoard(file);
			}, SCAN_DELAY_MS),
		);
	}

	private async processBoard(file: TFile) {
		if (this.inFlight.has(file.path)) {
			// Another scan is already writing this file; it will re-scan its
			// own result when that write lands, so this pass can skip.
			return;
		}

		const current = await this.app.vault.cachedRead(file);
		if (this.lastSeen.get(file.path) === current) {
			return;
		}

		const targetLane = this.targetLaneFor(file);
		const budget = checkedOutsideLane(current, targetLane);
		if (budget.size === 0) {
			this.lastSeen.set(file.path, current);
			return;
		}

		const dateStamp = this.settings.dateStampEnabled
			? `✅ ${moment().format(composeDateStampFormat(this.settings))}`
			: null;

		this.inFlight.add(file.path);
		try {
			const result = await this.app.vault.process(file, (data) => {
				const move = moveCheckedCards(data, budget, targetLane, dateStamp);
				return move.content;
			});
			this.lastSeen.set(file.path, result);
			this.refreshBoardViews(file);
		} finally {
			this.inFlight.delete(file.path);
		}

		// The write above triggers another modify event; that rescan is what
		// catches a checked card the Kanban view re-adds after this pass, so
		// nothing further is scheduled from here.
	}

	/**
	 * An open board view keeps its own in-memory copy, so force it to reload
	 * from disk after an external write instead of waiting for the user to
	 * close and reopen the file.
	 */
	private refreshBoardViews(file: TFile) {
		for (const leaf of this.app.workspace.getLeavesOfType('kanban')) {
			const view = leaf.view as { file?: TFile; load?: () => void };
			if (view.file?.path === file.path && typeof view.load === 'function') {
				view.load();
			}
		}
	}
}
