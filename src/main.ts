import { moment, normalizePath, Plugin, TFile } from 'obsidian';
import { moveCheckedCards, newlyCheckedKeys } from './board';
import {
	DEFAULT_SETTINGS,
	KanbanCompleteMoverSettings,
	KanbanCompleteMoverSettingTab,
} from './settings';

const BOARD_FRONTMATTER_KEY = 'kanban-plugin';
const LANE_OVERRIDE_KEY = 'kanban-complete-lane';
const DEBOUNCE_MS = 250;
const SELF_WRITE_CLEAR_MS = 500;

export default class KanbanCompleteMoverPlugin extends Plugin {
	settings!: KanbanCompleteMoverSettings;

	private snapshots = new Map<string, string>();
	private pendingScans = new Map<string, number>();
	private selfWrites = new Set<string>();

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
				if (file instanceof TFile) {
					const snapshot = this.snapshots.get(oldPath);
					this.snapshots.delete(oldPath);
					if (snapshot !== undefined) {
						this.snapshots.set(file.path, snapshot);
					}
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				this.snapshots.delete(file.path);
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			void this.warmSnapshots();
		});
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

	private async warmSnapshots() {
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.isBoard(file)) {
				this.snapshots.set(file.path, await this.app.vault.cachedRead(file));
			}
		}
	}

	private queueScan(file: TFile) {
		if (!this.settings.enabled) return;
		if (this.selfWrites.has(file.path)) return;
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
			}, DEBOUNCE_MS),
		);
	}

	private async processBoard(file: TFile) {
		const current = await this.app.vault.cachedRead(file);
		const previous = this.snapshots.get(file.path);

		if (previous === undefined || previous === current) {
			this.snapshots.set(file.path, current);
			return;
		}

		const moveBudget = newlyCheckedKeys(previous, current);
		if (moveBudget.size === 0) {
			this.snapshots.set(file.path, current);
			return;
		}

		const targetLane = this.targetLaneFor(file);
		const dateStamp = this.settings.dateStampEnabled
			? `✅ ${moment().format(this.settings.dateFormat)}`
			: null;

		this.selfWrites.add(file.path);
		try {
			const result = await this.app.vault.process(file, (data) => {
				const move = moveCheckedCards(data, moveBudget, targetLane, dateStamp);
				return move.content;
			});
			this.snapshots.set(file.path, result);
			this.refreshBoardViews(file);
		} finally {
			window.setTimeout(() => {
				this.selfWrites.delete(file.path);
			}, SELF_WRITE_CLEAR_MS);
		}
	}

	/**
	 * An open board view keeps its own in-memory copy and its next internal
	 * save would overwrite an external edit, so force it to reload from disk.
	 */
	private refreshBoardViews(file: TFile) {
		for (const leaf of this.app.workspace.getLeavesOfType('kanban')) {
			const view = leaf.view as { file?: TFile; load?: () => void };
			if (view.file?.path === file.path && typeof view.load === 'function') {
				window.setTimeout(() => view.load?.(), 100);
			}
		}
	}
}
