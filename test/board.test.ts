import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseBoard,
	checkedOutsideLane,
	uncheckDraggedOutCards,
	cleanStaleMarkers,
	stripStampInLane,
	moveCheckedCards,
	restoreUncheckedCards,
} from '../src/board.ts';

function board(lines: string[]): string {
	return lines.join('\n');
}

test('parseBoard reads cards, checked state, and lane assignment', () => {
	const content = board([
		'## Backlog',
		'- [ ] First task',
		'- [x] Second task',
		'## Complete',
		'- [x] Third task',
	]);
	const parsed = parseBoard(content);
	assert.equal(parsed.laneTitles.length, 2);
	assert.equal(parsed.cards.length, 3);
	assert.equal(parsed.cards[0]?.key, 'First task');
	assert.equal(parsed.cards[0]?.checked, false);
	assert.equal(parsed.cards[0]?.laneTitle, 'Backlog');
	assert.equal(parsed.cards[2]?.laneTitle, 'Complete');
});

test('parseBoard joins multi-line card continuations into one key', () => {
	const content = board([
		'## Backlog',
		'- [ ] First line',
		'\t  Second line',
		'\t  Third line',
		'- [ ] Unrelated card',
	]);
	const parsed = parseBoard(content);
	assert.equal(parsed.cards.length, 2);
	assert.equal(parsed.cards[0]?.key, 'First line\n\t  Second line\n\t  Third line');
	assert.equal(parsed.cards[0]?.lineCount, 3);
});

test('parseBoard stops at the Archive heading', () => {
	const content = board([
		'## Backlog',
		'- [ ] Active card',
		'## Archive',
		'- [x] Old card',
	]);
	const parsed = parseBoard(content);
	assert.equal(parsed.cards.length, 1);
	assert.equal(parsed.archiveLine, 2);
});

test('parseBoard stops at the kanban settings block', () => {
	const content = board([
		'## Backlog',
		'- [ ] Active card',
		'%% kanban:settings',
		'{"kanban-plugin":"board"}',
		'%%',
	]);
	const parsed = parseBoard(content);
	assert.equal(parsed.cards.length, 1);
	assert.equal(parsed.settingsLine, 2);
});

test('checkedOutsideLane counts duplicate card text separately', () => {
	const content = board([
		'## Backlog',
		'- [x] Reply to client emails',
		'- [ ] Reply to client emails',
		'- [x] Reply to client emails',
		'## Complete',
	]);
	const counts = checkedOutsideLane(content, 'Complete');
	assert.equal(counts.get('Reply to client emails'), 2);
});

test('checkedOutsideLane ignores a card already inside the target lane', () => {
	const content = board(['## Complete', '- [x] Already done']);
	const counts = checkedOutsideLane(content, 'Complete');
	assert.equal(counts.size, 0);
});

test('checkedOutsideLane matches the target lane case-insensitively', () => {
	const content = board(['## complete', '- [x] Already done', '## Backlog']);
	const counts = checkedOutsideLane(content, 'Complete');
	assert.equal(counts.size, 0);
});

test('checkedOutsideLane skips a card that already carries an origin marker', () => {
	const content = board([
		'## Backlog',
		'- [x] Reply to client emails <!--kcm-from:Complete|dGVzdA==-->',
	]);
	const counts = checkedOutsideLane(content, 'Complete');
	assert.equal(counts.size, 0);
});

test('moveCheckedCards moves a card into an existing target lane with a stamp and marker', () => {
	const content = board(['## Backlog', '- [x] Buy groceries', '## Complete', '']);
	const budget = checkedOutsideLane(content, 'Complete');
	const result = moveCheckedCards(content, budget, 'Complete', '✅ 2026-07-20');
	assert.equal(result.movedCount, 1);
	assert.ok(!result.content.includes('Backlog\n- [x] Buy groceries'));
	assert.match(result.content, /## Complete\n- \[x\] Buy groceries ✅ 2026-07-20 <!--kcm-from:Backlog\|/);
});

test('moveCheckedCards creates the target lane above Archive when missing', () => {
	const content = board(['## Ideas', '- [x] Ship the thing', '## Archive', '- [x] Old']);
	const budget = checkedOutsideLane(content, 'Complete');
	const result = moveCheckedCards(content, budget, 'Complete', null);
	const laneOrder = result.content
		.split('\n')
		.filter((line) => line.startsWith('## '))
		.map((line) => line.slice(3));
	assert.deepEqual(laneOrder, ['Ideas', 'Complete', 'Archive']);
});

test('moveCheckedCards creates the target lane at the bottom when there is no Archive', () => {
	const content = board(['## Ideas', '- [x] Ship the thing']);
	const budget = checkedOutsideLane(content, 'Complete');
	const result = moveCheckedCards(content, budget, 'Complete', null);
	const laneOrder = result.content
		.split('\n')
		.filter((line) => line.startsWith('## '))
		.map((line) => line.slice(3));
	assert.deepEqual(laneOrder, ['Ideas', 'Complete']);
});

test('moveCheckedCards moves a multi-line card as one block, continuation lines included', () => {
	const content = board([
		'## Backlog',
		'- [x] First line',
		'\t  Second line',
		'## Complete',
		'',
	]);
	const budget = checkedOutsideLane(content, 'Complete');
	const result = moveCheckedCards(content, budget, 'Complete', null);
	assert.equal(result.movedCount, 1);
	const parsed = parseBoard(result.content);
	const moved = parsed.cards.find((card) => card.laneTitle === 'Complete');
	assert.ok(moved?.key.startsWith('First line <!--kcm-from:Backlog|'));
	assert.ok(moved?.key.endsWith('\n\t  Second line'));
});

test('moveCheckedCards only moves as many duplicates as the budget allows', () => {
	const content = board([
		'## Backlog',
		'- [x] Reply to client emails',
		'- [ ] Reply to client emails',
		'## Complete',
		'',
	]);
	const budget = checkedOutsideLane(content, 'Complete');
	const result = moveCheckedCards(content, budget, 'Complete', null);
	assert.equal(result.movedCount, 1);
	const parsed = parseBoard(result.content);
	const backlogCard = parsed.cards.find((card) => card.laneTitle === 'Backlog');
	assert.equal(backlogCard?.checked, false);
});

test('moveCheckedCards never layers a second marker onto a card that already carries one', () => {
	const content = board([
		'## Backlog',
		'- [x] Ship the thing <!--kcm-from:OldLane|c3RhbGU=-->',
		'## Complete',
		'',
	]);
	// Simulate checkedOutsideLane's own filtering being bypassed (defensive
	// coverage for the inflight-conflict path that could otherwise hand a
	// pre-marked card to moveCheckedCards).
	const budget = new Map([['Ship the thing <!--kcm-from:OldLane|c3RhbGU=-->', 1]]);
	const result = moveCheckedCards(content, budget, 'Complete', null);
	const markerCount = (result.content.match(/<!--kcm-from:/g) ?? []).length;
	assert.equal(markerCount, 1);
});

test('restoreUncheckedCards sends an unchecked card back to its recorded origin lane', () => {
	const content = board(['## Backlog', '- [x] Buy groceries', '## Complete', '']);
	const budget = checkedOutsideLane(content, 'Complete');
	const moved = moveCheckedCards(content, budget, 'Complete', null);

	const uncheckedInComplete = moved.content.replace(
		/- \[x\] Buy groceries( <!--kcm-from:[^>]*-->)/,
		'- [ ] Buy groceries$1',
	);
	const restored = restoreUncheckedCards(uncheckedInComplete, 'Complete');
	assert.equal(restored.restoredCount, 1);
	const parsed = parseBoard(restored.content);
	const backlogCard = parsed.cards.find((card) => card.laneTitle === 'Backlog');
	assert.equal(backlogCard?.key, 'Buy groceries');
	assert.ok(!restored.content.includes('kcm-from'));
});

test('restoreUncheckedCards finds the marker on a multi-line card (regression: missing /m flag)', () => {
	// This is the exact shape that broke before the origin-marker regex
	// gained the /m flag: a multi-line card's key joins lines with \n, so the
	// marker sits at the end of line 1, not at the end of the whole key.
	// Without /m, $ only matched the end of the entire string and the marker
	// was invisible to every function keying off it.
	const content = board([
		'## Backlog',
		'- [x] First line',
		'\t  Second line',
		'## Complete',
		'',
	]);
	const budget = checkedOutsideLane(content, 'Complete');
	const moved = moveCheckedCards(content, budget, 'Complete', null);

	const uncheckedInComplete = moved.content.replace(
		/- \[x\] First line( <!--kcm-from:[^>]*-->)/,
		'- [ ] First line$1',
	);
	const restored = restoreUncheckedCards(uncheckedInComplete, 'Complete');
	assert.equal(restored.restoredCount, 1);
	const parsed = parseBoard(restored.content);
	const backlogCard = parsed.cards.find((card) => card.laneTitle === 'Backlog');
	assert.equal(backlogCard?.key, 'First line\n\t  Second line');
});

test('restoreUncheckedCards leaves a card in place, stripped, if its origin lane no longer exists', () => {
	const content = board(['## Backlog', '- [x] Buy groceries', '## Complete', '']);
	const budget = checkedOutsideLane(content, 'Complete');
	const moved = moveCheckedCards(content, budget, 'Complete', null);

	// Simulate the origin lane having been deleted or renamed after the
	// move, then the card being unchecked while it sits in Complete.
	const laneRemoved = moved.content
		.replace('## Backlog\n', '')
		.replace(/- \[x\] Buy groceries( <!--kcm-from:[^>]*-->)/, '- [ ] Buy groceries$1');

	const restored = restoreUncheckedCards(laneRemoved, 'Complete');
	assert.equal(restored.restoredCount, 0);
	assert.ok(!restored.content.includes('kcm-from'));
	const parsed = parseBoard(restored.content);
	assert.equal(parsed.cards[0]?.laneTitle, 'Complete');
	assert.equal(parsed.cards[0]?.key, 'Buy groceries');
});

test('uncheckDraggedOutCards unchecks and fully cleans a marked card dragged outside the target lane', () => {
	const content = board([
		'## Complete',
		'- [x] Buy groceries ✅ 2026-07-20 <!--kcm-from:Backlog|QnV5IGdyb2Nlcmllcw==-->',
		'## Somewhere Else',
		'',
	]);
	const dragged = content.replace('## Complete\n', '## Complete\n').replace(
		'## Somewhere Else',
		'## Somewhere Else',
	);
	// Move the card's line under Somewhere Else to simulate a manual drag.
	const lines = dragged.split('\n');
	const cardLine = lines.splice(1, 1)[0] ?? '';
	const insertAt = lines.indexOf('## Somewhere Else') + 1;
	lines.splice(insertAt, 0, cardLine);
	const draggedContent = lines.join('\n');

	const result = uncheckDraggedOutCards(draggedContent, 'Complete');
	assert.equal(result.uncheckedCount, 1);
	assert.ok(!result.content.includes('kcm-from'));
	assert.ok(!result.content.includes('✅'));
	const parsed = parseBoard(result.content);
	const card = parsed.cards.find((c) => c.laneTitle === 'Somewhere Else');
	assert.equal(card?.checked, false);
});

test('cleanStaleMarkers strips leftover stamp and marker from an unchecked card outside the target lane', () => {
	const content = board([
		'## Somewhere Else',
		'- [ ] Buy groceries ✅ 2026-07-20 <!--kcm-from:Backlog|QnV5IGdyb2Nlcmllcw==-->',
	]);
	const result = cleanStaleMarkers(content, 'Complete');
	assert.equal(result.uncheckedCount, 1);
	assert.ok(!result.content.includes('kcm-from'));
	assert.ok(!result.content.includes('✅'));
});

test('stripStampInLane strips a stale stamp from a card unchecked in place inside the target lane', () => {
	// Regression: with restoreOnUncheck off, none of the other functions key
	// off "unchecked, marked, and still inside the target lane" -- the card
	// was left stuck with a stamp it no longer earned.
	const content = board([
		'## Complete',
		'- [ ] Buy groceries ✅ 2026-07-20 <!--kcm-from:Backlog|QnV5IGdyb2Nlcmllcw==-->',
	]);
	const result = stripStampInLane(content, 'Complete');
	assert.equal(result.uncheckedCount, 1);
	assert.ok(!result.content.includes('kcm-from'));
	assert.ok(!result.content.includes('✅'));
	const parsed = parseBoard(result.content);
	assert.equal(parsed.cards[0]?.laneTitle, 'Complete');
	assert.equal(parsed.cards[0]?.key, 'Buy groceries');
});
