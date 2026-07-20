import { moment, normalizePath, Notice, Plugin, TFile } from 'obsidian';
import {
	checkedOutsideLane,
	moveCheckedCards,
	restoreUncheckedCards,
	uncheckDraggedOutCards,
} from './board';
import {
	composeDateStampFormat,
	DEFAULT_SETTINGS,
	KanbanCompleteMoverSettings,
	KanbanCompleteMoverSettingTab,
} from './settings';

const BOARD_FRONTMATTER_KEY = 'kanban-plugin';
const LANE_OVERRIDE_KEY = 'kanban-complete-lane';

// A same-tick delay, not a deliberate wait: coalesces multiple modify
// events that land for one edit without adding any perceived lag.
const SCAN_DELAY_MS = 0;

interface ProcessResult {
	moved: number;
	restored: number;
	unchecked: number;
}

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

		this.addCommand({
			id: 'scan-vault-now',
			name: 'Scan vault now',
			callback: () => {
				void this.scanVault().then(({ files, moved, restored, unchecked }) => {
					new Notice(
						`Kanban Complete Mover: checked ${files} board file(s). Moved ${moved}, restored ${restored}, unchecked ${unchecked}.`,
					);
				});
			},
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

	/**
	 * Run a full-vault sweep on demand, independent of the automatic
	 * watch-and-move toggle. This is the deliberate, explicit path a user
	 * takes to adopt the plugin on an existing vault, instead of the effect
	 * leaking out board by board on whatever unrelated edit touches each
	 * file next.
	 */
	private async scanVault(): Promise<{
		files: number;
		moved: number;
		restored: number;
		unchecked: number;
	}> {
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((file) => this.isBoard(file) && !this.isExcluded(file));

		let totalMoved = 0;
		let totalRestored = 0;
		let totalUnchecked = 0;
		for (const file of files) {
			const result = await this.processBoard(file);
			totalMoved += result?.moved ?? 0;
			totalRestored += result?.restored ?? 0;
			totalUnchecked += result?.unchecked ?? 0;
		}
		return {
			files: files.length,
			moved: totalMoved,
			restored: totalRestored,
			unchecked: totalUnchecked,
		};
	}

	private async processBoard(file: TFile): Promise<ProcessResult | null> {
		if (this.inFlight.has(file.path)) {
			// Another scan is already writing this file; it will re-scan its
			// own result when that write lands, so this pass can skip.
			return null;
		}

		const current = await this.app.vault.cachedRead(file);
		if (this.lastSeen.get(file.path) === current) {
			return { moved: 0, restored: 0, unchecked: 0 };
		}

		const targetLane = this.targetLaneFor(file);
		const dateStamp = this.settings.dateStampEnabled
			? `✅ ${moment().format(composeDateStampFormat(this.settings))}`
			: null;
		const restoreEnabled = this.settings.restoreOnUncheck;

		let moved = 0;
		let restored = 0;
		let unchecked = 0;

		this.inFlight.add(file.path);
		try {
			const result = await this.app.vault.process(file, (data) => {
				let working = data;

				// A card carrying our marker but sitting outside the target
				// lane while still checked was dragged out manually. Handle
				// that before the fresh-check scan below, since a marked card
				// is deliberately excluded from that scan and must not be
				// left checked in its new lane.
				const draggedOut = uncheckDraggedOutCards(working, targetLane);
				working = draggedOut.content;
				unchecked = draggedOut.uncheckedCount;

				const moveBudget = checkedOutsideLane(working, targetLane);
				if (moveBudget.size > 0) {
					const move = moveCheckedCards(working, moveBudget, targetLane, dateStamp);
					working = move.content;
					moved = move.movedCount;
				}

				if (restoreEnabled) {
					const restore = restoreUncheckedCards(working, targetLane);
					working = restore.content;
					restored = restore.restoredCount;
				}

				return working;
			});
			this.lastSeen.set(file.path, result);
			if (moved > 0 || restored > 0 || unchecked > 0) {
				this.refreshBoardViews(file);
			}
		} finally {
			this.inFlight.delete(file.path);
		}

		return { moved, restored, unchecked };
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
