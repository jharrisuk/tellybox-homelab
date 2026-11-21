import { copyFileSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));
const beforeRoot = process.argv[2];
if (!beforeRoot) throw new Error('Pass the before-tree output directory.');
cpSync(publicRoot, beforeRoot, { recursive: true });

let app = readFileSync(join(publicRoot, 'app.js'), 'utf8');
const replace = (needle, replacement, label) => {
	if (!app.includes(needle)) throw new Error('missing marker: ' + label);
	app = app.replace(needle, replacement);
};

replace(', artworkRestartBudget: 1, favouritesSettled: false };', ', artworkRestartBudget: 1 };', 'homeFeedState');
replace(
	app.slice(app.indexOf('let sharedFavourites=null'), app.indexOf('async function init() {')),
	"let sharedFavourites=null, favouriteHome=false, serverFavouritesRequired=false, canShare=false;\n"
	+ "function loadHomeFeeds(){if(homeFeedsStarted)return;homeFeedsStarted=true;void Promise.all([loadLikedEpisodes(),loadHomeFeed()]);}\n",
	'loadHomeFeeds');
replace(
	app.slice(app.indexOf('\t// Favourites are part of the feed context.'), app.indexOf('\tconst payload = homeContextPayload(), context')),
	'',
	'loadHomeFeed favourites await');
replace(
	app.slice(app.indexOf('\t\t// Favourites stay behind auth. Start that read now;'), app.indexOf('\t\tconst favouriteTools =')),
	"\t\t// The personalized feed starts as soon as auth is known. It does not wait\n"
	+ "\t\t// for favourites, /api/status or /api/libraries; those continue below.\n"
	+ "\t\tif (isHomeView()) loadHomeFeeds();\n"
	+ "\t\t// Favourites stay behind auth. When they were required, the first feed\n"
	+ "\t\t// request could not include them, so reconcile once when they land.\n"
	+ "\t\tconst favouritesScope = homeFeedState.scope;\n"
	+ "\t\tlet favourites = null;\n"
	+ "\t\ttry { if(serverFavouritesRequired) favourites = await api(favouriteHome?'/api/favourites/home':'/api/favourites'); } catch {}\n"
	+ "\t\tif (favouritesScope !== homeFeedState.scope) return;\n"
	+ "\t\tif (favourites) sharedFavourites = favourites.own;\n"
	+ "\t\tif (isHomeView() && serverFavouritesRequired) {\n"
	+ "\t\t\tvoid loadLikedEpisodes().catch(() => {});\n"
	+ "\t\t\tvoid loadHomeFeed(true);\n"
	+ "\t\t}\n",
	'init favourites block');
replace(
	app.slice(app.indexOf('// hls.js is only needed when a stream is HLS.'), app.indexOf('function playbackCapabilities() {')),
	'',
	'hls loader');
replace(
	"\t// Start the player bundle in parallel with session teardown. It is awaited\n"
	+ "\t// only before capability probing, so direct playback still proceeds if the\n"
	+ "\t// script is unavailable.\n"
	+ "\tconst hlsReady = loadHlsScript().catch(() => false);\n",
	'',
	'hls start');
replace(
	"\t\tawait hlsReady;\n\t\tif (generation !== playGeneration || !player.open) return;\n",
	'',
	'hls await');
replace(
	app.slice(app.indexOf('let castSecureLinkRequested = false;'), app.indexOf('\twindow.__onGCastApiAvailable = available => {')),
	"function setupCast() {\n"
	+ "\tif (!window.isSecureContext || location.protocol !== 'https:') {\n"
	+ "\t\t$('#castStatus').textContent = 'To cast, open the secure Tellybox address in Chrome and sign in. Keep your phone and TV on the same Wi-Fi.';\n"
	+ "\t\tvoid api('/api/auth/tunnel').then(value => {\n"
	+ "\t\t\tif (value.url?.startsWith('https://')) { $('#castSecureLink').href = value.url; $('#castSecureLink').hidden = false; }\n"
	+ "\t\t}).catch(() => {});\n"
	+ "\t\treturn;\n"
	+ "\t}\n",
	'setupCast prefix');
replace("if (freshOpen) { player.showModal(); loadCastSecureLink(); }", 'if (freshOpen) player.showModal();', 'cast open');
writeFileSync(join(beforeRoot, 'app.js'), app);

let html = readFileSync(join(publicRoot, 'index.html'), 'utf8');
html = html.replace('\t<script src="/autoplay.js" defer></script>',
	'\t<script src="/vendor/hls.min.js" defer></script>\n\t<script src="/autoplay.js" defer></script>');
html = html.replace('<picture><source srcset="/tellybox-logo.webp" type="image/webp"><img class="brand-logo" src="/tellybox-logo.png" alt="Tellybox"></picture>',
	'<img class="brand-logo" src="/tellybox-logo.png" alt="Tellybox">');
writeFileSync(join(beforeRoot, 'index.html'), html);
copyFileSync(fileURLToPath(new URL('../../../outputs/Tellybox-consolidation-121/web/evidence/before-source/tellybox-logo.png', import.meta.url)),
	join(beforeRoot, 'tellybox-logo.png'));
console.log('before tree: ' + beforeRoot);

