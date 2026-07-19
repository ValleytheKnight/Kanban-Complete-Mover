export interface BoardCard {
	/** Card text with the checkbox marker stripped, continuation lines included. */
	key: string;
	checked: boolean;
	laneTitle: string;
	startLine: number;
	lineCount: number;
}

export interface ParsedBoard {
	cards: BoardCard[];
	laneTitles: string[];
	/** Line index of the Archive heading, or -1. Lanes past this point are never touched. */
	archiveLine: number;
	/** Line index of the kanban settings block, or -1. */
	settingsLine: number;
}

const LANE_HEADING = /^## (.+)$/;
const CARD_FIRST_LINE = /^- \[( |x|X|\/|-|>)\] ?(.*)$/;
const CONTINUATION = /^(?: {2}|\t)/;

function isSettingsLine(line: string): boolean {
	return line.startsWith('%% kanban:settings');
}

function isArchiveHeading(title: string): boolean {
	return title.trim().toLowerCase() === 'archive';
}

export function parseBoard(content: string): ParsedBoard {
	const lines = content.split('\n');
	const cards: BoardCard[] = [];
	const laneTitles: string[] = [];
	let archiveLine = -1;
	let settingsLine = -1;
	let currentLane: string | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';

		if (isSettingsLine(line)) {
			settingsLine = i;
			break;
		}

		const heading = line.match(LANE_HEADING);
		if (heading) {
			const title = heading[1] ?? '';
			if (isArchiveHeading(title)) {
				archiveLine = i;
				break;
			}
			currentLane = title.trim();
			laneTitles.push(currentLane);
			continue;
		}

		if (currentLane === null) {
			continue;
		}

		const cardStart = line.match(CARD_FIRST_LINE);
		if (!cardStart) {
			continue;
		}

		let lineCount = 1;
		const bodyParts = [cardStart[2] ?? ''];
		while (i + lineCount < lines.length) {
			const next = lines[i + lineCount] ?? '';
			if (
				CONTINUATION.test(next) &&
				!next.match(CARD_FIRST_LINE) &&
				!next.match(LANE_HEADING)
			) {
				bodyParts.push(next);
				lineCount++;
			} else {
				break;
			}
		}

		cards.push({
			key: bodyParts.join('\n'),
			checked: cardStart[1] === 'x' || cardStart[1] === 'X',
			laneTitle: currentLane,
			startLine: i,
			lineCount,
		});
		i += lineCount - 1;
	}

	return { cards, laneTitles, archiveLine, settingsLine };
}

/**
 * Card keys whose checked-instance count rose between the two snapshots.
 * Count-based so that duplicate card texts move one instance per new check
 * instead of every copy.
 */
export function newlyCheckedKeys(before: string, after: string): Map<string, number> {
	const countChecked = (content: string): Map<string, number> => {
		const counts = new Map<string, number>();
		for (const card of parseBoard(content).cards) {
			if (card.checked) {
				counts.set(card.key, (counts.get(card.key) ?? 0) + 1);
			}
		}
		return counts;
	};

	const beforeCounts = countChecked(before);
	const result = new Map<string, number>();
	for (const [key, afterCount] of countChecked(after)) {
		const delta = afterCount - (beforeCounts.get(key) ?? 0);
		if (delta > 0) {
			result.set(key, delta);
		}
	}
	return result;
}

export interface MoveResult {
	content: string;
	movedCount: number;
}

/**
 * Move checked cards named in moveBudget into the target lane, creating the
 * lane when missing. Returns the original content untouched when there is
 * nothing to do.
 */
export function moveCheckedCards(
	content: string,
	moveBudget: Map<string, number>,
	targetLane: string,
	dateStamp: string | null,
): MoveResult {
	const board = parseBoard(content);
	const lines = content.split('\n');
	const targetLower = targetLane.trim().toLowerCase();
	const budget = new Map(moveBudget);

	const toMove: BoardCard[] = [];
	for (const card of board.cards) {
		if (!card.checked) continue;
		if (card.laneTitle.toLowerCase() === targetLower) continue;
		const remaining = budget.get(card.key) ?? 0;
		if (remaining <= 0) continue;
		budget.set(card.key, remaining - 1);
		toMove.push(card);
	}

	if (toMove.length === 0) {
		return { content, movedCount: 0 };
	}

	const movedBlocks: string[][] = [];
	for (const card of toMove) {
		const block = lines.slice(card.startLine, card.startLine + card.lineCount);
		if (dateStamp) {
			block[0] = `${block[0]} ${dateStamp}`;
		}
		movedBlocks.push(block);
	}

	for (const card of [...toMove].sort((a, b) => b.startLine - a.startLine)) {
		lines.splice(card.startLine, card.lineCount);
	}

	let laneLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (isSettingsLine(line)) break;
		const heading = line.match(LANE_HEADING);
		const title = heading?.[1] ?? '';
		if (heading && isArchiveHeading(title)) break;
		if (heading && title.trim().toLowerCase() === targetLower) {
			laneLine = i;
			break;
		}
	}

	if (laneLine === -1) {
		let createAt = lines.length;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? '';
			const heading = line.match(LANE_HEADING);
			const title = heading?.[1] ?? '';
			if (isSettingsLine(line) || (heading && isArchiveHeading(title))) {
				createAt = i;
				break;
			}
		}
		const laneBlock = [`## ${targetLane.trim()}`, ''];
		lines.splice(createAt, 0, ...laneBlock);
		laneLine = createAt;
	}

	let insertAt = lines.length;
	for (let i = laneLine + 1; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (line.match(LANE_HEADING) || isSettingsLine(line)) {
			insertAt = i;
			break;
		}
	}
	while (insertAt > laneLine + 1 && (lines[insertAt - 1] ?? '').trim() === '') {
		insertAt--;
	}

	const inserted: string[] = [];
	for (const block of movedBlocks) {
		inserted.push(...block);
	}
	lines.splice(insertAt, 0, ...inserted);

	return { content: lines.join('\n'), movedCount: toMove.length };
}
