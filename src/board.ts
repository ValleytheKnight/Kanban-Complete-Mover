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

// The m flag is load-bearing: a multi-line card's key joins its lines with
// \n, and the marker always sits at the end of line 1, not the end of the
// whole key. Without m, $ only matches the end of the entire string, so a
// multi-line card's marker was invisible to every function here.
const ORIGIN_MARKER = /\s*<!--kcm-from:([^|]*)\|([^>]*)-->\s*$/m;

// Matches an optional stamp (always starts with the checkmark this plugin
// prefixes every stamp with) immediately followed by the marker, so both
// get removed together. The stamp's own format is user-configurable and
// unbounded, which is why this can't match the stamp on its own. It only
// strips a stamp when it directly precedes our marker.
const STAMP_AND_MARKER = /(?:\s*✅[^\n<]*)?\s*<!--kcm-from:[^|]*\|[^>]*-->\s*$/m;

function encodeOriginalLine(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decodeOriginalLine(encoded: string): string {
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

function uncheckLine(line: string): string {
	return line.replace(/^(\s*- )\[[^\]]*\]/, '$1[ ]');
}

/**
 * Recover the pristine pre-move line from a card's own marker instead of
 * regex-stripping the stamp and marker off the current line. Stripping by
 * pattern assumed this plugin's own "checkmark + date" stamp was the only
 * thing that could ever precede the marker, which broke the moment a card
 * already carried its own unrelated checkmark text, for example the Tasks
 * plugin's own done-date marker, also a checkmark emoji followed by a
 * date. Decoding the marker's own recorded original sidesteps the ambiguity
 * entirely: it's the literal line as it stood the moment this plugin first
 * moved the card, stamp and marker never included, whatever else the card
 * carried already, kept. Returns null if the marker can't be decoded, so
 * the caller can fall back rather than corrupt the line.
 */
function recoverOriginalLine(line: string): string | null {
	const match = line.match(ORIGIN_MARKER);
	if (!match) return null;
	const encoded = match[2] ?? '';
	try {
		return decodeOriginalLine(encoded);
	} catch {
		return null;
	}
}

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
 * Every checked card currently sitting outside the target lane that has
 * never been through the complete lane before (no origin marker), counted
 * by key so duplicate card texts each get their own move. A card that does
 * carry the marker was dragged out manually after already being moved once;
 * see uncheckDraggedOutCards for that case, handled separately so a manual
 * drag isn't fought by bouncing the card straight back.
 *
 * Reading this fresh from the current file, instead of diffing against a
 * remembered snapshot, makes the plugin self-healing: if the Kanban view's
 * own save overwrites a move in flight, the next modify event sees the same
 * misplaced card and moves it again, instead of depending on a precisely
 * timed diff.
 */
export function checkedOutsideLane(content: string, targetLane: string): Map<string, number> {
	const targetLower = targetLane.trim().toLowerCase();
	const counts = new Map<string, number>();
	for (const card of parseBoard(content).cards) {
		if (
			card.checked &&
			card.laneTitle.toLowerCase() !== targetLower &&
			!ORIGIN_MARKER.test(card.key)
		) {
			counts.set(card.key, (counts.get(card.key) ?? 0) + 1);
		}
	}
	return counts;
}

export interface UncheckResult {
	content: string;
	uncheckedCount: number;
}

/**
 * A card carrying the origin marker (meaning it was previously moved into
 * the complete lane by this plugin) that is now checked but sitting outside
 * that lane was dragged there manually, not freshly checked. It gets
 * unchecked and stripped of both its stamp and its marker right where it
 * is, instead of being bounced back to the complete lane or sent to its
 * recorded origin lane either. A manual drag is a deliberate placement; the
 * checkbox should follow it, not fight it, and a card that's no longer
 * complete shouldn't keep a completion stamp.
 */
export function uncheckDraggedOutCards(content: string, targetLane: string): UncheckResult {
	const targetLower = targetLane.trim().toLowerCase();
	const board = parseBoard(content);
	const candidates = board.cards.filter(
		(card) =>
			card.checked &&
			card.laneTitle.toLowerCase() !== targetLower &&
			ORIGIN_MARKER.test(card.key),
	);
	if (candidates.length === 0) {
		return { content, uncheckedCount: 0 };
	}

	const lines = content.split('\n');
	for (const card of candidates) {
		const currentLine = lines[card.startLine] ?? '';
		const recovered = recoverOriginalLine(currentLine);
		lines[card.startLine] = uncheckLine(recovered ?? currentLine.replace(STAMP_AND_MARKER, ''));
	}
	return { content: lines.join('\n'), uncheckedCount: candidates.length };
}

/**
 * A card that is unchecked, carries a marker, and sits outside the target
 * lane has no move to make (it's already wherever it belongs) but still has
 * leftover stamp and marker text to clean up. This covers a card dragged
 * out by hand after already being unchecked, a case none of the other
 * functions here are watching for since they all key off either being
 * checked or being inside the target lane.
 */
export function cleanStaleMarkers(content: string, targetLane: string): UncheckResult {
	const targetLower = targetLane.trim().toLowerCase();
	const board = parseBoard(content);
	const candidates = board.cards.filter(
		(card) =>
			!card.checked &&
			card.laneTitle.toLowerCase() !== targetLower &&
			ORIGIN_MARKER.test(card.key),
	);
	if (candidates.length === 0) {
		return { content, uncheckedCount: 0 };
	}

	const lines = content.split('\n');
	for (const card of candidates) {
		const currentLine = lines[card.startLine] ?? '';
		const recovered = recoverOriginalLine(currentLine);
		lines[card.startLine] = uncheckLine(recovered ?? currentLine.replace(STAMP_AND_MARKER, ''));
	}
	return { content: lines.join('\n'), uncheckedCount: candidates.length };
}

/**
 * A card that is unchecked, carries a marker, and sits inside the target
 * lane would normally be handled by restoreUncheckedCards, but that only
 * runs when the restore-on-uncheck setting is on. With it off, a card
 * unchecked in place while still sitting in the complete lane had no
 * handler at all: checkedOutsideLane and uncheckDraggedOutCards both key
 * off being outside the lane, restoreUncheckedCards keys off the setting,
 * and cleanStaleMarkers above deliberately excludes cards still inside the
 * lane since restoreUncheckedCards owns that case. This strips the stale
 * stamp and marker in place, with no move, so the card doesn't keep
 * showing a completion stamp it no longer earns just because the setting
 * that would relocate it happens to be off.
 */
export function stripStampInLane(content: string, targetLane: string): UncheckResult {
	const targetLower = targetLane.trim().toLowerCase();
	const board = parseBoard(content);
	const candidates = board.cards.filter(
		(card) =>
			!card.checked &&
			card.laneTitle.toLowerCase() === targetLower &&
			ORIGIN_MARKER.test(card.key),
	);
	if (candidates.length === 0) {
		return { content, uncheckedCount: 0 };
	}

	const lines = content.split('\n');
	for (const card of candidates) {
		const currentLine = lines[card.startLine] ?? '';
		const recovered = recoverOriginalLine(currentLine);
		lines[card.startLine] = uncheckLine(recovered ?? currentLine.replace(STAMP_AND_MARKER, ''));
	}
	return { content: lines.join('\n'), uncheckedCount: candidates.length };
}

function findLaneLine(lines: string[], laneNameLower: string): number {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (isSettingsLine(line)) break;
		const heading = line.match(LANE_HEADING);
		const title = heading?.[1] ?? '';
		if (heading && isArchiveHeading(title)) break;
		if (heading && title.trim().toLowerCase() === laneNameLower) {
			return i;
		}
	}
	return -1;
}

function createLane(lines: string[], laneName: string): number {
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
	lines.splice(createAt, 0, `## ${laneName.trim()}`, '');
	return createAt;
}

function laneInsertPoint(lines: string[], laneLine: number): number {
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
	return insertAt;
}

export interface MoveResult {
	content: string;
	movedCount: number;
}

/**
 * Move checked cards named in moveBudget into the target lane, creating the
 * lane when missing. Returns the original content untouched when there is
 * nothing to do. Every moved card's original lane and raw text are always
 * recorded in a hidden comment, both so restoreUncheckedCards can send it
 * back if it's later unchecked while still in the target lane (when that
 * setting is on), and so uncheckDraggedOutCards can recognize it if it's
 * dragged out manually while still checked (unconditional, not tied to any
 * setting, since a manual drag should never be fought either way).
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
		// Strip any marker this card already carries before treating it as
		// the pristine original to encode. A card reaching this path should
		// never already have one (checkedOutsideLane excludes marked cards),
		// but stripping defensively here means a marker can never layer on
		// top of itself even if that assumption is ever wrong.
		const originalRawLine = (block[0] ?? '').replace(STAMP_AND_MARKER, '');
		let firstLine = originalRawLine;
		if (dateStamp) {
			firstLine = `${firstLine} ${dateStamp}`;
		}
		const encoded = encodeOriginalLine(originalRawLine);
		firstLine = `${firstLine} <!--kcm-from:${card.laneTitle}|${encoded}-->`;
		block[0] = firstLine;
		movedBlocks.push(block);
	}

	for (const card of [...toMove].sort((a, b) => b.startLine - a.startLine)) {
		lines.splice(card.startLine, card.lineCount);
	}

	let laneLine = findLaneLine(lines, targetLower);
	if (laneLine === -1) {
		laneLine = createLane(lines, targetLane);
	}

	const insertAt = laneInsertPoint(lines, laneLine);
	const inserted: string[] = [];
	for (const block of movedBlocks) {
		inserted.push(...block);
	}
	lines.splice(insertAt, 0, ...inserted);

	return { content: lines.join('\n'), movedCount: toMove.length };
}

export interface RestoreResult {
	content: string;
	restoredCount: number;
}

/**
 * Send cards back to the lane they came from when they're unchecked while
 * sitting in the complete lane, using the marker moveCheckedCards attached.
 * A card with no marker (never moved by this plugin, or moved before the
 * restore setting was turned on) is left alone. If the original lane no
 * longer exists, the card stays put, unchecked and stripped of its marker,
 * rather than guessing a new home for it.
 */
export function restoreUncheckedCards(content: string, completeLane: string): RestoreResult {
	const board = parseBoard(content);
	const completeLower = completeLane.trim().toLowerCase();

	const candidates = board.cards.filter(
		(card) =>
			!card.checked &&
			card.laneTitle.toLowerCase() === completeLower &&
			ORIGIN_MARKER.test(card.key),
	);
	if (candidates.length === 0) {
		return { content, restoredCount: 0 };
	}

	const lines = content.split('\n');
	let restoredCount = 0;

	for (const card of [...candidates].sort((a, b) => b.startLine - a.startLine)) {
		const block = lines.slice(card.startLine, card.startLine + card.lineCount);
		const match = (block[0] ?? '').match(ORIGIN_MARKER);
		if (!match) continue;
		const originLane = match[1] ?? '';
		const encoded = match[2] ?? '';

		let restoredFirstLine: string;
		try {
			const withoutMarker = (block[0] ?? '').replace(ORIGIN_MARKER, '');
			restoredFirstLine = uncheckLine(decodeOriginalLine(encoded)) || withoutMarker;
		} catch {
			continue;
		}

		lines.splice(card.startLine, card.lineCount);
		const restoredBlock = [restoredFirstLine, ...block.slice(1)];

		const targetLaneLine = findLaneLine(lines, originLane.toLowerCase());
		if (targetLaneLine === -1) {
			lines.splice(card.startLine, 0, ...restoredBlock);
			continue;
		}

		const insertAt = laneInsertPoint(lines, targetLaneLine);
		lines.splice(insertAt, 0, ...restoredBlock);
		restoredCount++;
	}

	return { content: lines.join('\n'), restoredCount };
}
