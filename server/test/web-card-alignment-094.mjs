import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const style = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const outDir = fileURLToPath(new URL('../../outputs/Tellybox-static-cdn-094/evidence/', import.meta.url));
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const before = process.env.ALIGNMENT_BEFORE_IMAGE || '';
if (before && existsSync(before)) copyFileSync(before, join(outDir, 'ALIGNMENT-BEFORE.png'));
const chromePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
	'/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(path => existsSync(path));
if (!chromePath) { console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH.'); process.exit(0); }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const svg = (width, height, color) => 'data:image/svg+xml,' + encodeURIComponent(
	`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="50%" fill="#fff" font-size="${Math.min(width,height)/6}" text-anchor="middle" dominant-baseline="middle">${width}x${height}</text></svg>`);
const items = [
	{ title: 'Avatar Aang: The Last Airbender', meta: '2026 · Animation', image: svg(300, 450, '#1f6f8b'), rating: 'TMDB 9.0/10' },
	{ title: 'Batman: Knightfall Part 1: Knightfall', meta: '2026 · Animation', image: svg(600, 400, '#6b2d2d'), rating: 'TMDB 9.1/10' },
	{ title: 'The Matrix', meta: '1999 · Action', image: svg(200, 600, '#2d4b2d'), rating: '' },
	{ title: 'Better Call Saul', meta: '2015 · Crime', image: '', rating: 'TMDB 8.8/10' },
	{ title: 'The Bear', meta: '2023 · Comedy', image: svg(400, 600, '#3b5b2b'), rating: 'TMDB 8.6/10' },
	{ title: 'Andor', meta: '2022 · Drama', image: svg(500, 750, '#3b3b5b'), rating: 'TMDB 8.4/10' },
	{ title: 'Severance', meta: '2022 · Mystery', image: svg(300, 450, '#5b3b4b'), rating: 'TMDB 8.7/10' },
	{ title: 'A very long title that should wrap over two lines without widening the card or clipping the rating', meta: '2025 · Drama with a longer metadata line', image: svg(450, 675, '#4b5b3b'), rating: 'TMDB 7.9/10' },
];
const cards = items.map((item, index) => `<div class="home-tile" data-index="${index}">
	<button class="card" type="button">
		<div class="poster"><div class="fallback">${item.title}</div>${item.image ? `<img src="${item.image}" alt="">` : ''}</div>
		<h3>${item.title}</h3><p>${item.meta}</p>
		${item.rating ? `<div class="compact-ratings"><span>${item.rating}</span></div>` : ''}
	</button>
	<button class="button quiet home-info" type="button">More info</button>
</div>`).join('');
const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css"></head><body><main><div class="home-feed"><section class="home-row">
<div class="shelf-heading"><h3>Picked for you</h3><p class="shelf-description">A varied start from the collection.</p></div>
<div class="release-grid home-row-grid" id="home-row-grid">${cards}</div></section></div></main></body></html>`;
const server = createServer((req, res) => {
	if (req.url === '/style.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(style); return; }
	res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function targetFor(port) {
	for (let i = 0; i < 80; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			const target = list.find(item => item.type === 'page');
			if (target) return target;
		} catch {}
		await sleep(100);
	}
	throw new Error('Chrome did not expose a page target');
}
async function connect(target) {
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	let id = 0;
	const pending = new Map();
	socket.onmessage = event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(JSON.stringify(message.error)));
			else resolve(message.result);
		}
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const messageId = ++id;
		pending.set(messageId, { resolve, reject });
		socket.send(JSON.stringify({ id: messageId, method, params }));
	});
	return { socket, send };
}
const profile = mkdtempSync(join(tmpdir(), 'tellybox-align-'));
const child = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
	'--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
	{ stdio: 'ignore' });
const results = [];
try {
	let port = 0;
	for (let i = 0; i < 80; i++) {
		const file = join(profile, 'DevToolsActivePort');
		if (existsSync(file)) { port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]); if (port) break; }
		await sleep(100);
	}
	if (!port) throw new Error('Chrome did not open a DevTools port');
	const { send } = await connect(await targetFor(port));
	await send('Page.enable'); await send('Runtime.enable');
	for (const viewport of [{ name: 'desktop', width: 1180, height: 800 }, { name: 'mobile', width: 390, height: 844 }]) {
		await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.name === 'mobile' });
		await send('Page.navigate', { url: origin + '/' });
		await sleep(500);
		const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
		const initial = await evaluate(`(() => {
			const posters=[...document.querySelectorAll('.poster')].map(el=>{const r=el.getBoundingClientRect();return {w:r.width,h:r.height,top:r.top}});
			const titles=[...document.querySelectorAll('.card h3')].map(el=>{const r=el.getBoundingClientRect();return {top:r.top,height:r.height,text:el.textContent}});
			const metas=[...document.querySelectorAll('.card p')].map(el=>{const r=el.getBoundingClientRect();return {top:r.top,height:r.height}});
			const infos=[...document.querySelectorAll('.home-info')].map(el=>{const r=el.getBoundingClientRect();return {bottom:r.bottom,top:r.top}});
			const grid=document.querySelector('.home-row-grid');
			return {posters,titles,metas,infos,page:{scrollWidth:document.documentElement.scrollWidth,innerWidth:innerWidth},
				grid:{scrollWidth:grid.scrollWidth,clientWidth:grid.clientWidth,
					display:getComputedStyle(grid).display,flow:getComputedStyle(grid).gridAutoFlow,
					autoColumns:getComputedStyle(grid).gridAutoColumns,templateColumns:getComputedStyle(grid).gridTemplateColumns,
					templateRows:getComputedStyle(grid).gridTemplateRows,areas:getComputedStyle(grid).gridTemplateAreas,
					children:[...grid.children].map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {class:el.className,w:r.width,h:r.height,top:r.top,left:r.left,display:s.display,minWidth:s.minWidth,maxWidth:s.maxWidth,gridColumn:s.gridColumn,gridRow:s.gridRow,order:s.order,style:el.getAttribute('style')||''}})},
				posterAspect:getComputedStyle(document.querySelector('.poster')).aspectRatio,
				imageFit:getComputedStyle(document.querySelector('.poster img')||document.querySelector('.poster')).objectFit};
		})()`);
		// Missing and wide images must not change the poster track.
		const afterLazy = await evaluate(`(() => {
			const poster=document.querySelectorAll('.poster')[3];
			const before=poster.getBoundingClientRect();
			const img=document.createElement('img');img.src='${svg(900, 200, '#5b4b20')}';img.alt='';poster.append(img);
			const after=poster.getBoundingClientRect();
			return {before:{w:before.width,h:before.height},after:{w:after.width,h:after.height}};
		})()`);
		const first = await evaluate(`(() => { const el=document.querySelector('.card'); el.focus(); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y });
		await sleep(300);
		const hover = await evaluate(`(() => { const a=document.querySelectorAll('.card')[0].getBoundingClientRect(); const b=document.querySelectorAll('.card')[1].getBoundingClientRect(); return {overlap:a.right>b.left+0.5, firstWidth:a.width, secondLeft:b.left, firstRight:a.right}; })()`);
		const shot = await send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(join(outDir, `ALIGNMENT-AFTER-${viewport.name.toUpperCase()}.png`), Buffer.from(shot.data, 'base64'));
		results.push({ viewport, initial, afterLazy, hover });
	}
} finally {
	child.kill(); await sleep(800);
	try { rmSync(profile, { recursive: true, force: true }); } catch {}
	server.closeAllConnections(); server.close();
}
let ready = true;
for (const row of results) {
	const widths = row.initial.posters.map(p => p.w), heights = row.initial.posters.map(p => p.h);
	const titleTops = row.initial.titles.map(t => t.top), infoBottoms = row.initial.infos.map(i => i.bottom);
	if (Math.max(...widths) - Math.min(...widths) > 1) ready = false;
	if (Math.max(...heights) - Math.min(...heights) > 1) ready = false;
	if (Math.max(...titleTops) - Math.min(...titleTops) > 1) ready = false;
	if (Math.max(...infoBottoms) - Math.min(...infoBottoms) > 1) ready = false;
	if (row.initial.page.scrollWidth > row.initial.page.innerWidth + 1) ready = false;
	if (!(row.initial.grid.scrollWidth > row.initial.grid.clientWidth)) ready = false;
	if (row.hover.overlap) ready = false;
	if (Math.abs(row.afterLazy.before.w - row.afterLazy.after.w) > 1 || Math.abs(row.afterLazy.before.h - row.afterLazy.after.h) > 1) ready = false;
}
writeFileSync(join(outDir, 'ALIGNMENT-LAYOUT-094.json'), JSON.stringify({ ready, results }, null, 2) + '\n');
writeFileSync(join(outDir, 'ALIGNMENT-LAYOUT-094.txt'), JSON.stringify({ ready, results }, null, 2) + '\n');
console.log(JSON.stringify({ ready, results }, null, 2));
process.exit(ready ? 0 : 1);
