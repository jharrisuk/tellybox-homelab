import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');
const app = read('app.js');
const css = read('style.css');
const coming = read('coming-soon.html');
const comingJs = read('coming-soon.js');
const comingCss = read('coming-soon.css');

test('live guide sizes the timetable to the viewport instead of a fixed 950px grid', () => {
	assert.doesNotMatch(css, /\.timetable\s*\{[^}]*min-width:\s*950px/, 'the fixed 950px floor is gone');
	assert.match(app, /grid\.style\.minWidth = layout\.minWidth \+ 'px'/);
	assert.match(app, /times\.style\.gridTemplateColumns = 'repeat\(' \+ layout\.slots/, 'half-hour header columns follow the rendered span');
	assert.match(css, /\.timetable-channel\s*\{[^}]*position:\s*sticky/, 'the channel column stays sticky while scrolling horizontally');
});

test('guide layout renders about three hours on a phone, six on a tablet and the current four on desktop', () => {
	const from = app.indexOf('const GUIDE_HALF_HOUR_MIN_PX');
	const to = app.indexOf('function renderGuide');
	assert.ok(from > 0 && to > from, 'the layout helper sits just before renderGuide');
	const snippet = app.slice(from, to);
	const layoutFor = (viewport, scrollerWidth) => vm.runInNewContext(snippet + '\nguideLayout();', {
		window: { innerWidth: viewport },
		document: { documentElement: { clientWidth: viewport } },
		$: () => ({ clientWidth: scrollerWidth })
	});
	assert.equal(layoutFor(390, 370).hours, 3);
	assert.equal(layoutFor(390, 370).slots, 6);
	assert.equal(layoutFor(800, 740).hours, 6);
	assert.equal(layoutFor(800, 740).slots, 12);
	assert.equal(layoutFor(1280, 1180).hours, 4);
	assert.equal(layoutFor(1280, 1180).slots, 8);
	// A legible minimum width per half-hour keeps very narrow screens usable.
	const tiny = layoutFor(320, 300);
	assert.ok(tiny.minWidth >= 110 + tiny.slots * 40);
	// On a typical phone the three-hour window fits without horizontal overflow.
	const phone = layoutFor(390, 370);
	assert.ok(phone.minWidth <= 370, 'three hours fit a 390px phone viewport');
});

test('the swipe hint only appears when the rendered span exceeds the viewport', () => {
	assert.match(app, /const overflows = grid\.scrollWidth > scroller\.clientWidth \+ 1;/);
	assert.match(app, /overflows \? ' · Swipe across to look ahead' : ''/);
	assert.doesNotMatch(app, /Next four hours · Swipe across to look ahead/, 'the hint is no longer unconditional');
});

test('guide re-renders slice the listings already fetched and never request more', () => {
	const body = app.slice(app.indexOf('function renderGuide()'), app.indexOf('let guideResizeTimer'));
	assert.doesNotMatch(body, /api\(|fetch\(/, 'renderGuide does not fetch guide data');
	assert.match(body, /Math\.max\(start, Date\.parse\(programme\.StartDate\)\), b = Math\.min\(end, Date\.parse\(programme\.EndDate\)\)/, 'programmes are clipped to the rendered window');
	assert.match(body, /restore\.focus\(\{ preventScroll: true \}\)/, 'keyboard focus survives a re-render');
});

test('coming soon keeps the calendar primary and collapses the duplicate grid behind a disclosure', () => {
	assert.ok(coming.indexOf('id="comingCalendar"') < coming.indexOf('id="comingBrowse"'), 'the calendar comes first');
	assert.match(coming, /<details class="coming-browse" id="comingBrowse">/);
	assert.match(coming, /<summary class="button quiet">Browse all upcoming<\/summary>/);
	const details = coming.slice(coming.indexOf('<details class="coming-browse"'), coming.indexOf('</details>'));
	assert.match(details, /id="comingFilters"/);
	assert.match(details, /id="comingGrid"/);
	assert.match(details, /id="comingMore"/);
	assert.ok(coming.indexOf('id="comingStatus"') < coming.indexOf('<details class="coming-browse"'), 'loading and error status stay visible outside the closed disclosure');
});

test('the disclosure is keyboard accessible and remembers nothing across loads', () => {
	assert.doesNotMatch(coming, /<details[^>]*\bopen\b/, 'the disclosure starts closed on every load');
	assert.doesNotMatch(comingJs, /localStorage|sessionStorage/, 'no disclosure state is persisted');
	assert.doesNotMatch(coming, /<summary[^>]*tabindex="-1"/, 'the summary stays in the tab order');
	assert.match(comingCss, /\.coming-page \.coming-browse > summary:focus-visible\s*\{[^}]*outline/, 'the summary gets the standard keyboard focus outline');
});

test('both changes keep the text-node-only rendering rule', () => {
	for (const source of [app, comingJs]) assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

// Runs the real guideTime/guideRange/guideLayout/renderGuide source against a
// minimal DOM stub, the same approach q39-activity-markup uses for markup checks.
function runGuide(viewport, scrollerWidth) {
	let focused = null;
	const makeNode = tag => {
		const node = {
			tag, className: '', textContent: '', style: {}, children: [], attributes: {},
			append(...items) { for (const item of items) this.children.push(item); },
			replaceChildren(...items) { this.children = [...items]; },
			setAttribute(name, value) { this.attributes[name] = String(value); },
			getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
			classList: { add() {}, remove() {}, toggle() {} },
			contains(other) { return other === this || this.children.some(child => child.contains(other)); },
			querySelectorAll(selector) {
				const found = [];
				const walk = parent => { for (const child of parent.children) { if (child.tag === selector) found.push(child); walk(child); } };
				walk(this);
				return found;
			},
			focus(options) { focused = { node, options }; },
			get scrollWidth() { return Math.max(parseFloat(this.style.minWidth) || 0, scrollerWidth); }
		};
		return node;
	};
	const scroller = makeNode('div');
	scroller.clientWidth = scrollerWidth;
	scroller.scrollLeft = 0;
	const byId = { '#guideRows': scroller, '#count': makeNode('p'), '#status': makeNode('p'), '#guideSummary': makeNode('p'), '#guideFreshness': makeNode('p') };
	const now = Date.now();
	const iso = offset => new Date(now + offset).toISOString();
	const context = {
		window: { innerWidth: viewport, addEventListener() {} },
		document: {
			documentElement: { clientWidth: viewport },
			activeElement: null,
			createElement: makeNode,
			querySelector: selector => selector === '#onlyFavourites' ? { getAttribute: () => 'false' } : null
		},
		$: selector => byId[selector] || null,
		element(tag, className, text) { const node = makeNode(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; },
		localStorage: { getItem: () => '[]' },
		state: { type: 'livetv' },
		channelGroup: '',
		guideData: {
			fetchedAt: now, stale: false,
			channels: [{
				Id: 'dispatch-live-a', Name: 'One', ChannelNumber: '1', Group: 'News',
				programmes: [
					{ Id: 'p1', Name: 'Now show', StartDate: iso(-1800000), EndDate: iso(1800000) },
					{ Id: 'p2', Name: 'Next show', StartDate: iso(1800000), EndDate: iso(5400000) },
					{ Id: 'p3', Name: 'Far show', StartDate: iso(7 * 3600000), EndDate: iso(8 * 3600000) }
				]
			}]
		},
		recordingData: [],
		channelGroups() {},
		channelLogo: () => null,
		programmeRecording: () => undefined,
		showGuideDetails() {},
		startPlayback() {},
		Date, Math, JSON
	};
	const from = app.indexOf('function guideTime(value)');
	const to = app.indexOf('async function loadGuide');
	assert.ok(from > 0 && to > from);
	vm.runInNewContext(app.slice(from, to) + '\nrenderGuide();', context);
	return {
		byId, scroller, document: context.document,
		focused: () => focused,
		rerender: () => vm.runInNewContext('renderGuide();', context)
	};
}

test('renderGuide slices the fetched listings to the viewport window and labels it honestly', () => {
	const phone = runGuide(390, 370);
	const headerTimes = phone.scroller.children[0].children[0].children[1];
	assert.equal(headerTimes.children.length, 6, 'three hours of half-hour labels on a phone');
	assert.match(phone.byId['#guideSummary'].textContent, /Next three hours/);
	assert.doesNotMatch(phone.byId['#guideSummary'].textContent, /Swipe/, 'no swipe hint when the window fits');
	const cells = phone.scroller.querySelectorAll('button').filter(node => node.className === 'timetable-programme');
	assert.deepEqual(cells.map(cell => cell.children[0].textContent), ['Now show', 'Next show'], 'the far listing is sliced away, not fetched');
	assert.equal(cells[0].style.left, '0%', 'the current programme is clipped to the window start');

	const narrow = runGuide(320, 300);
	assert.match(narrow.byId['#guideSummary'].textContent, /Next three hours · Swipe across to look ahead/, 'the hint returns when the span exceeds the viewport');

	const tablet = runGuide(800, 740);
	assert.equal(tablet.scroller.children[0].children[0].children[1].children.length, 12);
	assert.match(tablet.byId['#guideSummary'].textContent, /Next six hours/);
	assert.doesNotMatch(tablet.byId['#guideSummary'].textContent, /Swipe/);

	const desktop = runGuide(1280, 1180);
	assert.equal(desktop.scroller.children[0].children[0].children[1].children.length, 8);
	assert.match(desktop.byId['#guideSummary'].textContent, /Next four hours/);
	assert.doesNotMatch(desktop.byId['#guideSummary'].textContent, /Swipe/);
});

test('a guide re-render keeps keyboard focus on the same programme', () => {
	const guide = runGuide(390, 370);
	const before = guide.scroller.querySelectorAll('button').find(node => (node.getAttribute('aria-label') || '').startsWith('One: Now show'));
	assert.ok(before, 'the programme button exists before the re-render');
	guide.document.activeElement = before;
	guide.rerender();
	const focused = guide.focused();
	assert.ok(focused, 'focus is restored after the re-render');
	assert.equal(focused.node.getAttribute('aria-label'), before.getAttribute('aria-label'));
	assert.equal(focused.options.preventScroll, true);
});
