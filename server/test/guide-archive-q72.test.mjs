import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDispatcharrGuide } from '../dispatcharr-guide.mjs';
import { createGuideArchive } from '../guide-archive.mjs';
import { createCatchup } from '../catchup.mjs';

const HOUR = 3600000, DAY = 24 * HOUR;
const pad = value => String(value).padStart(2, '0');
const stamp = ms => {
	const date = new Date(ms);
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`;
};
const programme = (title, start, end, channel = 'bbc') =>
	`<programme channel="${channel}" start="${stamp(start)}" stop="${stamp(end)}"><title>${title}</title><desc>Detail ${title}</desc></programme>`;
const feed = programmes => new Response('<tv>' + programmes.join('') + '</tv>');
const channels = [{ id: 'uuid-a', name: 'BBC ONE', number: 1, group: 'UK | Entertainment', epgId: 'bbc' }];
const directory = () => mkdtempSync(path.join(tmpdir(), 'guide-archive-'));
const tick = () => new Promise(resolve => setTimeout(resolve, 100));

function harness({ now, responses, archiveFile = '' }) {
	let clock = now;
	const calls = [];
	const guide = createDispatcharrGuide(
		{ origin: 'http://dispatcharr.test', channels: async () => channels },
		async () => { const next = responses[Math.min(calls.length, responses.length - 1)]; calls.push(clock); if (next instanceof Error) throw next; return next(); },
		() => clock,
		'',
		{ archiveFile, archiveDays: 8 }
	);
	return { guide, calls, advance: ms => { clock += ms; }, now: () => clock };
}

test('a programme seen in an earlier refresh survives six days of two-day feeds', async () => {
	const t0 = Date.parse('2026-11-21T20:00:00Z');
	const dir = directory();
	const archiveFile = path.join(dir, 'guide-archive.json');
	// The first feed has one past and one future programme, exactly like a
	// Dispatcharr that only keeps two days.
	const { guide, advance, now } = harness({
		now: t0,
		archiveFile,
		responses: [
			() => feed([programme('Five days ago', t0 - 3 * HOUR, t0 - 2 * HOUR), programme('Later tonight', t0 + HOUR, t0 + 2 * HOUR)]),
			null
		]
	});
	const first = await guide.archive();
	assert.ok(first.channels[0].programmes.some(p => p.Name === 'Five days ago'));
	await tick();
	const saved = JSON.parse(readFileSync(archiveFile, 'utf8'));
	assert.equal(saved.version, 1);
	assert.ok(JSON.stringify(saved).includes('Five days ago'), 'the archive is written to disk');

	// Five days later the live feed knows nothing about that programme.
	advance(5 * DAY);
	const laterStart = now() - 3 * HOUR;
	const { guide: later } = harness({
		now: now(),
		archiveFile,
		responses: [() => feed([programme('Today', laterStart, laterStart + HOUR)])]
	});
	const merged = await later.archive();
	const names = merged.channels[0].programmes.map(p => p.Name);
	assert.ok(names.includes('Five days ago'), 'history returns even though the live feed only has two days');
	assert.ok(names.includes('Today'));
	const live = await later();
	assert.ok(!live.channels[0].programmes.some(p => p.Name === 'Five days ago'), 'the live guide payload does not grow with history');
});

test('catch-up lists a six-day-old programme that Dispatcharr no longer has', async () => {
	const t0 = Date.parse('2026-11-21T20:00:00Z');
	const archiveFile = path.join(directory(), 'guide-archive.json');
	await createGuideArchive({ file: archiveFile, clock: () => t0, retentionDays: 8 }).ready;
	const first = harness({ now: t0, archiveFile, responses: [() => feed([programme('Old match', t0 - 6 * DAY, t0 - 6 * DAY + 2 * HOUR)])] });
	await first.guide.archive();
	await tick();

	const t1 = t0 + 4 * HOUR;
	const archive = createGuideArchive({ file: archiveFile, clock: () => t1, retentionDays: 8 });
	await archive.ready;
	let clock = t1;
	const guide = createDispatcharrGuide(
		{ origin: 'http://dispatcharr.test', channels: async () => channels },
		async () => feed([programme('Just now', t1 - 2 * HOUR, t1 - HOUR)]),
		() => clock,
		'',
		{ archiveFile, archiveDays: 8 }
	);
	const catchup = createCatchup(
		{ recordingApi: async () => [{ uuid: 'uuid-a', is_catchup: true, catchup_days: 7, name: 'BBC ONE' }] },
		guide,
		() => clock
	);
	const listed = await catchup.list();
	const names = listed.channels.flatMap(channel => channel.programmes.map(p => p.Name));
	assert.ok(names.includes('Old match'), 'a six-day-old programme is offered');
	assert.ok(names.includes('Just now'));
	const old = listed.channels.flatMap(channel => channel.programmes).find(p => p.Name === 'Old match');
	assert.match(old.Id, /^catchup-uuid-a-\d{13}$/);
});

test('the archive prunes past the retention window and never grows without bound', async () => {
	const t0 = Date.parse('2026-11-21T20:00:00Z');
	let clock = t0;
	const archive = createGuideArchive({ clock: () => clock, retentionDays: 8, maxEntries: 10 });
	const channel = start => ({ Id: 'ch', programmes: [{ Id: 'ch:' + start, Name: 'P' + start, StartDate: new Date(start).toISOString(), EndDate: new Date(start + HOUR).toISOString() }] });
	archive.merge([channel(t0 - 7 * DAY)]);
	archive.merge([channel(t0 - 9 * DAY)]);
	assert.equal(archive.size(), 1, 'nine days old is outside an eight-day retention');
	clock = t0 + 2 * DAY;
	archive.merge([]);
	assert.equal(archive.size(), 0, 'the seven-day entry ages out when the clock moves');

	for (let i = 0; i < 30; i++) archive.merge([channel(t0 + 2 * DAY - (i + 1) * HOUR)]);
	assert.ok(archive.size() <= 10, 'the hard cap holds');
});

test('a corrupt or missing archive file starts empty and never throws', async () => {
	const dir = directory();
	const bad = path.join(dir, 'bad.json');
	writeFileSync(bad, 'not json at all', 'utf8');
	const archive = createGuideArchive({ file: bad, clock: () => Date.now() });
	await archive.ready;
	assert.equal(archive.size(), 0);
	const merged = archive.merge([{ Id: 'ch', programmes: [{ Id: 'ch:1', Name: 'A', StartDate: '2026-11-21T10:00:00Z', EndDate: '2026-11-21T11:00:00Z' }] }]);
	assert.equal(merged, true);
	assert.deepEqual(archive.snapshot([{ Id: 'ch', programmes: [] }])[0].programmes.map(p => p.Name), ['A']);
});

test('without a configured archive the guide behaves exactly as before', async () => {
	const t0 = Date.parse('2026-11-21T20:00:00Z');
	const { guide } = harness({ now: t0, responses: [() => feed([programme('Only live', t0 - 2 * HOUR, t0 - HOUR)])] });
	const data = await guide.archive();
	assert.equal(data.channels[0].programmes.length, 1);
	assert.equal(data.channels[0].programmes[0].Name, 'Only live');
});

test('an over-cap archive is trimmed when it is restored', async () => {
	const now = Date.parse('2026-11-21T20:00:00Z');
	const file = path.join(directory(), 'cap.json');
	const programmes = Array.from({ length: 20 }, (_, i) => ({
		Id: 'ch:' + i, Name: 'Programme ' + i,
		StartDate: new Date(now - (i + 1) * HOUR).toISOString(), EndDate: new Date(now - i * HOUR).toISOString()
	}));
	writeFileSync(file, JSON.stringify({ version: 1, savedAt: now, channels: { ch: programmes } }), 'utf8');
	const archive = createGuideArchive({ file, clock: () => now, maxEntries: 5 });
	await archive.ready;
	assert.ok(archive.size() <= 5, 'the hard cap applies on restore, not only on the next merge');
});

test('a live programme that corrects a start time replaces the archived row instead of duplicating it', async () => {
	const now = Date.parse('2026-11-21T20:00:00Z');
	const archive = createGuideArchive({ clock: () => now });
	archive.merge([{ Id: 'ch', programmes: [{ Id: 'ch:old', Name: 'Evening news', StartDate: new Date(now - 2 * HOUR).toISOString(), EndDate: new Date(now - HOUR).toISOString() }] }]);
	const merged = archive.snapshot([{ Id: 'ch', programmes: [{ Id: 'ch:corrected', Name: 'Evening news', StartDate: new Date(now - 2 * HOUR + 10 * 60000).toISOString(), EndDate: new Date(now - 50 * 60000).toISOString() }] }]);
	assert.deepEqual(merged[0].programmes.map(p => p.Id), ['ch:corrected'], 'one entry, not a stale duplicate');
});
