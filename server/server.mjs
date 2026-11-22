import { createEpisodeNext } from './episode-next.mjs';
import { installTvControl } from './tv-control.mjs';
import { createMediaSegments } from './media-segments.mjs';
import express from 'express';
import { installAppUpdates } from './app-updates.mjs';
import { downloadOptions, downloadQuality } from './download-options.mjs';
import { createDownloadLimit, downloadOwner } from './download-limit.mjs';
import { createServerHealth } from './server-health.mjs';
import { orderedEpisodes, followingEpisode } from './episode-order.mjs';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installAuth } from './auth.mjs';
import { createActivity } from './activity.mjs';
import { remoteAccessStatus } from './tunnel.mjs';
import { issueCastTicket, validCastTicket, castPath } from './cast.mjs';
import { createHomeNetwork } from './home-network.mjs';
import { createLiveGuide } from './live-tv.mjs';
import { installSeerr, mediaView } from './seerr.mjs';
import { createGlobalSearch } from './global-search.mjs';
import { insightsFromFile, score } from './insights.mjs';
import { resolveComingMatches } from './coming-library.mjs';
import { recentTvEpisodes, episodeReleaseDates } from './tv-releases.mjs';
import { newlyAvailableItems, newlyAvailableQuery } from './newly-available.mjs';
import { createShares, installPublicShares } from './shares.mjs';
import {createAccountLimits} from './account-limits.mjs';
import {createSessionLimits} from './session-limits.mjs';
import {createRemoteControls} from './remote-controls.mjs';
import { createUploadLimit } from './upload-limit.mjs';
import { createPlaybackDefaults } from './playback-defaults.mjs';
import { createPausedTimeout } from './paused-timeout.mjs';
import { createPausedPlayback, PAUSED_TIMEOUT, terminalStopFor as terminalStopRecord } from './paused-playback.mjs';
import { createPausedEnforcer } from './paused-enforcer.mjs';
import { primeStream } from './warmup.mjs';
import { proxyImage } from './image-proxy.mjs';
import { createProviderImageCache } from './provider-logo.mjs';
import { deviceProfile, textSubtitle, wantsSubtitleLookup, srtToVtt, jellyfinTranscodeReason, relayConversionReason } from './playback-profile.mjs';
import { readFile } from 'node:fs/promises';
import { subtitleChoice, englishSubtitle } from './subtitle-choice.mjs';
import { createSubtitleLookup, downloadedSubtitleIndex } from './subtitle-lookup.mjs';
import { createDispatcharr, findChannelForArtwork, channelLogoUrl } from './dispatcharr.mjs';
import { createDispatcharrGuide, channelView } from './dispatcharr-guide.mjs';
import { createSportListings } from './sport-listings.mjs';
import { createLiveSportOntv, KNOWN_SPORTS, mergeSportRails, applySportSettings } from './livesportontv.mjs';
import { createSportSettings } from './sport-settings.mjs';
import {createCatchup} from './catchup.mjs';
import {createBroadcastResume} from './broadcast-resume.mjs';
import {createCatchupPlayer} from './catchup-player.mjs';
import { createDirectPlayer, mediaFile } from './dispatcharr-player.mjs';
import { createDirectSessionCleanup } from './direct-session.mjs';
import { sanitizeCapabilities } from './capabilities.mjs';
import { createUsbExport, installUsbExport, adminAllowed } from './usb-export.mjs';
import { createUsbHelperClient } from './usb-helper-client.mjs';
import { createVodLibrary, providerLabel, selectProvider } from './vod-library.mjs';
import { createVodMetadata } from './vod-metadata.mjs';
import { buildHomeFeed, homeVisibleItems, seriesResumeTarget, viewerHomeContext } from './home-feed.mjs';
import { createHomeContinue } from './home-continue.mjs';
import { createCatalogueSnapshot, createHomeEpisodeLookup, parseAnchors, parseSeriesIds, REQUEST_TIMEOUT_MS, untilDeadline } from './home-episodes.mjs';
import { createTrendingPreload } from './trending-preload.mjs';
import { createCacheJobs } from './cache-jobs.mjs';
import { createOwnerSession } from './owner-session.mjs';
import { installQbittorrentRoutes } from './qbittorrent.mjs';
import { rankSimilarCandidates, similarLimit, similarView } from './similar-titles.mjs';
import { trailerView } from './trailers.mjs';
import { createNonstopMetadata } from './nonstop-metadata.mjs';
import { createVodPlayer } from './vod-player.mjs';
import { createRecordings } from './recordings.mjs';
import { createRecordingDeletion, installRecordingDeletion } from './recording-deletion.mjs';
import { loadCapabilities, optionalDispatcharr } from './homelab/runtime.mjs';
import { installReleaseVersion, serverRelease } from './release-version.mjs';
import { createHomeAssistantIntegration, installHomeAssistantStats } from './home-assistant.mjs';
import { createRefreshAlertTokens, installRefreshAlert } from './refresh-alert.mjs';
import { createRelayMediaService } from './relay-media/install.mjs';
import { normalizeRelayQuality } from './relay-media/quality.mjs';
import { contentSecurityPolicy, normalizeRelayOrigin } from './csp.mjs';
import { createPublicAssetCdn, normalizePublicAssetOrigin } from './public-assets.mjs';
import { createArtworkCdn, normalizeArtworkCdnOrigin } from './artwork-cdn.mjs';
import { createMaintenance, MAINTENANCE_MESSAGE } from './maintenance.mjs';
import { createArtworkOrigin } from './artwork-origin.mjs';
import { isLocalOrHome, rewriteArtworkResponse } from './artwork-routing.mjs';
import { createLibraryImageHandler } from './library-image.mjs';
import { createJellyfinAdmin } from './jellyfin-admin.mjs';import { createHomeArtwork, homeArtworkCandidates } from './home-artwork.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const upstream = new URL(process.env.JELLYFIN_URL || 'http://127.0.0.1:1');
const configPath = path.join(process.env.DATA_DIR || path.join(root, 'data'), 'connection.json');
// Media deletion uses the installation's Jellyfin administrator key, not the
// viewer token. It lives in the homelab configuration, one level above the
// media connection file. Missing or invalid fails closed.
const jellyfinAdmin = createJellyfinAdmin({
	configPath: process.env.HOMELAB === '1' ? path.join(path.dirname(path.dirname(configPath)), 'configuration.json') : ''
});
const features = loadCapabilities(path.dirname(configPath));
const dispatcharr = optionalDispatcharr(createDispatcharr({ file:path.join(process.env.AUTH_DIR || path.join(root, 'auth-data'), 'dispatcharr.json'), origin:process.env.DISPATCHARR_URL || 'http://127.0.0.1:1' }), features);
const providerArtwork = createProviderImageCache();
const guideCacheDir = process.env.CATALOGUE_CACHE_DIR || process.env.AUTH_DIR || path.join(root,'auth-data');
const dispatcharrGuide = features.live ? createDispatcharrGuide(dispatcharr,fetch,Date.now,path.join(guideCacheDir,'dispatcharr-guide.json'), { archiveFile: path.join(guideCacheDir,'guide-archive.json'), archiveDays: 8 }) : Object.assign(async () => ({channels:[],available:false,stale:false}), {archive:async () => ({channels:[],available:false})});
// UK televised-football rail for Coming Soon. Polite, cached and never fatal:
// it reads the same live lineup the guide uses and keeps the last good parse on
// disk so a restart inside the 6h window does not refetch the source.
const sportListings = createSportListings({
	channels: () => dispatcharr.channels(),
	version: serverRelease.version,
	cachePath: path.join(process.env.CATALOGUE_CACHE_DIR || process.env.AUTH_DIR || path.join(root,'auth-data'),'sport-listings.json')
});
// All-sports spine (Q79): livesportontv.co.uk carries boxing, MMA/UFC and the
// other sports the football only source cannot. Same polite, cached, never fatal
// rules and the same live lineup; merged with the football rail below.
const liveSportOntv = createLiveSportOntv({
	channels: () => dispatcharr.channels(),
	version: serverRelease.version,
	cachePath: path.join(guideCacheDir, 'livesportontv.json')
});
// Admin sport settings (Q80): enable/disable the rail, choose sports, and scope
// football to UK competitions or all. Stored beside the other rail caches.
const sportSettings = createSportSettings(guideCacheDir, { knownSports: KNOWN_SPORTS });
const directPlayer = createDirectPlayer({origin:dispatcharr.origin});
const subtitleLookup=createSubtitleLookup({directory:process.env.AUTH_DIR||path.join(root,'auth-data')});
const vodPlayer = createVodPlayer({open:(source,options)=>source.type==='local'?fetch(new URL(source.route,upstream),{headers:{...headers(),...(options.range?{Range:options.range}:{})},redirect:'error',signal:options.signal}):source.type==='recording'?dispatcharr.recordingFile(source.id,options):dispatcharr.stream(source,options),close:(token,source)=>['recording','local'].includes(source.type)?Promise.resolve():dispatcharr.stopStream(token)});
const recordings = createRecordings({dispatcharr,guide:dispatcharrGuide});
const sessions = new Map();
const downloadLimit = createDownloadLimit();
const instanceId = randomUUID();
const localPlaybackOrigin = new URL(process.env.LOCAL_PLAYBACK_ORIGIN || 'http://127.0.0.1:8082').origin;
const relayCspOrigin = normalizeRelayOrigin(process.env.PUBLIC_ORIGIN || '', features.relayMedia === true || process.env.RELAY_MEDIA_ENABLED === '1');
const assetCdnOrigin = normalizePublicAssetOrigin(process.env.PUBLIC_ASSET_CDN_ORIGIN || '');
const artworkCdnOrigin = normalizeArtworkCdnOrigin(process.env.PUBLIC_ARTWORK_CDN_ORIGIN || assetCdnOrigin || '');
const artworkCdn = createArtworkCdn({
	origin: artworkCdnOrigin,
	secret: process.env.PUBLIC_ARTWORK_CDN_SECRET || '',
	privateTtlMs: Number(process.env.PUBLIC_ARTWORK_CDN_PRIVATE_TTL_MS) || undefined,
	privateArtwork: process.env.PUBLIC_ARTWORK_CDN_PRIVATE === '1',
});
const artworkResolvers = {};
const publicAssets = createPublicAssetCdn({ directory: path.join(root, 'public'), origin: assetCdnOrigin, verify: true });
const app = express();
app.disable('x-powered-by');
app.get('/homelab-ready', (req, res) => res.json({ instance: process.env.HOMELAB_INSTANCE || '' }));
// The nightly refresh job needs one narrow write capability: create an admin
// alert. It is a separate credential from the read-only Home Assistant token
// and is installed before the shared JSON parser (so its 4 KB limit applies to
// the raw body) and before the viewer gate (so cookies, owner sessions and app
// tokens can never reach it). The activity store is lazily referenced because
// it is created later in this module, before any request can arrive.
const refreshAlertTokens = createRefreshAlertTokens(process.env.AUTH_DIR || path.join(root, 'auth-data'));
installRefreshAlert(app, { tokens: refreshAlertTokens, record: (...args) => activity.record(...args) });
const jsonSmall=express.json({ limit: '16kb' });
const jsonHome=express.json({ limit: '512kb' });
app.use((req,res,next)=>(req.method==='POST'&&['/api/web/home','/api/web/home/continue','/api/web/similar'].includes(req.path)?jsonHome:jsonSmall)(req,res,next));
// Installation settings have one owner. Legacy editors must not change generated files.
app.use((req,res,next)=>{
	if(process.env.HOMELAB==='1'&&req.method==='POST'&&['/api/dispatcharr/connection','/api/subtitles/connection','/api/auth/email/config'].includes(req.path))
		return res.status(409).json({error:'Manage this connection in Installation settings. Save and Apply there to keep all settings together.'});
	next();
});
const cspAssetOrigin = [...new Set([assetCdnOrigin, artworkCdnOrigin].filter(Boolean))].join(' ');
// A trusted image tag is a content version, not authorization. Minting is only
// allowed after the request passed the viewer/app gate and the caller is
// permitted to see the item remotely. Local and home viewers are always allowed.
function mayMintArtwork(req, item) {
	const viewer = req.jserverViewer;
	if (!viewer && !req.jserverLocal) return false;
	if (req.jserverLocal || viewer.local === true || viewer.home === true) return true;
	const raw = item?.Id ?? item?.itemId ?? item?.id ?? '';
	const itemId = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
	if (!itemId) return false;
	return remoteControls.allowed(viewer, { itemId, nonstop: item?.Nonstop === true || item?.nonstop === true }) === true;
}
app.use((req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('Referrer-Policy', 'no-referrer');
	res.setHeader('Content-Security-Policy', contentSecurityPolicy({ localPlaybackOrigin, relayMediaOrigin: relayCspOrigin, assetOrigin: cspAssetOrigin }));
	next();
});
app.use(publicAssets.middleware({ isLocal: isLocalOrHome }));
let artworkOriginHandler = null;
app.get('/tellybox/art/:token/:hash/:name', (req, res) => {
	if (!artworkOriginHandler) {
		res.setHeader('Cache-Control', 'no-store');
		return res.sendStatus(503);
	}
	return artworkOriginHandler(req, res);
});
if (artworkCdn.enabled) app.use((req, res, next) => {
	const originalJson = res.json.bind(res);
	res.json = body => {
		if (!body || typeof body !== 'object' || res.headersSent || res.writableEnded) return originalJson(body);
		rewriteArtworkResponse(body, { cdn: artworkCdn, local: isLocalOrHome(req), resolvers: artworkResolvers,
			authorize: item => mayMintArtwork(req, item),
			// Version local /images URLs from the trusted image tag, and let the
			// private mint memo reuse a live URL only inside this viewer's scope.
			versioned: true, scope: req.jserverOwner || '' })
			.then(value => {
				if (!res.headersSent && !res.writableEnded) originalJson(value);
			})
			.catch(() => {
				if (!res.headersSent && !res.writableEnded) originalJson(body);
			});
		return res;
	};
	next();
});

installReleaseVersion(app);
installAppUpdates(app, path.join(path.dirname(configPath), 'app-updates'));

// Receivers have no browser cookie. This capability grants only one live playback session.
app.all('/cast-stream/:ticket/:session/:resource', async (req, res) => {
	res.setHeader('Cache-Control', 'no-store');
	const session = sessions.get(req.params.session);
	if (!validCastTicket(session, req.params.ticket, auth.validOwner)) return res.sendStatus(403);
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
	res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
	if (req.get('access-control-request-private-network') === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
	if (req.method === 'OPTIONS') return res.sendStatus(204);
	if (!['GET', 'HEAD'].includes(req.method)) return res.sendStatus(405);
	return proxyStream(req, res, session, req.params.ticket);
});

let accountLimits;
const accountDayWindow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
const activity = createActivity(process.env.AUTH_DIR || path.join(root, 'auth-data'), { bandwidth: () => uploadLimit.status(), transfer: id => uploadLimit.measuredMbps(id),
	// Only a real person/device account has a quota window. Local, shared-link and
	// guest keys must not create phantom account records just by being viewed.
	dailySeconds: id => /^(person|device):[a-f0-9]{32}$/.test(String(id || '')) ? accountLimits?.status(id)?.dailySeconds ?? null : null,
	dailyLimitSeconds: id => {
		if (!/^(person|device):[a-f0-9]{32}$/.test(String(id || ''))) return null;
		const value = accountLimits?.status(id)?.dailyMinutes;
		return Number.isFinite(value) && value > 0 ? Math.floor(value * 60) : null;
	},
	dailyTimezone: 'Europe/London',
	dailyDay: () => accountDayWindow.format(new Date()) });
accountLimits=createAccountLimits(process.env.AUTH_DIR||path.join(root,'auth-data'),{resolveViewer:viewer=>auth.viewerAccount(viewer)});
const sessionLimits=createSessionLimits({accountLimits,exists:id=>sessions.has(id)});
const remoteControls=createRemoteControls(process.env.AUTH_DIR||path.join(root,'auth-data'));
const isAdmin=req=>req.jserverApp?.role==='admin';
const uploadLimit = createUploadLimit(process.env.AUTH_DIR || path.join(root, 'auth-data'));
const playbackDefaults = createPlaybackDefaults(process.env.AUTH_DIR || path.join(root, 'auth-data'));
const pausedTimeout = createPausedTimeout(process.env.AUTH_DIR || path.join(root, 'auth-data'));
const pausedTestMs = process.env.NODE_ENV === 'test' ? Number(process.env.TELLYBOX_TEST_PAUSED_TIMEOUT_MS) : 0;
const pausedMinutes = () => Number.isFinite(pausedTestMs) && pausedTestMs > 0 ? pausedTestMs / 60000 : pausedTimeout.status().minutes;
const pausedPlayback = createPausedPlayback({ minutes: pausedMinutes });
const directSessionCleanup = createDirectSessionCleanup({ sessions, sessionLimits, accountLimits, activity, pausedPlayback });
const pausedStops = new Map();
const SESSION_IDLE = 'SESSION_IDLE';
const TERMINAL_TOMBSTONE_MS = 24 * 60 * 60 * 1000;
// Private main-worker control is registered before the viewer gate. Caddy blocks
// /internal/* publicly; the handler also verifies worker signatures and peers.
const relayMediaService = createRelayMediaService({ directory: process.env.RELAY_STATE_DIR || path.dirname(configPath), accountLimits, publicOrigin: process.env.PUBLIC_ORIGIN || '', maxSessions: 3,
	enabled: process.env.RELAY_MEDIA_ENABLED === '1' || features.relayMedia === true });
relayMediaService.install(app);
const pausedEnforcer = createPausedEnforcer({
	stop,
	onGiveUp: (session, error) => {
		console.error('Terminal playback cleanup failed:', session.id, error?.name || 'error');
		if (session.relayLeaseId) void relayMediaService.revoke(session.relayLeaseId, 'cleanup_failed').catch(() => {});
		sessionLimits.release(session.id);
		accountLimits.end(session.id);
		sessions.delete(session.id);
	}
});
const serverHealth = createServerHealth(process.env.HOST_HEALTH_PATH || path.join(path.dirname(configPath), 'host-health.json'), { bandwidth: () => uploadLimit.status(), streaming: () => activity.snapshot().active.filter(item => item.purpose !== 'download').length });
// The same file-backed state drives the 503 page and the Home Assistant
// maintenance binary sensor. It is created before the viewer gate so the
// public status can be read by signed-out callers.
const maintenance = createMaintenance({ directory: process.env.AUTH_DIR || path.join(root, 'auth-data') });
const homeAssistant = createHomeAssistantIntegration({
	directory: process.env.AUTH_DIR || path.join(root, 'auth-data'),
	activity, serverHealth, uploadLimit, maintenance, version: serverRelease.version
});
// Registered before the viewer-login gate. This route authenticates only the
// dedicated bearer token; it is never satisfied by a viewer cookie or app token.
installHomeAssistantStats(app, { integration: homeAssistant });
const shares = createShares(process.env.AUTH_DIR || path.join(root, 'auth-data'), {
	onRevoke: owner => { for (const session of sessions.values()) if (session.owner === owner) void stop(session,{relayRevoke:Boolean(session.relayLeaseId)}); }
});
installPublicShares(app, {
	shares, publicDirectory: path.join(root, 'public'), hlsFile: path.join(root, 'node_modules/hls.js/dist/hls.min.js'),
	playback: preparePlayback, stream: serveStream, session: updateSession,
	identity: req => auth.identity(req),
	seriesEpisodes: async id => (await jelly(`/Shows/${itemId(id)}/Episodes?UserId=${connection().userId}&IsMissing=false&IsUnaired=false&Fields=Overview`)).Items.filter(x => !x.IsVirtualItem).map(itemView),
	sharedItem: async id => jelly(`/Users/${connection().userId}/Items/${itemId(id)}`),
	sameOrigin: req => req.get('origin') === process.env.PUBLIC_ORIGIN || req.get('origin') === `${req.protocol}://${req.get('host')}`
});
const homeNetwork = createHomeNetwork(process.env.HOME_IP_ENDPOINT || '', { onChange: previous => auth.revokeOwner(`home:${previous}`) });
// A nonsecret, server-issued cache scope for the browser. It changes when the
// stable account/device identity or the configured source files change, without
// exposing an owner key, token or source address. It is only a cache boundary,
// never authorization.
function authHomeScopeFingerprint(req) {
	const viewer = req.jserverViewer || {};
	const hash = createHash('sha256');
	hash.update(String(instanceId)); hash.update('\0');
	for (const file of [path.join(process.env.AUTH_DIR || path.join(root, 'auth-data'), 'dispatcharr.json'), configPath]) {
		try { hash.update(readFileSync(file)); } catch { hash.update('\0'); }
		hash.update('\0');
	}
	hash.update(String(req.jserverOwner || '')); hash.update('\0');
	hash.update(String(viewer.deviceId || viewer.browserId || viewer.ip || ''));
	return hash.digest('hex').slice(0, 24);
}
// The fixed page shell is revalidated with its ETag instead of being refused a
// cache. style.css and the logo are also used by the signed-out login page and
// are already served before the auth gate by the auth module, so these early
// routes only replace that header. app.js and home-124.css stay behind the
// normal auth gate (registered later, just before express.static). APIs and
// personalised JSON never take this path.
for (const file of ['style.css', 'tellybox-logo.png', 'tellybox-logo.webp']) {
	app.get('/' + file, (req, res) => {
		res.setHeader('Cache-Control', 'max-age=0, must-revalidate');
		res.sendFile(path.join(root, 'public', file));
	});
}
// Maintenance state is created before the viewer gate so the public status can
// be read by signed-out callers; the gate itself is installed after installAuth.
app.get('/api/maintenance', (req, res) => {
	res.set('Cache-Control', 'no-store');
	res.json({ ...maintenance.read(), message: MAINTENANCE_MESSAGE });
});
const auth = installAuth(app, {
	installationCapabilities: {...features,managedInstallation:process.env.HOMELAB==='1',publicOrigin:process.env.PUBLIC_ORIGIN||'',assetCdnOrigin:artworkCdnOrigin||assetCdnOrigin||''},
	audit: activity,
	uploadLimit,playbackDefaults,pausedTimeout,accountLimits,remoteControls,serverHealth,
	validShareOwner: shares.validOwner,
	instanceId,
	localPlaybackOrigin,
	tunnelStatus: async () => ({ ...await remoteAccessStatus(process.env.PUBLIC_ORIGIN || '', process.env.QUICK_TUNNEL_METRICS || 'http://quick-tunnel:2000'), homeAccess: homeNetwork.status() }),
	homeNetwork,
	homeScope: req => authHomeScopeFingerprint(req),
	homeTrustedProxy: process.env.HOME_TRUSTED_PROXY || '',
	trustedProxies: (process.env.TRUSTED_PROXIES || '').split(',').filter(Boolean),
	clientIpHeader: process.env.CLIENT_IP_HEADER || 'cf-connecting-ip',
	onRevoke: owner => {
		for (const session of sessions.values()) if (session.owner !== 'local' && (owner === null || session.owner === owner)) void stop(session,{relayRevoke:Boolean(session.relayLeaseId)});
	},
	directory: process.env.AUTH_DIR || path.join(root, 'auth-data'),
	publicDirectory: path.join(root, 'public'), localPort: Number(process.env.PORT || 8082),
	publicOrigin: process.env.PUBLIC_ORIGIN || '',
	localNetworks: (process.env.LOCAL_NETWORKS || '').split(',').filter(Boolean),
	localHosts: (process.env.LOCAL_HOSTS || 'localhost,127.0.0.1').split(',').filter(Boolean)
});

// Maintenance mode. Registered after the auth gate so an administrator is
// always identifiable and always able to switch it back off.
// Locality alone is not an administrator identity (a LAN viewer must still be
// blocked). Only an admin app, or an owner session away from the local entry,
// bypasses maintenance. The local settings surface stays usable so the switch
// can always be reached, along with the static assets it needs.
const LOCAL_ADMIN_SURFACE = /^\/(?:settings|people|apps|login|api\/maintenance|api\/auth|api\/apps|api\/people)(?:\/|$)/;
const STATIC_ASSET = /\.(?:js|css|png|webp|svg|ico|woff2?)$/i;
app.use(maintenance.middleware({
	classify: req => (auth.isLocal(req) || auth.isHome(req)) ? 'local' : 'remote',
	admin: req => req.jserverApp?.role === 'admin'
		|| (!auth.isLocal(req) && auth.isOwnerAdmin(req))
		|| (auth.isLocal(req) && (LOCAL_ADMIN_SURFACE.test(req.path) || STATIC_ASSET.test(req.path)))
}));
app.post('/api/maintenance', (req, res) => {
	if (!auth.isOwnerAdmin(req)) return res.status(403).json({ error: 'Maintenance can be changed by an administrator only.' });
	if (!req.is('application/json') || req.get('origin') !== req.jserverOrigin) return res.sendStatus(403);
	const { enabled, scope } = req.body || {};
	if (typeof enabled !== 'boolean' || !['local', 'remote', 'both'].includes(scope)) {
		return res.status(400).json({ error: 'Choose local, remote or both, and whether maintenance is on.' });
	}
	const identity = auth.identity(req);
	const state = maintenance.write({ enabled, scope }, identity.personName || identity.ip || 'admin');
	activity.record('maintenance_changed', identity, { enabled: state.enabled, scope: state.scope });
	// Turning it on is meant to cut people off, but only the people the chosen
	// scope covers. A remote-only activation must leave local playback alone;
	// "both" is the deliberate full stop.
	const atHome = session => session.viewer?.local === true || session.viewer?.home === true;
	if (state.enabled) {
		for (const session of [...sessions.values()]) {
			const applies = state.scope === 'both' ? true : state.scope === 'remote' ? !atHome(session) : atHome(session);
			if (applies) {
				// A maintenance stop must never take the server down with it. stop()
				// can reject when a relay worker is already unreachable, which is
				// exactly the situation maintenance exists for. The session is still
				// refused by the maintenance gate on its next request.
				stop(session, { relayRevoke: Boolean(session.relayLeaseId) }).catch(() => {});
			}
		}
	}
	res.json({ ...state, message: MAINTENANCE_MESSAGE });
});

app.use((req, res, next) => {
	const disabled = (!features.discover && /^\/(?:api\/discover|discover)(?:\/|$)/.test(req.path))
		|| (!features.recordings && /^\/api\/recordings(?:\/|$)/.test(req.path))
		|| (!features.catchup && /^\/api\/catchup(?:\/|$)/.test(req.path));
	if (disabled) return res.status(503).json({error:'This feature is disabled in installation settings.'});
	next();
});

app.use((req, res, next) => {
	if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && req.headers.origin !== req.jserverOrigin && req.headers.origin !== process.env.PUBLIC_ORIGIN) {
		return res.status(403).json({ error: 'This request must come from jServer.' });
	}
	next();
});

// Coming soon links an announcement back to the copy already in the library.
// The match is made from the catalogue object the server already keeps in
// memory (vodLibrary); no extra request is made from the route and the browser
// still calls only /api/coming-soon.
const insights = insightsFromFile(path.join(path.dirname(configPath), 'insights.json'), {
	library: items => resolveComingMatches(items, {
		availability: matched => vodLibrary.availability(matched),
		episodes: seriesEpisodes
	})
});
installTvControl(app, { auth, sessions });
// Only the signed-in caller's own allowance. No person, device or other account details.
app.get('/api/viewing-status', (req, res) => {
	res.set('Cache-Control', 'no-store');
	const admin = isAdmin(req);
	res.json(accountLimits.viewing(req.jserverViewer, { admin, activeSessions: sessionLimits.count(req.jserverViewer, { admin }) }));
});
// Read-only aggregate statistics for trusted home/LAN viewers. This route
// never returns the full log or account/browser details, and it adds no write
// path. Forwarded addresses and browser hostnames are never trusted here.
app.get('/api/activity/summary', (req, res) => {
	res.set('Cache-Control', 'no-store');
	if (!auth.isOwnerAdmin(req) && !auth.isHome(req)) {
		return res.status(403).json({ error: 'Read-only activity statistics are available to installation administrators only.' });
	}
	res.json(activity.summary());
});
// Permanent media deletion. Local administrator only, preview first, and the
// caller must repeat the exact title. Jellyfin removes the entries and files.
const purgeAdmin = (req, res, next) => {
	if (!auth.isLocal(req) || !auth.isOwnerAdmin(req)) {
		return res.status(403).json({ error: 'Deleting media is available to a local installation administrator only.' });
	}
	next();
};
function purgeFailure(res, error) {
	const status = Number(error?.status) || 500;
	return res.status(status).json({ error: status >= 500 && status !== 503 ? 'The media could not be deleted.' : String(error?.message || 'The media could not be deleted.') });
}
app.get('/api/admin/purge/search', purgeAdmin, async (req, res) => {
	res.set('Cache-Control', 'no-store');
	const term = String(req.query.q || '').trim().slice(0, 200);
	if (term.length < 2) return res.json({ items: [] });
	try {
		const query = new URLSearchParams({ UserId: connection().userId, Recursive: 'true', IncludeItemTypes: 'Movie,Series,Season,Episode', SearchTerm: term, Limit: '40', Fields: 'Path,ChildCount' });
		const data = await jelly('/Items?' + query);
		res.json({ items: (data.Items || []).map(({ Id, Name, Type, ProductionYear, ChildCount, IndexNumber, ParentIndexNumber }) => ({ Id, Name, Type, ProductionYear, ChildCount, IndexNumber, ParentIndexNumber })) });
	} catch { res.status(502).json({ error: 'The library could not be searched.' }); }
});
app.get('/purge', purgeAdmin, (req, res) => res.sendFile(path.join(root, 'public', 'purge.html')));
app.get('/purge.js', purgeAdmin, (req, res) => res.sendFile(path.join(root, 'public', 'purge.js')));
app.get('/api/admin/purge/preview', purgeAdmin, async (req, res) => {
	res.set('Cache-Control', 'no-store');
	try { res.json(await jellyfinAdmin.preview(String(req.query.id || ''))); }
	catch (error) { return purgeFailure(res, error); }
});
app.post('/api/admin/purge', purgeAdmin, async (req, res) => {
	if (!req.is('application/json') || req.get('origin') !== req.jserverOrigin) return res.sendStatus(403);
	let data;
	try { data = await jellyfinAdmin.preview(String(req.body?.id || '')); }
	catch (error) { return purgeFailure(res, error); }
	if (String(req.body?.confirm || '').trim().toLowerCase() !== data.name.trim().toLowerCase()) {
		return res.status(400).json({ error: 'Type the title exactly to confirm the deletion.' });
	}
	const playing = activity.snapshot().active.filter(entry => entry.purpose !== 'download' && entry.state !== 'stopped'
		&& (String(entry.itemId) === String(data.id) || data.episodeIds.some(id => String(id) === String(entry.itemId))));
	if (playing.length) return res.status(409).json({ error: 'Stop playback of that title before deleting it.' });
	try { await jellyfinAdmin.remove(data.id); }
	catch (error) { return purgeFailure(res, error); }
	try { metadataCache.clear(); discoveryLibraryCache.clear(); } catch {}
	activity.record('media_purged', auth.identity(req), { itemId: data.id, name: data.name, type: data.type, count: data.count });
	res.json({ ok: true, ...data });
});
function dispatcharrAdmin(req, res, next) {
	if (!auth.isLocal(req) || req.get('authorization') || req.get('x-jserver-app')) return res.status(403).json({error:'Open the local Tellybox settings to manage Dispatcharr.'});
	if (req.method !== 'GET' && (!req.is('application/json') || req.get('origin') !== req.jserverOrigin)) return res.sendStatus(403);
	next();
}
app.get('/api/dispatcharr/connection', dispatcharrAdmin, (req,res) => res.json(dispatcharr.status()));
app.post('/api/dispatcharr/connection', dispatcharrAdmin, async (req,res) => res.json(await dispatcharr.connect(req.body)));
app.get('/api/subtitles/connection',dispatcharrAdmin,async(req,res)=>res.json(await subtitleLookup.status()));
app.post('/api/subtitles/connection',dispatcharrAdmin,async(req,res)=>res.json(await subtitleLookup.connect(req.body)));
app.get('/api/dispatcharr/guide-health', dispatcharrAdmin, async (req,res) => {
	const guide = await dispatcharrGuide();
	res.json({updated:guide.fetchedAt, available:guide.available, stale:guide.stale, total:guide.channels.length, current:guide.current || 0,
		missing:guide.channels.filter(c=>!c.programmes.length).map(c=>({name:c.Name,number:c.ChannelNumber})), conflicts:guide.conflicts || 0, sharedSchedules:guide.sharedSchedules || []});
});
function shareItemId(value) {
	if (/^dispatch-live-[a-f0-9-]{36}$/i.test(String(value||''))) return value;
	return itemId(value);
}
async function shareItem(id) {
	if (id.startsWith('dispatch-live-')) {
		const channel=(await dispatcharr.channels()).find(c=>'dispatch-live-'+c.id===id);
		if (!channel) throw Object.assign(Error('This channel is no longer available.'),{status:404});
		return channelView(channel);
	}
	return jelly(`/Users/${connection().userId}/Items/${id}`);
}
app.get('/api/shares/:item', (req, res) => res.json({ shares: shares.list(shareItemId(req.params.item)) }));
app.post('/api/shares', async (req, res) => {
	if (!req.is('application/json') || req.get('origin') !== req.jserverOrigin) return res.sendStatus(403);
	const origin = process.env.PUBLIC_ORIGIN || '';
	if (!origin.startsWith('https://')) return res.status(409).json({ error: 'Set up the secure public address before sharing.' });
	const item = await shareItem(shareItemId(req.body.id));
	const share = shares.create(item, req.jserverOwner, req.body.hours);
	activity.record('share_created', req.jserverViewer, { title: share.title, shareId: share.id });
	res.status(201).json({ id: share.id, url: new URL('/share/' + share.token, origin).href, expires: share.expires });
});
app.post('/api/shares/:id/revoke', (req, res) => {
	if (!req.is('application/json') || req.get('origin') !== req.jserverOrigin) return res.sendStatus(403);
	shares.revoke(req.params.id);
	activity.record('share_revoked', req.jserverViewer, { shareId: req.params.id });
	res.json({ ok: true });
});
const discoveryLibraryCache = new Map();
async function discoveryLibrary(genres) {
	const batches = await Promise.all(genres.map(async genre => {
		let entry = discoveryLibraryCache.get(genre);
		if (!entry || Date.now() > entry.expires) {
			const query = new URLSearchParams({ UserId:connection().userId, Recursive:'true', IncludeItemTypes:'Movie,Series', Genres:genre, Fields:'Genres,ProviderIds,Overview', SortBy:'CommunityRating,SortName', SortOrder:'Descending', Limit:'60' });
			entry = { expires:Date.now()+180000, promise:jelly('/Items?' + query) }; discoveryLibraryCache.set(genre, entry);
		}
		try { return (await entry.promise).Items || []; } catch (error) { discoveryLibraryCache.delete(genre); throw error; }
	}));
	return batches.flat().filter(item => /^[1-9][0-9]{0,9}$/.test(item.ProviderIds?.Tmdb || '') && !item.IsVirtualItem).map(item => mediaView({ id:Number(item.ProviderIds.Tmdb), title:item.Name, overview:item.Overview, genres:item.Genres || [], releaseDate:item.PremiereDate, voteAverage:item.CommunityRating, mediaInfo:{ status:5, jellyfinMediaId:item.Id } }, item.Type === 'Series' ? 'tv' : 'movie'));
}
const seerr=installSeerr(app, { configPath: path.join(path.dirname(configPath), 'seerr.json'), audit: activity.record, enrich:async items=>vodLibrary.availability(await insights.enrich(items)), library:discoveryLibrary,
	discoverBusy: () => backgroundBusy(),
	discoverCachePath: path.join(process.env.CATALOGUE_CACHE_DIR || process.env.AUTH_DIR || path.join(root,'auth-data'),'discover-public-cache.json') });
app.get('/api/coming-soon', async (req, res) => {
	res.set('Cache-Control', 'no-store');
	const upcoming = await insights.upcoming();
	// Sport is additive and must never break the page: on any problem the rail
	// is empty and flagged unavailable, while the tv/movies fields are unchanged.
	// The football rail and the all-sports spine are merged (deduped by kick-off
	// + title) and the Q80 admin settings are applied server-side. When the rail
	// is disabled the sport field is empty and not flagged unavailable.
	let sport = [], sportUnavailable = false;
	try {
		const settings = sportSettings.status();
		if (settings.enabled !== false) {
			const [football, allSport] = await Promise.all([sportListings.listings(), liveSportOntv.listings()]);
			sport = applySportSettings(mergeSportRails(football, allSport), settings);
			sportUnavailable = sportListings.unavailable() && liveSportOntv.unavailable();
		}
	}
	catch { sportUnavailable = true; }
	res.json({ ...upcoming, sport, ...(sportUnavailable ? { sportUnavailable: true } : {}) });
});
// Sport settings (Q80). Any authenticated/local viewer may read; only a local
// installation administrator may write, via the same local-settings gate the
// Dispatcharr connection uses (local entry, no app token, same-origin JSON).
app.get('/api/sport-settings', (req, res) => {
	res.set('Cache-Control', 'no-store');
	res.json(sportSettings.status());
});
function sportSettingsAdmin(req, res, next) {
	if (!auth.isLocal(req) || req.get('authorization') || req.get('x-jserver-app')) {
		return res.status(403).json({ error: 'Open the local Tellybox settings to manage sport listings.' });
	}
	if (!req.is('application/json') || req.get('origin') !== req.jserverOrigin) return res.sendStatus(403);
	next();
}
app.post('/api/sport-settings', sportSettingsAdmin, (req, res) => {
	try {
		const result = sportSettings.set(req.body || {});
		activity.record('sport_settings_changed', auth.identity(req), { enabled: result.enabled, sports: result.sports, football: result.football });
		res.json(result);
	} catch (error) {
		res.status(error.status || 500).json({ error: error.status ? error.message : 'Sport settings could not be saved.' });
	}
});

function connection() {
	if (!features.jellyfin) return {userId:'',token:''};
	try { return JSON.parse(readFileSync(configPath, 'utf8')); }
	catch { throw Object.assign(new Error('Jellyfin is not connected yet. Finish the server setup first.'), { status: 503 }); }
}

function headers(device = 'jimboserver-library') {
	return {
		Authorization: `MediaBrowser Client="jServer", Device="Guest browser", DeviceId="${device}", Version="1.0.0"`,
		'X-Emby-Token': connection().token,
		'Content-Type': 'application/json'
	};
}

async function jelly(route, { method = 'GET', body, device } = {}) {
	if (!features.jellyfin) {
		if (method === 'GET' && (/^\/Items\?/.test(route) || /\/Views(?:\?|$)/.test(route))) return {Items:[],TotalRecordCount:0};
		throw Object.assign(Error('Jellyfin is disabled in installation settings.'), {status:503});
	}
	const response = await fetch(new URL(route, upstream), {
		method, headers: headers(device), body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(45000), redirect: 'error'
	});
	if (!response.ok) {
		const message = response.status === 401 ? 'The Jellyfin connection has expired. Reconnect jServer.' : `Jellyfin returned ${response.status}. Please try again.`;
		throw Object.assign(new Error(message), { status: response.status === 401 ? 503 : 502 });
	}
	return response.status === 204 ? null : response.json();
}

const idPattern = /^[a-f0-9-]{32,36}$/i;
function itemId(value) {
	if (!idPattern.test(value || '')) throw Object.assign(new Error('Invalid media item.'), { status: 400 });
	return value;
}

function itemView(item) {
	const result = {};
	for (const key of ['Id', 'Name', 'Type', 'MediaType', 'CollectionType', 'Overview', 'ProductionYear', 'PremiereDate', 'DateCreated', 'ProviderIds', 'OfficialRating', 'CommunityRating', 'RunTimeTicks', 'Genres', 'IndexNumber', 'ParentIndexNumber', 'SeriesName', 'SeriesId', 'Album', 'Artists', 'ImageTags', 'BackdropImageTags', 'ParentBackdropItemId', 'ParentBackdropImageTags', 'PrimaryImageAspectRatio', 'ChildCount', 'CurrentProgram', 'UserData', 'IsMissing', 'IsUnaired', 'IsVirtualItem']) {
		if (item[key] !== undefined) result[key] = item[key];
	}
	if (item.CurrentProgram) result.CurrentProgram = { Name: item.CurrentProgram.Name, Overview: item.CurrentProgram.Overview };
	if (['Movie', 'Series'].includes(item.Type)) result.Ratings = [score('Viewer score', item.CommunityRating), score('Critics', item.CriticRating, 100)].filter(Boolean);
	const trailer = trailerView({ remoteTrailers: item.RemoteTrailers });
	if (trailer) result.Trailer = trailer;
	return result;
}

// The New-episodes rail is built on the client from the releases endpoint, so
// its cards never pass through the Home artwork warmer. Point each episode at
// the same parent-series artwork the Home rails already use: a warm public
// TMDB poster when the catalogue has one, otherwise the existing local series
// image route. No metadata is requested here and no artwork path is invented.
const VOD_SERIES_ARTWORK = /^\/api\/web\/art\/series\/[1-9]\d{0,9}(?:\?[^#]*)?$/;
function seriesArtworkIndex(catalogue) {
	const index = new Map();
	for (const item of Array.isArray(catalogue) ? catalogue : []) {
		if (!item || item.Type !== 'Series' || typeof item.Id !== 'string' || !item.Id) continue;
		const entry = { id: item.Id,
			artwork: typeof item.Artwork === 'string' ? item.Artwork : '',
			backdrop: typeof item.BackdropArtwork === 'string' ? item.BackdropArtwork : '',
			local: item.Source === 'local',
			// Only a parent with real image evidence may replace an episode's
			// artwork/backdrop. A missing tag is unknown, not an image route.
			hasPrimary: Boolean(item.ImageTags?.Primary)
				|| (typeof item.Artwork === 'string' && /^\/images\//i.test(item.Artwork)),
			hasBackdrop: Boolean(Array.isArray(item.BackdropImageTags) && item.BackdropImageTags.length)
				|| (typeof item.BackdropArtwork === 'string' && /^\/images\//i.test(item.BackdropArtwork)) };
		index.set(item.Id.toLowerCase(), entry);
		for (const vodId of Array.isArray(item.VodIds) ? item.VodIds : []) {
			index.set(('dispatch-series-' + vodId).toLowerCase(), entry);
		}
	}
	return index;
}
// Bounded parent-series metadata warm for the New-episodes rail. Home warms
// only the rows it returns; a show that appears only in this client-built rail
// would otherwise keep the provider route that answered 404 live. This asks the
// same existing metadata service, at most 24 shows, waits no longer than the
// route's own 200 ms slice, and never invents a poster.
const EPISODE_ARTWORK_LIMIT = 24;
const EPISODE_ARTWORK_WAIT_MS = 200;
async function warmEpisodeSeries(episodes, catalogue, deadline) {
	const byId = new Map();
	for (const item of Array.isArray(catalogue) ? catalogue : []) {
		if (!item || item.Type !== 'Series' || typeof item.Id !== 'string' || !item.Id) continue;
		byId.set(item.Id.toLowerCase(), item);
		for (const vodId of Array.isArray(item.VodIds) ? item.VodIds : []) {
			byId.set(('dispatch-series-' + vodId).toLowerCase(), item);
		}
	}
	const parents = [];
	for (const episode of Array.isArray(episodes) ? episodes : []) {
		if (parents.length >= EPISODE_ARTWORK_LIMIT) break;
		const item = byId.get(String(episode?.SeriesId || '').toLowerCase());
		if (item && !parents.includes(item)) parents.push(item);
	}
	if (!parents.length) return catalogue;
	const waitMs = Math.max(0, Math.min(EPISODE_ARTWORK_WAIT_MS, Number(deadline) - Date.now()));
	try {
		const enriched = await vodMetadata.enrich(parents, { waitMs });
		return Array.isArray(enriched) && enriched.length ? [...catalogue, ...enriched] : catalogue;
	} catch {
		return catalogue;
	}
}
const parentSeriesArtwork = /^\/api\/web\/tmdb-art\/tv\/\d+\/poster$/;
const parentSeriesBackdrop = /^\/api\/web\/tmdb-art\/tv\/\d+\/backdrop$/;
const localSeriesId = /^[a-f0-9-]{32,36}$/i;
function episodeParentArtwork(view, episode, index) {
	const seriesId = typeof episode?.SeriesId === 'string' ? episode.SeriesId : '';
	if (!seriesId) return view;
	const parent = index.get(seriesId.toLowerCase()) || null;
	if (!parent) return view;
	// A local library episode merged with a streamed duplicate inherits the
	// provider's `/api/web/art/series/<vodId>` alias. That route reads the
	// provider row (which often has no logo/TMDB id) and answered 404 for every
	// reported local title, shadowing the show's working Jellyfin poster.
	// A local parent's own image is the correct source; keep an episode's own
	// `/images/...` still when it has one.
	if (parent.local) {
		const ownPrimary = typeof episode?.ImageTags?.Primary === 'string' && episode.ImageTags.Primary
			&& localSeriesId.test(String(episode.Id || '')) ? String(episode.Id) : '';
		if (localSeriesId.test(parent.id) && (!view.Artwork || VOD_SERIES_ARTWORK.test(view.Artwork))) {
			// Use a real local still or a parent whose Primary tag/route exists.
			// If neither is known, keep the provider route instead of replacing a
			// working remote poster with an invented local route.
			if (ownPrimary) view.Artwork = '/images/' + ownPrimary + '/Primary?width=400';
			else if (parent.hasPrimary) view.Artwork = '/images/' + parent.id + '/Primary?width=400';
		}
		if (!view.BackdropArtwork && localSeriesId.test(parent.id)) {
			// A backdrop is only selected when the parent actually has one. The
			// client falls back to the poster otherwise; inventing a route here
			// produced a blank card when the show had no backdrop.
			if (parentSeriesBackdrop.test(parent.backdrop)) view.BackdropArtwork = parent.backdrop;
			else if (parent.hasBackdrop) view.BackdropArtwork = '/images/' + parent.id + '/Backdrop?width=1280';
		}
		return view;
	}
	if (parentSeriesArtwork.test(parent.artwork)) view.Artwork = parent.artwork;
	else if (!view.Artwork && !view.ImageTags?.Primary && parent.hasPrimary && localSeriesId.test(parent.id)) {
		// A Jellyfin-backed parent with a real Primary tag can supply its own
		// image route. Only a GUID id may become a route, so a provider id is
		// never turned into an invented URL. An episode with its own still keeps
		// it: the client defaults to /images/<episode>/Primary when Artwork is
		// empty.
		view.Artwork = '/images/' + parent.id + '/Primary?width=400';
	}
	const ownBackdrop = Array.isArray(view.BackdropImageTags) && view.BackdropImageTags.length > 0;
	if (!view.BackdropArtwork && parentSeriesBackdrop.test(parent.backdrop)) view.BackdropArtwork = parent.backdrop;
	else if (!view.BackdropArtwork && !ownBackdrop && parent.hasBackdrop && localSeriesId.test(parent.id)) {
		view.BackdropArtwork = '/images/' + parent.id + '/Backdrop?width=1280';
	}
	return view;
}
async function libraryItems(items) {
	const scores = items.some(i => i.Type === 'Movie') ? await insights.ratings() : new Map();
	return items.map(item => {
		const view = itemView(item);
		const ratings = item.Type === 'Movie' ? scores.get(String(item.ProviderIds?.Tmdb)) : null;
		if (ratings?.length) view.Ratings = ratings;
		return view;
	});
}

const nonstopMetadata=createNonstopMetadata({search:seerr.channelSearch,file:path.join(process.env.CATALOGUE_CACHE_DIR || process.env.AUTH_DIR || path.join(root,'auth-data'),'nonstop-metadata.json')});
const vodMetadata=createVodMetadata({lookup:seerr.catalogueMetadata,file:path.join(process.env.CATALOGUE_CACHE_DIR || process.env.AUTH_DIR || path.join(root,'auth-data'),'vod-metadata.json')});
// Home warms only the bounded cards it actually returns. The existing metadata
// queue supplies concurrency, dedupe, error backoff and persistence; this
// selector never fetches anything itself.
const homeArtwork=createHomeArtwork({metadata:vodMetadata});
// In-memory only: the unresolved visible candidates of one viewer's last Home
// feed. It is scoped to this server process, the auth owner and device, and
// expires quickly. It is never written to disk and never shared across viewers.
const homeArtworkSessions=new Map();
const HOME_ARTWORK_SESSION_TTL=5*60*1000;
const HOME_ARTWORK_SESSION_MAX=200;
function homeSourceFingerprint(){
	// In-memory scope only. Hash the two small source/config files so an
	// in-process Dispatcharr key/refresh or Jellyfin reconnect cannot reuse an
	// older artwork session. The digest is never logged or persisted.
	const files=[path.join(process.env.AUTH_DIR || path.join(root,'auth-data'),'dispatcharr.json'),configPath];
	const hash=createHash('sha256');
	for(const file of files){
		try{hash.update(readFileSync(file));}catch{hash.update('\0');}
		hash.update('\0');
	}
	return hash.digest('hex').slice(0,24);
}
function homeArtworkSessionKey(req,shared){
	const viewer=req.jserverViewer||{};
	const device=String(viewer.deviceId||viewer.browserId||viewer.ip||'');
	return [instanceId,homeSourceFingerprint(),features.vod?'vod':'novod',shared?'shared':'personal',
		String(req.jserverOwner||'anonymous'),device].join('|');
}
function homeArtworkIdentity(item){
	return {Id:item.Id,Type:item.Type,Source:item.Source,
		ProviderIds:{...(item.ProviderIds?.Tmdb?{Tmdb:item.ProviderIds.Tmdb}:{}),...(item.ProviderIds?.Imdb?{Imdb:item.ProviderIds.Imdb}:{})},
		Artwork:item.Artwork,BackdropArtwork:item.BackdropArtwork};
}
function rememberHomeArtworkSession(req,shared,feed,permitted){
	const items=homeArtworkCandidates(feed,{limit:96,permitted}).map(homeArtworkIdentity);
	const key=homeArtworkSessionKey(req,shared);
	homeArtworkSessions.delete(key);
	if(!items.length)return;
	homeArtworkSessions.set(key,{time:Date.now(),items});
	while(homeArtworkSessions.size>HOME_ARTWORK_SESSION_MAX)
		homeArtworkSessions.delete(homeArtworkSessions.keys().next().value);
}
const vodLibrary=createVodLibrary({dispatcharr,metadata:vodMetadata,file:path.join(process.env.CATALOGUE_CACHE_DIR || process.env.AUTH_DIR || path.join(root,'auth-data'),'vod-catalogue.json'),
	linksFile:path.join(process.env.CATALOGUE_CACHE_DIR || process.env.AUTH_DIR || path.join(root,'auth-data'),'series-links.json'),
	localItems:async()=>{
		if (!features.jellyfin) return [];
		const items=[];
		for(let start=0;start<100000;start+=1000){
			const query=new URLSearchParams({UserId:connection().userId,Recursive:'true',IncludeItemTypes:'Movie,Series',LocationTypes:'FileSystem',IsMissing:'false',Fields:'Overview,Genres,ProviderIds,DateCreated,PrimaryImageAspectRatio,IsMissing,ChildCount',Limit:'1000',StartIndex:String(start)});
			const data=await jelly('/Items?'+query);items.push(...(data.Items||[]).filter(i=>!i.IsVirtualItem&&i.IsMissing!==true&&(i.Type!=='Series'||Number(i.ChildCount)!==0)));
			if(!data.Items?.length||items.length>=data.TotalRecordCount||data.Items.length<1000)break;
		}
		return libraryItems(items);
	},
	localItem:async id=>(await libraryItems([await jelly(`/Users/${connection().userId}/Items/${itemId(id)}?Fields=RemoteTrailers`)]))[0],
	localEpisodes:async id=>await seriesEpisodes(itemId(id))
});
// Bounded per-series lookup for the Home rail. It never enumerates the whole
// episode library: a local canonical id reads the merged library list (local
// plus VOD-only episodes) and only a library miss costs one scoped ParentId
// query. Upstream calls share one process-wide admission cap.
const homeEpisodeLookup=createHomeEpisodeLookup({jelly,userId:()=>connection().userId,library:vodLibrary});
// Exact unfinished episodes for Continue watching. It reuses the same bounded
// per-series lookup, shared admission and one deadline as the episode rail;
// it never enumerates the episode library.
// The single-item reader is admitted by the shared process-wide gate inside
// home-continue.mjs. Do NOT pre-wrap it in untilDeadline: the active slot must
// stay held until the real upstream settles, not until the caller's deadline.
const homeContinue=createHomeContinue({lookup:homeEpisodeLookup, resolve:(id)=>vodLibrary.item(id)});
// Remote visibility needs the catalogue, not one full merge per request. The
// snapshot holds catalogue data only; each viewer's allowance is still checked
// per request and per episode below.
const homeCatalogueSnapshot=createCatalogueSnapshot({read:()=>vodLibrary.all()});
Object.assign(artworkResolvers, {
	vodLogo: async (kind, id) => {
		const raw = await vodLibrary.raw(`dispatch-${kind}-${id}`);
		const logo = Number(raw?.data?.logo?.id);
		return Number.isSafeInteger(logo) && logo > 0 ? String(logo) : '';
	},
	tmdbPath: (type, id, kind) => vodMetadata.artwork(type, id, kind),
	tmdbRemember: (type, id, kind, path) => vodMetadata.remember(type, id, kind, path),
	channelLogo: async id => {
		try {
			const guide = await dispatcharrGuide(false);
			const channel = (guide?.channels || []).find(item => item.Id === 'dispatch-live-' + id);
			const match = /[?&]v=(\d+)/.exec(channel?.Artwork || '');
			if (match) return match[1];
		} catch {}
		try {
			const channels = await dispatcharr.channels();
			const channel = (channels || []).find(item => String(item.id).toLowerCase() === String(id).toLowerCase());
			const match = /^\/api\/channels\/logos\/(\d+)\/cache\/$/.exec(channel?.logo || '');
			return match ? match[1] : '';
		} catch {
			return '';
		}
	}
});
artworkOriginHandler = createArtworkOrigin({ cdn: artworkCdn, upstream, headers, dispatcharr, vodLibrary, proxyImage });
app.get('/api/web/items',async(req,res)=>res.json(await vodLibrary.list(req.query)));
// Home series verification gets a shorter slice than the whole request so a
// slow Continue answer cannot extend the route; the catalogue merge and the
// remaining Continue work share the rest of the request budget.
const HOME_FEED_DEADLINE_MS = 1000;
// Resolve the normal Home rails against saved availability. Every series is
// attempted at most once per request (`attempted`); a series that cannot be
// proven inside the shared deadline stays hidden instead of being retried in
// every round, which used to burn the whole feed budget on the same slow ids.
// `pass` and the returned state/attempted maps let the route verify rows while
// Continue resolves, then rebuild once with Continue's exact episodes.
async function buildPlayableHomeFeed({ items, build, budget = 36, deadlineMs = 3500, timing = null,
	pass = 1, states: initialStates = null, attempted: initialAttempted = null, checked: checkedBefore = 0 }) {
	// A verification round is only worth starting when this much budget remains.
	// Starting a provider read with a few milliseconds left cannot finish inside
	// the request and would leave unbounded upstream work behind an expired budget.
	const minWindowMs = 50;
	const states = initialStates instanceof Map ? initialStates : new Map();
	const attempted = initialAttempted instanceof Set ? initialAttempted : new Set();
	// An explicit deadline is remaining time, not a hint: 0 or a negative value
	// means the request budget is already spent. Never revive it with a minimum;
	// only a missing/invalid value falls back to the default budget.
	const requestedDeadline = Number(deadlineMs);
	const overall = Date.now() + (Number.isFinite(requestedDeadline) ? requestedDeadline : 3500);
	let remaining = Math.max(0, Number(budget) || 0);
	let candidates = items;
	let buildMs = 0, verifyMs = 0, buildCount = 0;
	const buildStart = performance.now();
	let feed = build(candidates);
	buildMs += performance.now() - buildStart; buildCount++;
	let checked = 0;
	// Merge the saved availability before anything else. It is a network-free
	// cache read, so an already-expired budget still keeps every proven card
	// (and Continue membership) instead of emptying the rails.
	const mergeCachedStates = () => {
		for (const [id, state] of vodLibrary.cachedStates(feedSeriesIds(feed))) states.set(id, state);
	};
	mergeCachedStates();
	for (let round = 0; round < 4 && remaining > 0 && Date.now() < overall; round++) {
		// A parallel Continue lookup can prove a series after this pass started.
		// Re-read the saved index (no network) before deciding what is still unknown.
		mergeCachedStates();
		const ids = feedSeriesIds(feed).filter(id => states.get(id) !== 'available' && !attempted.has(id));
		if (!ids.length) break;
		// The budget can expire between rounds; no upstream verification may start
		// after it does, and a window too small to finish is not started either.
		const windowMs = overall - Date.now();
		if (!(windowMs >= minWindowMs)) break;
		for (const id of ids) attempted.add(id);
		const priority = (feed.rows || []).find(row => row.id === 'new')?.items?.filter(item => item?.Type === 'Series').map(item => item.Id) || [];
		const verifyStart = performance.now();
		const result = await vodLibrary.verifySeries(ids, {
			limit: Math.min(24, remaining),
			deadlineMs: Math.min(1500, windowMs),
			concurrency: 4,
			priority
		});
		const verifyRoundMs = performance.now() - verifyStart;
		verifyMs += verifyRoundMs;
		if (timing) timing.verifyRounds.push({ pass, ms: Math.round(verifyRoundMs), ids: ids.length,
			checked: result.checked, pending: result.pending, limit: result.limit });
		for (const [id, state] of result.states) states.set(id, state);
		checked += result.checked;
		remaining -= result.checked;
		// Remove every selected series that is not proven playable so the next
		// build selects replacement candidates, which are checked on the next
		// round instead of being trusted blindly.
		const remove = new Set(feedSeriesIds(feed).filter(id => states.get(id) !== 'available'));
		if (!remove.size) break;
		candidates = candidates.filter(item => item.Type !== 'Series' || !remove.has(item.Id));
		const rebuildStart = performance.now();
		feed = build(candidates);
		buildMs += performance.now() - rebuildStart; buildCount++;
		if (!result.checked) break;
	}
	const finalBuildStart = performance.now();
	feed = build(candidates.filter(item => item.Type !== 'Series' || states.get(item.Id) === 'available'));
	buildMs += performance.now() - finalBuildStart; buildCount++;
	// Count what the SERVED feed contains, not what the pre-filter feed held.
	// The final build drops every series that is not proven available, so this
	// is normally zero; counting before the filter made a single unknown
	// candidate block the Home memo forever, re-running the whole pipeline on
	// every warm request.
	const pending = feedSeriesIds(feed).filter(id => states.get(id) !== 'available').length;
	if (timing) timing.feedBuild = { buildMs: Math.round(buildMs), verifyMs: Math.round(verifyMs),
		buildCount, checked: checkedBefore + checked, pending };
	return { feed, states, attempted, checked: checkedBefore + checked, pending,
		buildMs, verifyMs, buildCount };
}
function feedSeriesIds(feed) {
	return [...new Set([
		...(feed.rows || []).flatMap(row => (row.items || []).filter(item => item?.Type === 'Series').map(item => item.Id)),
		...(feed.featured || []).filter(item => item?.Type === 'Series').map(item => item.Id)
	].filter(id => typeof id === 'string'))];
}

// Short-lived, in-memory memo for a completed Home build. The key includes the
// authenticated owner, the person/device, the exact body context and the
// catalogue/source fingerprint, so one viewer can never read another viewer's
// feed and a catalogue or source change misses at once. The HTTP response is
// still no-store: this is a server-side work cache, never a shared cache.
const homeFeedMemo = new Map();
const HOME_FEED_MEMO_TTL = 45 * 1000;
const HOME_FEED_MEMO_MAX = 100;
function homeFeedMemoKey(req, shared, body) {
	const viewer = req.jserverViewer || {};
	const device = String(viewer.deviceId || viewer.browserId || viewer.ip || '');
	const identity = [instanceId, String(req.jserverOwner || 'anonymous'), shared ? 'shared' : 'personal',
		String(viewer.personId || ''), device].join('|');
	const hash = createHash('sha256');
	hash.update(JSON.stringify(body.taste ?? null)); hash.update('\0');
	hash.update(JSON.stringify(Array.isArray(body.favourites) ? body.favourites : [])); hash.update('\0');
	hash.update(JSON.stringify(Array.isArray(body.watched) ? body.watched : [])); hash.update('\0');
	hash.update(JSON.stringify(body.progress && typeof body.progress === 'object' && !Array.isArray(body.progress) ? body.progress : {}));
	const catalogue = vodLibrary.status();
	return [identity, hash.digest('hex'), homeSourceFingerprint(), features.vod ? 'vod' : 'novod',
		catalogue.indexed, catalogue.lastRefresh || 0].join('|');
}
function cloneHomeFeed(feed, allowed = null) {
	const keep = item => {
		if (!allowed) return true;
		try { return allowed(item) === true; } catch { return false; }
	};
	const copy = items => (Array.isArray(items) ? items : []).filter(keep)
		.map(item => ({ ...item, ...(item.ProviderIds ? { ProviderIds: { ...item.ProviderIds } } : {}) }));
	return { ...feed,
		rows: (Array.isArray(feed.rows) ? feed.rows : []).map(row => ({ ...row, items: copy(row.items) })).filter(row => row.items.length),
		featured: copy(feed.featured) };
}
async function sendMemoizedHome(req, res, memo, shared) {
	const permitted = item => {
		try { return shared || remoteControls.allowed(req.jserverViewer, { itemId: item.Id, nonstop: false }); }
		catch { return false; }
	};
	// Permission is re-applied to the cached rows as well, so a revocation that
	// lands inside the memo TTL cannot keep a title on screen.
	const feed = cloneHomeFeed(memo.feed, shared ? null : permitted);
	let artwork = { pending: 0, requested: 0, resolved: 0, failed: 0, visible: 0, remaining: 0, limit: 0 };
	try { artwork = await homeArtwork.enrich(feed, { permitted, waitMs: 0 }); }
	catch { /* Artwork is advisory: the cached provider route still renders. */ }
	feed.availability = { pending: memo.pending, checked: 0, queued: 0, continue: memo.continue, artwork };
	if (artwork.remaining > 0) rememberHomeArtworkSession(req, shared, feed, permitted);
	res.json(feed);
}

// Catalogue, permission and watch context shared by the Home feed and its
// deferred Continue route. Synchronous: the route owns the one catalogue read
// and therefore the single absolute deadline.
function homeViewerScope(req, body, { catalogue, shared }) {
	const permitted = homeVisibleItems(catalogue, { shared, allowed: item => remoteControls.allowed(req.jserverViewer, { itemId: item.Id, nonstop: false }) });
	const history = shared ? [] : activity.history(req.jserverViewer);
	// Remote: this person/device's own activity only. Local/home: the genuinely
	// scoped home activity, never all-person history.
	const homeHistory = shared ? activity.history({ local: true, home: true }) : [];
	const context = viewerHomeContext({ items: permitted, history, shared });
	const clientWatched = shared && Array.isArray(body.watched) ? body.watched : [];
	const clientProgress = shared && body.progress && typeof body.progress === 'object' ? body.progress : {};
	// Browse rows keep the current finish state, but Continue uses only the
	// server-derived completions for a remote caller, so browser-supplied ids
	// can never create or remove a remote Continue card.
	const watched = [...clientWatched, ...context.watched];
	const progress = shared ? { ...clientProgress, ...context.progress } : { ...context.progress };
	return { permitted, history, homeHistory, context, clientWatched, clientProgress, watched, progress };
}

// A deferred Home answer carries every other rail immediately. Continue is
// explicitly pending, never empty-and-complete, so the client knows to ask the
// dedicated route instead of treating the row as finished.
function deferredContinueAvailability() {
	return { status: 'pending', reason: 'deferred', requested: 0, queried: 0, resolved: 0,
		missing: 0, denied: 0, omitted: 0, unresolved: 0, complete: false };
}
function withoutContinueFeed(feed) {
	return { ...feed,
		rows: (Array.isArray(feed.rows) ? feed.rows : []).filter(row => row?.id !== 'continue'),
		featured: (Array.isArray(feed.featured) ? feed.featured : []).filter(item => item?._reason !== 'Continue watching') };
}

// Per-viewer memo for the Continue row only. It has the same key boundary as
// the feed memo (owner, person/device, body context, catalogue/source
// fingerprint) but a separate map, so a deferred row can never be served as a
// complete feed and a deferred feed can never answer the Continue route.
// Permission is re-applied to every cached item on read.
const homeContinueMemo = new Map();
function cloneContinueRow(row) {
	return row ? { ...row, items: (Array.isArray(row.items) ? row.items : []).map(item => ({ ...item,
		...(item.ProviderIds ? { ProviderIds: { ...item.ProviderIds } } : {}),
		...(item.UserData ? { UserData: { ...item.UserData } } : {}),
		...(Array.isArray(item.VodIds) ? { VodIds: [...item.VodIds] } : {}),
		...(Array.isArray(item.Genres) ? { Genres: [...item.Genres] } : {}) })) } : null;
}
function rememberHomeContinue(req, shared, body, row, availability) {
	// A partial answer is never reused: the next Home/Continue view must try the
	// unfinished lookup again instead of freezing an incomplete row for 45 s.
	if (!availability || availability.complete !== true) return;
	const key = homeFeedMemoKey(req, shared, body) + '|continue';
	homeContinueMemo.delete(key);
	homeContinueMemo.set(key, { time: Date.now(), row: cloneContinueRow(row), availability: { ...availability } });
	while (homeContinueMemo.size > HOME_FEED_MEMO_MAX)
		homeContinueMemo.delete(homeContinueMemo.keys().next().value);
}
function readableContinueRow(req, row, shared) {
	if (!row) return null;
	const permitted = item => {
		try { return shared || remoteControls.allowed(req.jserverViewer, { itemId: item.Id, nonstop: false }); }
		catch { return false; }
	};
	const items = (Array.isArray(row.items) ? row.items : []).filter(item => item && permitted(item));
	return items.length ? { ...cloneContinueRow(row), items } : null;
}
// One Continue row from a built feed. A series-level continue card is only kept
// when saved availability already proves it, exactly like the final Home build:
// this route never waits for playability verification.
function homeContinueRow(feed) {
	const row = (Array.isArray(feed?.rows) ? feed.rows : []).find(entry => entry?.id === 'continue');
	if (!row) return null;
	const seriesIds = (Array.isArray(row.items) ? row.items : [])
		.filter(item => item?.Type === 'Series' && typeof item.Id === 'string').map(item => item.Id);
	const states = seriesIds.length ? vodLibrary.cachedStates(seriesIds) : new Map();
	const items = (Array.isArray(row.items) ? row.items : [])
		.filter(item => item?.Type !== 'Series' || states.get(item.Id) === 'available');
	return items.length ? { ...row, items } : null;
}

// The opt-in web Home: build every row except Continue, without starting (or
// waiting for) homeContinue. Its failure cannot reach this response.
async function serveDeferredHome(req, res, { body, shared, memoKey }) {
	const deferredKey = memoKey + '|deferred';
	const memo = homeFeedMemo.get(deferredKey);
	if (memo && Date.now() - memo.time <= HOME_FEED_MEMO_TTL) {
		if (process.env.TELLYBOX_HOME_TIMING === '1') res.set('X-Tellybox-Home-Timing', JSON.stringify({ memoHit: true, deferred: true, totalMs: 0 }));
		return sendMemoizedHome(req, res, memo, shared);
	}
	try {
		const timing = process.env.TELLYBOX_HOME_TIMING === '1' ? { start: performance.now(), verifyRounds: [] } : null;
		const mark = name => { if (timing) timing[name] = Math.round((performance.now() - timing.start) * 10) / 10; };
		// Same single absolute budget as the complete feed. Continue is not part
		// of this request, so nothing here waits for it.
		const homeDeadline = Date.now() + REQUEST_TIMEOUT_MS;
		const catalogue = await vodLibrary.all();
		mark('catalogueMs');
		const scope = homeViewerScope(req, body, { catalogue, shared });
		const build = items => buildHomeFeed({ items, taste: body.taste, favourites: body.favourites,
			watched: scope.watched, progress: scope.progress, history: scope.history,
			continueWatched: scope.context.watched, episodeContinue: [], episodeSeriesIds: [], continueUpdated: {} });
		const result = await buildPlayableHomeFeed({ items: scope.context.items, build, timing, pass: 1,
			deadlineMs: Math.min(HOME_FEED_DEADLINE_MS, homeDeadline - Date.now()) });
		mark('feedMs');
		const feed = withoutContinueFeed(result.feed);
		const permitted = item => {
			try { return shared || remoteControls.allowed(req.jserverViewer, { itemId: item.Id, nonstop: false }); }
			catch { return false; }
		};
		let artwork = { pending: 0, requested: 0, resolved: 0, failed: 0, visible: 0, remaining: 0, limit: 0 };
		try { artwork = await homeArtwork.enrich(feed, { permitted, waitMs: 0 }); }
		catch { /* Artwork is advisory: Home still renders the provider route. */ }
		mark('artworkMs');
		feed.availability = { pending: result.pending, checked: result.checked, queued: 0,
			continue: deferredContinueAvailability(), artwork };
		feed.continuePending = true;
		if (result.pending === 0 && Array.isArray(feed.rows) && feed.rows.length) {
			homeFeedMemo.delete(deferredKey);
			homeFeedMemo.set(deferredKey, { time: Date.now(), feed: cloneHomeFeed(feed), pending: result.pending,
				continue: feed.availability.continue });
			while (homeFeedMemo.size > HOME_FEED_MEMO_MAX)
				homeFeedMemo.delete(homeFeedMemo.keys().next().value);
		}
		if (artwork.remaining > 0) rememberHomeArtworkSession(req, shared, feed, permitted);
		if (timing) {
			timing.totalMs = Math.round((performance.now() - timing.start) * 10) / 10;
			timing.deferred = true;
			res.set('X-Tellybox-Home-Timing', JSON.stringify(timing));
		}
		res.json(feed);
	} catch (error) {
		res.status(error.status || 500).json({ error: error.status ? error.message : 'Recommendations are unavailable just now. Please try again.' });
	}
}

app.post('/api/web/home', async (req, res) => {
	res.set('Cache-Control', 'no-store');
	if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
	const body = req.body && typeof req.body === 'object' ? req.body : {};
	if (body.favourites !== undefined && (!Array.isArray(body.favourites) || body.favourites.length > 1000)) return res.status(400).json({ error: 'Invalid favourites context.' });
	if (body.watched !== undefined && (!Array.isArray(body.watched) || body.watched.length > 5000)) return res.status(400).json({ error: 'Invalid watched context.' });
	if (body.progress !== undefined && (!body.progress || typeof body.progress !== 'object' || Array.isArray(body.progress))) return res.status(400).json({ error: 'Invalid progress context.' });
	if (!accountLimits.allowed(req.jserverViewer, false)) return res.json({ personalized: false, coldStart: true, restricted: true,
		reason: accountLimits.reason(req.jserverViewer, false), rows: [], featured: [], availability: { pending: 0, checked: 0 } });
	const shared = auth.isLocal(req) || auth.isHome(req);
	// The memo key includes the restored index state. Wait for the one-time disk
	// restore first: otherwise the first request after a restart writes a memo
	// under a zero-state key that the next request can never hit, costing one
	// full rebuild per process start.
	await vodLibrary.ready();
	const memoKey = homeFeedMemoKey(req, shared, body);
	// The web client opts into a two-response Home: every other row first, then
	// Continue from its own route. Native/TV/phone callers send no flag and keep
	// the single complete response below byte for byte.
	if (body.deferContinue === true) return serveDeferredHome(req, res, { body, shared, memoKey });
	const memo = homeFeedMemo.get(memoKey);
	if (memo && Date.now() - memo.time <= HOME_FEED_MEMO_TTL) {
		if (process.env.TELLYBOX_HOME_TIMING === '1') res.set('X-Tellybox-Home-Timing', JSON.stringify({ memoHit: true, totalMs: 0 }));
		return sendMemoizedHome(req, res, memo, shared);
	}
	try {
		const timing = process.env.TELLYBOX_HOME_TIMING === '1' ? { start: performance.now(), verifyRounds: [] } : null;
		const mark = name => { if (timing) timing[name] = Math.round((performance.now() - timing.start) * 10) / 10; };
		// One absolute budget starts here, before the catalogue merge, and covers
		// everything the request may wait for: catalogue, Continue and playable
		// series verification. An expired budget never restarts work.
		const homeDeadline = Date.now() + REQUEST_TIMEOUT_MS;
		const catalogue = await vodLibrary.all();
		mark('catalogueMs');
		const { context, history, homeHistory, clientWatched, clientProgress, watched, progress } =
			homeViewerScope(req, body, { catalogue, shared });
		// Continue resolves exact episodes with the same per-series lookup the
		// feed uses, so both start together and the route waits for the slower one
		// instead of paying Continue plus feed verification in series. The first
		// feed pass has a shorter slice so a slow Continue answer cannot extend
		// the whole route.
		const continueStart = performance.now();
		const continuePromise = homeContinue({
			items: context.items,
			history,
			homeHistory,
			shared,
			watched: context.watched,
			clientWatched,
			clientProgress,
			allowed: item => remoteControls.allowed(req.jserverViewer, { itemId: item.Id, nonstop: false }),
			deadline: homeDeadline
		}).then(value => {
			if (timing) timing.continueMs = Math.round((performance.now() - continueStart) * 10) / 10;
			return value;
		});
		const provisionalBuild = items => buildHomeFeed({ items, taste: body.taste, favourites: body.favourites, watched, progress, history,
			continueWatched: context.watched,
			episodeContinue: [], episodeSeriesIds: [], continueUpdated: {} });
		const [provisional, continueWatching] = await Promise.all([
			buildPlayableHomeFeed({ items: context.items, build: provisionalBuild, timing, pass: 1,
				deadlineMs: Math.min(HOME_FEED_DEADLINE_MS, homeDeadline - Date.now()) }),
			continuePromise
		]);
		if (timing) timing.continueStatus = continueWatching.availability;
		// Rebuild once with Continue's exact unfinished episodes. Series already
		// attempted above are not waited on again; the cached-state refresh inside
		// the builder keeps any series Continue just proved available.
		const build = items => buildHomeFeed({ items, taste: body.taste, favourites: body.favourites, watched, progress, history,
			continueWatched: context.watched,
			episodeContinue: continueWatching.episodes, episodeSeriesIds: continueWatching.seriesIds,
			continueUpdated: continueWatching.updates });
		const result = await buildPlayableHomeFeed({ items: context.items, build, timing, pass: 2,
			deadlineMs: homeDeadline - Date.now(),
			budget: Math.max(0, 36 - provisional.checked),
			states: provisional.states, attempted: provisional.attempted, checked: provisional.checked });
		if (timing) {
			const first = { buildMs: provisional.buildMs, verifyMs: provisional.verifyMs, buildCount: provisional.buildCount };
			const second = timing.feedBuild || {};
			timing.feedBuild = { buildMs: first.buildMs + (second.buildMs || 0),
				verifyMs: first.verifyMs + (second.verifyMs || 0),
				buildCount: first.buildCount + (second.buildCount || 0),
				checked: result.checked, pending: result.pending };
		}
		mark('feedMs');
		// Warm the separate Continue memo from the exact row this complete feed
		// returned, so an opted-in web client's follow-up costs no lookup.
		rememberHomeContinue(req, shared, body,
			(result.feed.rows || []).find(row => row?.id === 'continue') || null,
			continueWatching.availability);
		// Queue only the displayed streamed cards whose provider artwork can be
		// missing. The first feed never waits for metadata; the lightweight
		// /api/web/home/artwork check delivers late results to existing cards.
		const artworkPermitted = item => {
			try { return shared || remoteControls.allowed(req.jserverViewer, { itemId: item.Id, nonstop: false }); }
			catch { return false; }
		};
		let artwork = { pending: 0, requested: 0, resolved: 0, failed: 0, visible: 0, remaining: 0, limit: 0 };
		try {
			artwork = await homeArtwork.enrich(result.feed, { permitted: artworkPermitted, waitMs: 0 });
		} catch { /* Artwork is advisory: Home still renders the provider route. */ }
		mark('artworkMs');
		result.feed.availability = { pending: result.pending, checked: result.checked, queued: 0,
			continue: continueWatching.availability, artwork };
		// Only a build with a settled playability count and a complete Continue
		// answer is reused. Artwork is refreshed on every reuse, so a pending
		// artwork queue does not block the memo or hide late metadata.
		if (result.pending === 0 && continueWatching.availability?.complete !== false
			&& Array.isArray(result.feed.rows) && result.feed.rows.length) {
			homeFeedMemo.delete(memoKey);
			homeFeedMemo.set(memoKey, { time: Date.now(), feed: cloneHomeFeed(result.feed),
				pending: result.pending, continue: continueWatching.availability });
			while (homeFeedMemo.size > HOME_FEED_MEMO_MAX)
				homeFeedMemo.delete(homeFeedMemo.keys().next().value);
		}
		if (artwork.remaining > 0) rememberHomeArtworkSession(req, shared, result.feed, artworkPermitted);
		if (timing) {
			timing.totalMs = Math.round((performance.now() - timing.start) * 10) / 10;
			res.set('X-Tellybox-Home-Timing', JSON.stringify(timing));
		}
		res.json(result.feed);
	} catch (error) {
		res.status(error.status || 500).json({ error: error.status ? error.message : 'Recommendations are unavailable just now. Please try again.' });
	}
});
// The opt-in second half of the web Home: only the Continue row, resolved with
// the same viewer scoping, permission filter, memo boundary and no-store rule
// as the complete feed. Never another viewer's row: the memo key includes the
// authenticated owner, the person/device and the request-body context, and the
// cached row is permission-filtered again on every read.
app.post('/api/web/home/continue', async (req, res) => {
	res.set('Cache-Control', 'no-store');
	if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
	const body = req.body && typeof req.body === 'object' ? req.body : {};
	if (body.favourites !== undefined && (!Array.isArray(body.favourites) || body.favourites.length > 1000)) return res.status(400).json({ error: 'Invalid favourites context.' });
	if (body.watched !== undefined && (!Array.isArray(body.watched) || body.watched.length > 5000)) return res.status(400).json({ error: 'Invalid watched context.' });
	if (body.progress !== undefined && (!body.progress || typeof body.progress !== 'object' || Array.isArray(body.progress))) return res.status(400).json({ error: 'Invalid progress context.' });
	const shared = auth.isLocal(req) || auth.isHome(req);
	if (!accountLimits.allowed(req.jserverViewer, false)) return res.json({ rows: [], continuePending: false, restricted: true,
		reason: accountLimits.reason(req.jserverViewer, false), availability: { continue: deferredContinueAvailability() } });
	const memoKey = homeFeedMemoKey(req, shared, body) + '|continue';
	const memo = homeContinueMemo.get(memoKey);
	if (memo && Date.now() - memo.time <= HOME_FEED_MEMO_TTL) {
		if (process.env.TELLYBOX_HOME_TIMING === '1') res.set('X-Tellybox-Home-Timing', JSON.stringify({ memoHit: true, continue: true, totalMs: 0 }));
		const row = readableContinueRow(req, memo.row, shared);
		return res.json({ rows: row ? [row] : [], continuePending: false, availability: { continue: memo.availability } });
	}
	try {
		const timing = process.env.TELLYBOX_HOME_TIMING === '1' ? { start: performance.now() } : null;
		const mark = name => { if (timing) timing[name] = Math.round((performance.now() - timing.start) * 10) / 10; };
		const homeDeadline = Date.now() + REQUEST_TIMEOUT_MS;
		const catalogue = await vodLibrary.all();
		mark('catalogueMs');
		const scope = homeViewerScope(req, body, { catalogue, shared });
		const continueStart = performance.now();
		const continueWatching = await homeContinue({
			items: scope.context.items,
			history: scope.history,
			homeHistory: scope.homeHistory,
			shared,
			watched: scope.context.watched,
			clientWatched: scope.clientWatched,
			clientProgress: scope.clientProgress,
			allowed: item => remoteControls.allowed(req.jserverViewer, { itemId: item.Id, nonstop: false }),
			deadline: homeDeadline
		});
		if (timing) timing.continueMs = Math.round((performance.now() - continueStart) * 10) / 10;
		// Only the Continue row: this route never verifies or returns other rails.
		const feed = buildHomeFeed({ items: scope.context.items, taste: body.taste, favourites: body.favourites,
			watched: scope.watched, progress: scope.progress, history: scope.history,
			continueWatched: scope.context.watched,
			episodeContinue: continueWatching.episodes, episodeSeriesIds: continueWatching.seriesIds,
			continueUpdated: continueWatching.updates });
		const row = homeContinueRow(feed);
		rememberHomeContinue(req, shared, body, row, continueWatching.availability);
		mark('continueRowMs');
		if (timing) {
			timing.totalMs = Math.round((performance.now() - timing.start) * 10) / 10;
			res.set('X-Tellybox-Home-Timing', JSON.stringify(timing));
		}
		return res.json({ rows: row ? [row] : [], continuePending: false,
			availability: { continue: continueWatching.availability } });
	} catch (error) {
		return res.status(error.status || 500).json({ error: error.status ? error.message : 'Continue watching is unavailable just now. Please try again.' });
	}
});
// Lightweight artwork continuation for the cards already painted by the last
// Home feed. It never rebuilds rows or reads the whole catalogue; the in-memory
// session holds only that viewer's unresolved visible candidates for five
// minutes. Account/source/permission changes fail closed with restart:true.
app.post('/api/web/home/artwork', async (req, res) => {
	res.set('Cache-Control', 'no-store');
	if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
	const empty = { pending: 0, requested: 0, resolved: 0, failed: 0, visible: 0, remaining: 0, limit: 0 };
	const shared = auth.isLocal(req) || auth.isHome(req);
	if (!accountLimits.allowed(req.jserverViewer, false))
		return res.json({ updates: [], availability: empty, restart: true });
	const key = homeArtworkSessionKey(req, shared);
	const session = homeArtworkSessions.get(key);
	if (!session || Date.now() - session.time > HOME_ARTWORK_SESSION_TTL) {
		homeArtworkSessions.delete(key);
		return res.json({ updates: [], availability: empty, restart: true });
	}
	const permitted = item => {
		try { return shared || remoteControls.allowed(req.jserverViewer, { itemId: item.Id, nonstop: false }); }
		catch { return false; }
	};
	const feed = { rows: [{ id: 'visible', items: session.items.map(item => ({ ...item, ProviderIds: { ...item.ProviderIds } })) }], featured: [] };
	let artwork = empty;
	try { artwork = await homeArtwork.enrich(feed, { permitted, waitMs: 0 }); }
	catch { return res.json({ updates: [], availability: empty, restart: true }); }
	// Quota/access can also change while a lookup is in flight.
	if (!accountLimits.allowed(req.jserverViewer, false))
		return res.json({ updates: [], availability: empty, restart: true });
	const before = new Map(session.items.map(item => [item.Id, item]));
	const updates = [];
	for (const item of feed.rows[0].items) {
		const previous = before.get(item.Id);
		if (!previous) continue;
		// Permission is re-checked after the metadata wait as well, so a
		// revocation that lands while a lookup is in flight cannot return art.
		if (!permitted(item)) continue;
		if ((item.Artwork || '') === (previous.Artwork || '') && (item.BackdropArtwork || '') === (previous.BackdropArtwork || '')) continue;
		updates.push({ Id: item.Id, Type: item.Type, Source: item.Source,
			ProviderIds: { ...item.ProviderIds }, Artwork: item.Artwork, BackdropArtwork: item.BackdropArtwork });
	}
	const next = homeArtworkCandidates(feed, { limit: 96, permitted }).map(homeArtworkIdentity);
	if (next.length) {
		session.items = next;
		session.time = Date.now();
	} else homeArtworkSessions.delete(key);
	return res.json({ updates, availability: artwork, restart: false });
});
async function findSimilarSeed(id,{shared,viewer,catalogue,permitted}) {
	const permittedIds=new Set(permitted.map(item=>item.Id));
	const direct=permitted.find(item=>item.Id===id);
	if(direct)return direct;
	// A catalogue id that the caller is not permitted to see must not be
	// recovered through a direct item lookup.
	if(catalogue.some(item=>item.Id===id))return null;
	let seed;
	try{seed=await vodLibrary.item(id);}catch{return null;}
	if(!shared){
		if(!remoteControls.allowed(viewer,{itemId:seed.Id,nonstop:false}))return null;
		if(seed.Type==='Episode'&&seed.SeriesId&&!permittedIds.has(seed.SeriesId)){
			const series=catalogue.find(item=>item.Id===seed.SeriesId);
			if(series||!remoteControls.allowed(viewer,{itemId:seed.SeriesId,nonstop:false}))return null;
		}
	}
	return seed;
}
async function similarItems(ranked, limit) {
	// Only currently playable series are eligible. Check a bounded number of
	// ranked candidates, including replacements revealed after empty titles are
	// removed, but never scan the whole catalogue or trust an unknown state.
	const states = new Map();
	const maxCandidates = Math.min(ranked.length, Math.max(limit * 4, limit + 24));
	const overall = Date.now() + 2500;
	let remaining = 24;
	let checked = 0;
	for (let round = 0; round < 3 && remaining > 0 && Date.now() < overall; round++) {
		const ids = ranked.slice(0, maxCandidates)
			.filter(entry => entry.item.Type === 'Series' && states.get(entry.item.Id) !== 'available')
			.map(entry => entry.item.Id);
		if (!ids.length) break;
		const result = await vodLibrary.verifySeries(ids, {
			limit: Math.min(24, remaining),
			deadlineMs: Math.min(1200, Math.max(150, overall - Date.now())),
			concurrency: 4
		});
		for (const [id, state] of result.states) states.set(id, state);
		checked += result.checked;
		remaining -= result.checked;
		if (!result.checked) break;
	}
	const playable = ranked.filter(entry => entry.item.Type !== 'Series' || states.get(entry.item.Id) === 'available');
	const pending = ranked.slice(0, maxCandidates).filter(entry => entry.item.Type === 'Series' && states.get(entry.item.Id) !== 'available').length;
	return { items: playable.slice(0, limit).map(entry => similarView(entry.item, entry.reason)),
		availability: { pending, checked, queued: 0 } };
}
async function serveSimilar(req,res,{id,limit:requested,taste,favourites,watched}={}) {
	res.set('Cache-Control','no-store');
	if(!id)return res.status(400).json({error:'Choose a title to find similar titles for.'});
	if(!accountLimits.allowed(req.jserverViewer,false))return res.json({items:[],restricted:true,
		reason:accountLimits.reason(req.jserverViewer,false),availability:{pending:0,checked:0}});
	try{
		const limit=similarLimit(requested);
		const shared=auth.isLocal(req)||auth.isHome(req);
		const catalogue=await vodLibrary.all();
		const permitted=homeVisibleItems(catalogue,{shared,allowed:item=>remoteControls.allowed(req.jserverViewer,{itemId:item.Id,nonstop:false})});
		const seed=await findSimilarSeed(id,{shared,viewer:req.jserverViewer,catalogue,permitted});
		if(!seed)return res.json({items:[],availability:{pending:0,checked:0}});
		// Activity history is always filtered to the caller's own person/device
		// (or the shared local/home context). It is never another account's Jellyfin UserData.
		const history=activity.history(req.jserverViewer);
		const ranked=rankSimilarCandidates({seed,items:permitted,taste,favourites,watched,history});
		res.json(await similarItems(ranked,limit));
	}
	catch(error){res.status(error.status||500).json({error:error.status?error.message:'Similar titles are unavailable just now. Please try again.'});}
}
app.post('/api/web/similar',async(req,res)=>{
	if(!req.is('application/json'))return res.status(415).json({error:'A JSON request is required.'});
	const body=req.body&&typeof req.body==='object'?req.body:{};
	if(typeof body.id!=='string'||!body.id.trim()||body.id.length>200)return res.status(400).json({error:'Choose a title to find similar titles for.'});
	if(body.favourites!==undefined&&(!Array.isArray(body.favourites)||body.favourites.length>1000))return res.status(400).json({error:'Invalid favourites context.'});
	if(body.watched!==undefined&&(!Array.isArray(body.watched)||body.watched.length>5000))return res.status(400).json({error:'Invalid watched context.'});
	if(body.taste!==undefined&&body.taste!==null&&(typeof body.taste!=='object'||Array.isArray(body.taste)))return res.status(400).json({error:'Invalid taste context.'});
	return serveSimilar(req,res,{id:body.id.trim(),limit:body.limit,taste:body.taste,favourites:body.favourites,watched:body.watched});
});
app.get('/api/web/items/:id/similar',async(req,res)=>serveSimilar(req,res,{id:req.params.id,limit:req.query.limit}));
// Resolve a series Play/Resume to one exact episode. The caller's own latest
// in-progress episode wins; otherwise the first available episode they have not
// completed. A series-level position is only a label and is never used to seek.
app.get('/api/web/play-target/:id',async(req,res)=>{
	res.set('Cache-Control','no-store');
	if(!accountLimits.allowed(req.jserverViewer,false))return res.status(403).json({error:accountLimits.reason(req.jserverViewer,false)||'Your viewing allowance has been used.',code:'VIEWING_LIMIT'});
	const item=await vodLibrary.item(req.params.id);
	const shared=auth.isLocal(req)||auth.isHome(req);
	if(!shared&&!remoteControls.allowed(req.jserverViewer,{itemId:item.Id,nonstop:false}))return res.status(403).json({error:'This title is only available at home.'});
	if(item.Type!=='Series')return res.json({id:item.Id,type:item.Type,name:item.Name,position:0});
	if(shared){
		// A local/home viewer legitimately shares the home Jellyfin context. Use
		// its next unplayed episode and position, never a remote person's history.
		const episodes=await vodLibrary.episodes(item.Id);
		const next=orderedEpisodes(episodes.items||[]).find(episode=>episode.UserData?.Played!==true)||null;
		if(!next)return res.status(409).json({error:'Everything available in this series has been watched.',code:'SERIES_COMPLETE'});
		const position=Math.max(0,Math.round(Number(next.UserData?.PlaybackPositionTicks||0)/1e7));
		return res.json({id:next.Id,type:'Episode',name:next.Name,seriesId:item.Id,seriesName:item.Name,position,reason:position>0?'resume':'next'});
	}
	const history=activity.history(req.jserverViewer);
	const partial=seriesResumeTarget(history,item.Id);
	if(partial){
		let episode=null;
		try{episode=await vodLibrary.item(partial.itemId);}catch{/* Fall back to the next available episode. */}
		if(episode?.Type==='Episode'&&String(episode.SeriesId||'')===String(item.Id)){
			if(!shared&&!remoteControls.allowed(req.jserverViewer,{itemId:episode.Id,nonstop:false}))return res.status(403).json({error:'This title is only available at home.'});
			return res.json({id:episode.Id,type:'Episode',name:episode.Name,seriesId:item.Id,seriesName:item.Name,position:partial.position,reason:'resume'});
		}
	}
	const episodes=await vodLibrary.episodes(item.Id);
	const completed=new Set(history.filter(entry=>entry.completed).map(entry=>entry.itemId));
	const next=orderedEpisodes(episodes.items||[]).find(episode=>!completed.has(episode.Id))||null;
	if(!next)return res.status(409).json({error:'Everything available in this series has been watched.',code:'SERIES_COMPLETE'});
	if(!shared&&!remoteControls.allowed(req.jserverViewer,{itemId:next.Id,nonstop:false}))return res.status(403).json({error:'This title is only available at home.'});
	return res.json({id:next.Id,type:'Episode',name:next.Name,seriesId:item.Id,seriesName:item.Name,position:0,reason:'next'});
});
const globalSearch=createGlobalSearch({library:vodLibrary,discover:seerr,channels:async()=>(await dispatcharr.channels()).map(channelView)});
app.get('/api/search',async(req,res)=>{res.set('Cache-Control','no-store');res.json(await globalSearch(req.query));});
app.get('/search',(req,res)=>res.sendFile(path.join(root,'public','search.html')));
app.get('/coming-soon',(req,res)=>res.sendFile(path.join(root,'public','coming-soon.html')));
app.get('/api/web/releases',async(req,res)=>{
	const requested=Number(req.query.limit),limit=Number.isInteger(requested)?Math.max(12,Math.min(120,requested)):16;
	res.json({items:await vodLibrary.releases('Movie',limit)});
});
// A bounded, genre-balanced pool for the app's local ranker. The app never
// receives the whole 45k catalogue, and remote callers still pass the same
// catalogue policy and allowance checks as the personalised home feed.
app.get('/api/web/recommendations',async(req,res)=>{
	res.set('Cache-Control','no-store');
	const requested=Number(req.query.limit),limit=Number.isInteger(requested)?Math.max(24,Math.min(1200,requested)):600;
	if(!accountLimits.allowed(req.jserverViewer,false))return res.json({items:[]});
	const shared=auth.isLocal(req)||auth.isHome(req);
	const allowed=item=>shared||remoteControls.allowed(req.jserverViewer,{itemId:item.Id,nonstop:false});
	const items=await vodLibrary.recommendationPool('Movie',limit,{allowed});
	res.json({items});
});
app.get('/api/web/releases/tv',async(req,res)=>{
	const query=new URLSearchParams({UserId:connection().userId,Recursive:'true',IncludeItemTypes:'Episode',IsMissing:'false',IsUnaired:'false',Fields:'Genres,DateCreated',Limit:'500',SortBy:'PremiereDate',SortOrder:'Descending'});
	const added=new URLSearchParams(query);added.set('SortBy','DateCreated');
	const [dated,newlyAdded,streamed,airings]=await Promise.all([jelly('/Items?'+query),jelly('/Items?'+added),vodLibrary.releasedEpisodes(),insights.recentEpisodeDates()]);
	const local=[...new Map([...(dated.Items||[]),...(newlyAdded.Items||[])].map(item=>[item.Id,item])).values()];
	const available=episodeReleaseDates([...local,...streamed],airings);
	res.json({items:recentTvEpisodes(available,new Date(),20).map(item=>item.Source==='streamed'?item:itemView(item))});
});
// Real episodes of explicitly liked series. Home sends a small explicit id set
// and filters finish state itself; this route never invents an episode or a
// series relationship and never replaces the recently released TV shelf. A
// canonical local series returns its merged local and VOD-only episodes.
app.get('/api/web/releases/episodes',async(req,res)=>{
	res.set('Cache-Control','no-store');
	const extra=Object.keys(req.query||{}).filter(key=>key!=='series'&&key!=='anchors');
	if(extra.length)return res.status(400).json({error:'Only a series list and episode anchors are accepted.'});
	const parsed=parseSeriesIds(req.query.series);
	if(parsed.error)return res.status(400).json({error:parsed.error});
	const parsedAnchors=parseAnchors(req.query.anchors);
	if(parsedAnchors.error)return res.status(400).json({error:parsedAnchors.error});
	const anchors=parsedAnchors.anchors;
	// An anchor implies its series. Union both lists so a caller cannot ask for
	// an anchor on a show it did not also name (and so the bounded lookup still
	// sees the show once).
	const seen=new Set(parsed.ids.map(id=>id.toLowerCase()));
	const ids=[...parsed.ids];
	for(const anchor of anchors){
		const key=anchor.seriesId.toLowerCase();
		if(seen.has(key))continue;
		if(ids.length>=50)return res.status(400).json({error:'At most 50 series can be requested.'});
		seen.add(key);ids.push(anchor.seriesId);
	}
	if(!ids.length)return res.json({items:[]});
	if(!accountLimits.allowed(req.jserverViewer,false))return res.json({items:[],restricted:true,
		reason:accountLimits.reason(req.jserverViewer,false)});
	try{
		// One deadline for the whole answer: the catalogue policy snapshot plus
		// the episode lookup. The snapshot is single-flight, so a slow catalogue
		// never becomes one enumeration per request.
		const deadline=Date.now()+REQUEST_TIMEOUT_MS;
		const shared=auth.isLocal(req)||auth.isHome(req);
		// The snapshot also supplies each episode's parent series artwork. It is
		// started before the episode lookup, so a shared/local caller does not pay
		// for it twice, and a slow snapshot only drops the artwork hint.
		const cataloguePromise=untilDeadline(homeCatalogueSnapshot(),deadline);
		let catalogue=null,allowedIds=ids;
		if(!shared){
			// A remote caller may only ask about series the catalogue policy lets
			// them see. An unknown or hidden id is skipped before any lookup.
			// A snapshot that misses the deadline fails closed: no late work is
			// started and the viewer gets a useful empty list.
			catalogue=await cataloguePromise;
			if(!catalogue)return res.json({items:[]});
			catalogue=homeVisibleItems(catalogue,{allowed:item=>remoteControls.allowed(req.jserverViewer,{itemId:item.Id,nonstop:false})});
			const visible=new Set(catalogue.map(item=>item.Id));
			allowedIds=ids.filter(id=>visible.has(id));
		}
		if(!allowedIds.length)return res.json({items:[]});
		const allowed=new Set(allowedIds.map(id=>id.toLowerCase()));
		const activeAnchors=anchors.filter(anchor=>allowed.has(anchor.seriesId.toLowerCase()));
		const result=await homeEpisodeLookup(allowedIds,{deadline,...(activeAnchors.length?{anchors:activeAnchors}:{})});
		const episodes=Array.isArray(result)?result:result.items;
		if(shared)catalogue=await cataloguePromise;
		catalogue=await warmEpisodeSeries(episodes,catalogue,deadline);
		const seriesArtwork=seriesArtworkIndex(catalogue);
		const items=episodes.filter(episode=>shared||remoteControls.allowed(req.jserverViewer,{itemId:episode.Id,nonstop:false}))
			.map(episode=>{
				const view=itemView(episode);
				// Shared Jellyfin UserData belongs to the backend service account.
				// A remote viewer does not receive another account's watched state;
				// Home keeps finish filtering in this browser profile instead.
				if(!shared)delete view.UserData;
				if(episode.Artwork)view.Artwork=episode.Artwork;
				if(episode.Source)view.Source=episode.Source;
				if(episode.Provider)view.Provider=episode.Provider;
				if(Array.isArray(episode.VodIds))view.VodIds=episode.VodIds;
				episodeParentArtwork(view,episode,seriesArtwork);
				return view;
			});
		if(activeAnchors.length&&!Array.isArray(result)){
			res.json({items,
				anchors:(result.anchors||[]).filter(anchor=>allowed.has(anchor.seriesId.toLowerCase())),
				series:(result.series||[]).filter(series=>allowed.has(series.seriesId.toLowerCase()))});
			return;
		}
		res.json({items});
	}catch{
		// Home must still render when one source is unavailable.
		res.json({items:[]});
	}
});
app.get('/api/dispatcharr/catalogue',dispatcharrAdmin,(req,res)=>res.json(vodLibrary.status()));
// Legacy LAN button: still local-only, and now also requires the existing
// installation-owner session. It enqueues the same bounded slice instead of
// forcing a full provider catalogue refresh during playback.
app.post('/api/dispatcharr/catalogue/refresh',dispatcharrAdmin,async(req,res)=>{
	if(!await requireOwner(req,res))return;
	const result=cacheJobs.request('index',{manual:true});
	if(result.reason==='cooldown'){
		res.set('Retry-After',String(Math.max(1,Math.ceil(Number(result.retryAfterMs||0)/1000))));
		return res.status(429).json({ok:false,...result});
	}
	res.status(202).json({ok:true,...result});
});
app.get('/api/web/items/:id',async(req,res)=>{
	if (/^dispatch-live-[a-f0-9-]{36}$/i.test(req.params.id)) return res.json(await shareItem(req.params.id));
	const item=await vodLibrary.item(req.params.id);
	if(item.Source==='streamed'){
		let provider='';
		try{provider=await providerNameFor(item.Id);}catch{}
		item.Provider=provider||'Dispatcharr';
	}
	res.json(item);
});
app.get('/api/web/items/:id/episodes',async(req,res)=>res.json(await vodLibrary.episodes(req.params.id)));
// Owner-only upstream stream monitor. The main app has no owner session of its
// own: it forwards ONLY the existing installation cookie to the fixed loopback
// setup endpoint, which validates the session before its cache or upstream
// fetch and again after the await. A LAN/local caller is not an administrator.
function setupStreamsOrigin(){
	const raw=String(process.env.SETUP_INTERNAL_URL||'');
	if(raw){
		try{
			const url=new URL(raw);
			if(url.protocol==='http:'&&!url.username&&!url.password&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))return url.origin;
		}catch{}
	}
	const port=Number(process.env.SETUP_PORT);
	return 'http://127.0.0.1:'+(Number.isInteger(port)&&port>0&&port<65536?port:8990);
}
async function readLimitedText(response,limit){
	const reader=response.body?.getReader();
	if(!reader)return '';
	const chunks=[];let total=0;
	try{
		for(;;){
			const {done,value}=await reader.read();
			if(done)break;
			total+=value.byteLength;
			if(total>limit)throw Object.assign(Error('Response is too large.'),{code:'too-large'});
			chunks.push(Buffer.from(value));
		}
	}finally{
		try{await reader.cancel();}catch{}
		try{reader.releaseLock();}catch{}
	}
	return Buffer.concat(chunks).toString('utf8');
}
app.get('/api/admin/dispatcharr/streams',async(req,res)=>{
	res.set('Cache-Control','no-store');
	const token=req.get('cookie')?.match(/(?:^|;\s*)tellybox_setup=([a-f0-9]{64})(?:;|$)/)?.[1]||'';
	if(!token)return res.status(401).json({error:'Sign in as installation administrator.',signInRequired:true});
	let response;
	try{
		const url=new URL('/api/setup/dispatcharr/streams',setupStreamsOrigin());
		if(req.query.refresh==='1')url.searchParams.set('refresh','1');
		response=await fetch(url,{headers:{cookie:'tellybox_setup='+token,accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(12000)});
	}catch{
		return res.status(503).json({error:'Installation sign-in service is unavailable.'});
	}
	if(response.status===401){
		try{await response.body?.cancel();}catch{}
		return res.status(401).json({error:'Sign in as installation administrator.',signInRequired:true});
	}
	const type=String(response.headers.get('content-type')||'');
	if(!/^application\/json/i.test(type)){
		try{await response.body?.cancel();}catch{}
		return res.status(502).json({error:'Installation sign-in service returned an unreadable response.'});
	}
	let text;
	try{text=await readLimitedText(response,512*1024);}
	catch{return res.status(502).json({error:'Installation sign-in service returned an unreadable response.'});}
	res.status(response.status>=500?502:response.status).type('application/json').send(text);
});
// The same sanitized stream report for trusted home/LAN viewers and installation
// administrators who are not signed in on the separate setup page. The setup
// service exposes a loopback-only read-only route for this hop; the admin route
// above keeps its owner-session check unchanged.
app.get('/api/activity/streams',async(req,res)=>{
	res.set('Cache-Control','no-store');
	if(!auth.isOwnerAdmin(req) && !auth.isHome(req))
		return res.status(403).json({error:'Upstream stream monitoring is available to installation administrators only.'});
	let response;
	try{
		const url=new URL('/api/setup/dispatcharr/streams/readonly',setupStreamsOrigin());
		if(req.query.refresh==='1')url.searchParams.set('refresh','1');
		response=await fetch(url,{headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(12000)});
	}catch{
		return res.status(503).json({error:'Installation monitoring service is unavailable.'});
	}
	if([401,403].includes(response.status)){
		try{await response.body?.cancel();}catch{}
		return res.status(403).json({error:'Upstream stream monitoring is not available to this caller.'});
	}
	const type=String(response.headers.get('content-type')||'');
	if(!/^application\/json/i.test(type)){
		try{await response.body?.cancel();}catch{}
		return res.status(502).json({error:'Installation monitoring service returned an unreadable response.'});
	}
	let text;
	try{text=await readLimitedText(response,512*1024);}
	catch{return res.status(502).json({error:'Installation monitoring service returned an unreadable response.'});}
	res.status(response.status>=500?502:response.status).type('application/json').send(text);
});
const episodeNext = createEpisodeNext({ library: vodLibrary, metadata: seerr.catalogueMetadata });
const mediaSegments = createMediaSegments({ directory: process.env.AUTH_DIR || path.join(root, 'auth-data'), item: vodLibrary.item, jelly });
app.get(['/api/web/items/:id/next', '/api/items/:id/next'], async (req, res) => {
	res.set('Cache-Control', 'no-store');
	res.json(await episodeNext(req.params.id, String(req.query.series || '')));
});
app.get(['/api/web/items/:id/schedule', '/api/items/:id/schedule'], async (req, res) => {
	res.set('Cache-Control', 'no-store');
	res.json(await episodeNext.schedule(req.params.id, String(req.query.series || '')));
});
app.get(['/api/web/items/:id/segments', '/api/items/:id/segments'], async (req, res) => res.json(await mediaSegments.get(req.params.id)));
// Public TMDB artwork is metadata art, not private viewer data. It still stays
// private to the browser cache so a shared proxy cannot serve one viewer's
// response to another account.
async function sendTmdbArtwork(res,type,id,kind){
	const image=await vodMetadata.artwork(type,id,kind);
	if(!image){res.set('Cache-Control','no-store');return res.sendStatus(404);}
	return proxyImage(res,{url:`https://image.tmdb.org/t/p/${kind==='backdrop'?'w1280':'w500'}${image}`,maxBytes:5*1024*1024,
		allow:/^image\/(png|jpeg|webp)(?:;|$)/i,cache:'private, max-age=86400',timeoutMs:10000,label:'TMDB artwork'});
}
app.get('/api/web/art/:kind/:id',async(req,res)=>{
	res.set('Cache-Control','no-store');
	if(!['movie','series'].includes(req.params.kind)||!/^\d+$/.test(req.params.id))return res.sendStatus(404);
	let item=null;
	try{item=await vodLibrary.raw(`dispatch-${req.params.kind}-${req.params.id}`);}catch{/* the merged catalogue lookup below can still resolve the poster */}
	const logo=Number(item?.data?.logo?.id);
	if(Number.isSafeInteger(logo)&&logo>0)
		return proxyImage(res,{url:new URL(`/api/vod/vodlogos/${logo}/cache/`,dispatcharr.origin),maxBytes:3*1024*1024,
			allow:/^image\/(png|jpeg|webp|gif)(?:;|$)/i,cache:'private, max-age=1800',label:'Artwork'});
	// The provider has no usable logo. If this exact title already has a warm
	// public TMDB poster, resolve the existing card URL instead of forcing a
	// permanent placeholder and an extra client request. This route never
	// enqueues metadata and never invents an image path.
	// The raw provider row can carry a wrong or missing TMDB id. Prefer the
	// merged item's poster, which is what the detail page already shows.
	try{
		const view=await vodLibrary.item(`dispatch-${req.params.kind}-${req.params.id}`);
		const match=/^\/api\/web\/tmdb-art\/(movie|tv)\/(\d+)\/(poster|backdrop)$/.exec(String(view?.Artwork||''));
		if(match)return sendTmdbArtwork(res,match[1],match[2],'poster');
	}catch{}
	const tmdb=Number(item?.data?.tmdb_id);
	if(Number.isSafeInteger(tmdb)&&tmdb>0)
		return sendTmdbArtwork(res,req.params.kind==='movie'?'movie':'tv',String(tmdb),'poster');
	return res.sendStatus(404);
});
app.get('/api/web/tmdb-art/:type/:id/:kind',async(req,res)=>{
	res.set('Cache-Control','no-store');
	const {type,id,kind}=req.params;
	if(!['movie','tv'].includes(type)||!/^\d+$/.test(id)||!['poster','backdrop'].includes(kind))return res.sendStatus(404);
	return sendTmdbArtwork(res,type,id,kind);
});
const vodSources=new Map();
const providerLabels=new Map();
const PROVIDER_LOOKUP_TIMEOUT_MS = 2500;
async function providerRecords(raw) {
	// Provider names decorate a detail response; they must never hold it open
	// for the full catalogue timeout. Lists never call this resolver.
	const api = route => dispatcharr.api(route, { timeoutMs: PROVIDER_LOOKUP_TIMEOUT_MS });
	if(raw.type==='Movie')return api(`/api/vod/movies/${raw.id}/providers/`);
	if(raw.type==='Series')return api(`/api/vod/series/${raw.id}/providers/`);
	if(raw.type==='Episode'){
		if(Array.isArray(raw.data?.providers))return raw.data.providers;
		const seriesId=raw.data?.series?.id;
		if(seriesId)return api(`/api/vod/series/${seriesId}/providers/`);
	}
	return [];
}
async function providerNameFor(id) {
	const hit=providerLabels.get(id);if(hit&&Date.now()-hit.time<300000)return hit.value;
	let value='';
	try{value=providerLabel(await providerRecords(await vodLibrary.raw(id)));}catch{}
	value=String(value||'').trim().slice(0,100);
	providerLabels.set(id,{time:Date.now(),value});
	if(providerLabels.size>500)providerLabels.delete(providerLabels.keys().next().value);
	return value;
}
async function vodSource(id) {
	const hit=vodSources.get(id);if(hit&&Date.now()-hit.time<300000)return hit.value;
	const raw=await vodLibrary.raw(id);
	if(!['Movie','Episode'].includes(raw.type))throw Object.assign(Error('Choose a film or episode to play.'),{status:400});
	let account,streamId,provider='Dispatcharr';
	// Provider lookup is a display/route hint only. A provider API failure must
	// never prevent playback through the existing Dispatcharr UUID route.
	try{
		const records=await providerRecords(raw);
		const chosen=selectProvider(records);
		if(chosen){
			provider=providerLabel([chosen])||provider;
			if(raw.type==='Movie'){account=Number(chosen.m3u_account?.id);streamId=chosen.stream_id;}
		}
	}catch{}
	const value={type:raw.type==='Movie'?'movie':'episode',uuid:raw.data.uuid,account,streamId,provider};
	vodSources.set(id,{time:Date.now(),value});if(vodSources.size>200)vodSources.delete(vodSources.keys().next().value);
	return value;
}

app.get('/api/status', (req, res) => {
	res.json({ connected: features.library || features.live, name: 'Tellybox HomeLab', features });
});

app.get('/api/libraries', async (req, res) => {
	const data = features.jellyfin ? await jelly(`/Users/${connection().userId}/Views`) : {Items:[]};
	const items = data.Items.map(itemView);
	if (features.vod) for (const [type,name] of [['movies','Films'],['tvshows','Series']]) if (!items.some(i=>i.CollectionType===type)) items.push({Id:'homelab-'+type,CollectionType:type,Name:name});
	res.json(items);
});

const liveGuide = createLiveGuide(jelly, () => connection().userId);
app.get('/api/live-guide', async (req, res) => {
	res.setHeader('Cache-Control', 'no-store');
	res.json(await liveGuide());
});
app.get('/api/web/live-guide', async (req,res) => res.json(await dispatcharrGuide(req.query.refresh === '1')));
const catchup=createCatchup(dispatcharr,dispatcharrGuide);
const broadcastResume=createBroadcastResume({library:vodLibrary,catchup:{list:(...args)=>features.catchup?catchup.list(...args):Promise.resolve({channels:[]})}});
app.post('/api/continue-watching',async(req,res)=>{
	remoteControls.guard(req.jserverViewer);accountLimits.guard(req.jserverViewer,false);
	// Retained for older app clients. The default shelf contract is now empty because
	// live, 24/7 and catch-up programmes are no longer resolved into home resume cards.
	res.set('Cache-Control','no-store');res.json(await broadcastResume(req.body,{allowed:item=>remoteControls.allowed(req.jserverViewer,{itemId:item.Id,nonstop:item.Nonstop===true})}));
});
const catchupPlayer=createCatchupPlayer({openArchive:(...args)=>dispatcharr.catchupSession(...args)});
app.get('/api/catchup',async(req,res)=>res.json(await catchup.list(String(req.query.channel||''))));
app.get('/api/catchup/restart',async(req,res)=>res.json(await catchup.restart(String(req.query.channel||''),String(req.query.programme||''))));
app.get('/api/recordings',async(req,res)=>res.json({items:await recordings.list(req.query.refresh==='1')}));
const recordingDeletion=createRecordingDeletion({jelly,userId:()=>connection().userId,recordings,
	busy:id=>[...sessions.values()].some(session=>session.itemId===id&&Date.now()-session.updated<120000),
	invalidated:id=>{metadataCache.clear();discoveryLibraryCache.clear();vodLibrary.removedLocal(id);}
});
installRecordingDeletion(app,{manager:recordingDeletion,allowed:req=>auth.isHome(req)||auth.isOwnerAdmin(req),audit:activity.record});
app.get('/api/local-recordings',async(req,res)=>res.json({items:features.jellyfin?(await recordingDeletion.localList()).map(item=>({...itemView(item),Source:'local-recording',State:'completed',Playable:true,ChannelName:'Local recording',StartDate:item.DateCreated})):[]}));

const exportFields='Path,MediaSources,Overview,ProductionYear,PremiereDate,SeriesId,SeriesName,ParentIndexNumber,IndexNumber,RunTimeTicks';
function exportQuery(types,extra={}) {
	return new URLSearchParams({UserId:connection().userId,Recursive:'true',IncludeItemTypes:types,LocationTypes:'FileSystem',Fields:exportFields,...extra});
}
async function exportItems(types,extra={},allowFolders=false) {
	const items=[];
	for(let start=0;start<5000;start+=500){
		const data=await jelly('/Items?'+exportQuery(types,{...extra,StartIndex:String(start),Limit:'500'}));
		items.push(...(data.Items||[]).filter(item=>!item.IsVirtualItem&&!item.IsMissing&&(allowFolders||!item.IsFolder)));
		if(!data.Items?.length||data.Items.length<500||items.length>=(data.TotalRecordCount||0))break;
	}
	return items;
}
function exportView(item) {
	return {id:item.Id,name:item.Name,type:item.Type,seriesId:item.SeriesId||'',seriesName:item.SeriesName||'',
		season:Number(item.ParentIndexNumber)||0,episode:Number(item.IndexNumber)||0,year:item.ProductionYear||0,
		date:item.PremiereDate||item.DateCreated||''};
}
async function exportCatalogue() {
	if(!features.jellyfin)return {enabled:false,reason:'Jellyfin local media is not enabled.',movies:[],series:[],episodes:[],recordings:[]};
	const [movies,series,episodes,recordings]=await Promise.all([
		exportItems('Movie'),exportItems('Series',{},true),exportItems('Episode'),
		recordingDeletion.localList().then(items=>items.map(item=>exportView(item))).catch(()=>[])
	]);
	return {enabled:true,movies:movies.map(exportView),series:series.map(exportView),episodes:episodes.map(exportView),recordings};
}
function exportSidecars(item) {
	const values=[];
	for(const source of item.MediaSources||[])for(const track of source.MediaStreams||[])
		if(track.Type==='Subtitle'&&track.IsExternal&&typeof track.Path==='string')values.push(track.Path);
	return values;
}
async function exportEntry(item,seriesName='') {
	const filePath=item.Path||item.MediaSources?.[0]?.Path;
	if(typeof filePath!=='string'||!filePath)throw Object.assign(Error('That item is not stored as a local file.'),{status:409});
	const kind=item.Type==='Movie'?'movie':item.Type==='Episode'?'episode':'recording';
	const folder=kind==='movie'?`${safeExportName(item.Name)}${item.ProductionYear?` (${item.ProductionYear})`:''}`:
		kind==='episode'?`${safeExportName(seriesName||item.SeriesName||'Series')}/Season ${String(item.ParentIndexNumber||1).padStart(2,'0')}`:
		'Recordings';
	return {id:item.Id,name:path.basename(filePath),path:filePath,folder,kind,sidecars:exportSidecars(item)};
}
function safeExportName(value){return String(value||'Untitled').replace(/[\\/:*?"<>|\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim().slice(0,120)||'Untitled';}
async function resolveExportItems(ids) {
	if(ids===undefined)return exportCatalogue();
	if(!Array.isArray(ids)||!ids.length||ids.length>500)throw Object.assign(Error('Choose at least one local item.'),{status:400});
	const unique=[...new Set(ids.filter(id=>typeof id==='string'))];
	const result=[];
	const localRecordings=features.jellyfin?await recordingDeletion.localList().catch(()=>[]):[];
	for(const id of unique){
		if(/^dispatch-recording-/.test(id))throw Object.assign(Error('Only completed recordings stored in your local Jellyfin library can be exported.'),{status:409});
		const recording=localRecordings.find(item=>item.Id===id);
		const item=recording||await jelly(`/Users/${connection().userId}/Items/${itemId(id)}?Fields=${encodeURIComponent(exportFields)}`);
		if(recording)result.push(await exportEntry(item,recording.SeriesName||''));
		else if(item.Type==='Series'){
			const episodes=await exportItems('Episode',{SeriesId:item.Id});
			for(const episode of episodes)result.push(await exportEntry(episode,item.Name));
		} else result.push(await exportEntry(item,item.SeriesName||''));
	}
	return result;
}
const usbExportHelper=process.env.TELLYBOX_EXPORT_HELPER_SOCKET?createUsbHelperClient(process.env.TELLYBOX_EXPORT_HELPER_SOCKET):null;
const usbExport=createUsbExport({
	directory:path.dirname(configPath),
	mediaRoots:(process.env.TELLYBOX_EXPORT_MEDIA_ROOTS||'').split(path.delimiter).filter(Boolean),
	usbRoot:process.env.TELLYBOX_EXPORT_USB_ROOT||(usbExportHelper?'/var/lib/tellybox-export/mnt':''),
	protectedRoots:['/','/boot','/home','/var',...((process.env.TELLYBOX_EXPORT_MEDIA_ROOTS||'').split(path.delimiter).filter(Boolean))],
	volumeProvider:usbExportHelper?async()=>{
		const state=await usbExportHelper.status();
		return (state.volumes||[]).map(volume=>({major:'helper',minor:volume.device,mountPoint:volume.mountPoint||'',fsType:volume.fsType||'',
			source:volume.device,removable:true,usb:true,label:volume.label||'',uuid:volume.uuid||'',identity:volume.identity||'',mounted:Boolean(volume.mounted)}));
	}:undefined,
	mountImpl:usbExportHelper?(device,identity)=>usbExportHelper.mount(device,identity):null,
	ejectImpl:usbExportHelper?(device,identity)=>usbExportHelper.eject(device,identity):null
});
installUsbExport(app,{manager:usbExport,allowed:req=>adminAllowed(req,{isLocal:auth.isLocal,isAdmin}),resolve:resolveExportItems,audit:activity.record});
function recordingAction(req,res,next){
	if(!req.is('application/json')||req.get('origin')!==req.jserverOrigin)return res.sendStatus(403);
	next();
}
app.post('/api/recordings',recordingAction,async(req,res)=>{
	const result=await recordings.schedule(req.body.channelId,req.body.programmeId);
	if(!result.existing)activity.record('recording_scheduled',req.jserverViewer,{title:result.item.Name});
	res.status(result.existing?200:201).json(result);
});
app.post('/api/recordings/:id/cancel',recordingAction,async(req,res)=>res.json(await recordings.cancel(req.params.id)));
app.get('/api/dispatcharr/channels', async (req,res) => {
	const channels=(await dispatcharr.channels()).filter(c=>c.nonstop);
	const enriched=await nonstopMetadata.enrich(channels);
	// A logo cache path can exist while Dispatcharr cannot serve the image. Do
	// not advertise artwork unless the cache is healthy or the provider origin
	// fallback was resolved for that channel.
	const view=channel=>channelView(channel.logo&&!dispatcharr.logoAvailable(channel.logo)&&!channel.sourceLogo?{...channel,logo:''}:channel);
	res.json({items:enriched.map(c=>({...view(c),Genres:c.genres})), groups:[...new Set(channels.map(c=>view(c).Group))], categorisation:nonstopMetadata.status()});
});
app.get('/api/dispatcharr/channels/:id/image', async (req,res) => {
	const channel=findChannelForArtwork(await dispatcharr.channels(),req.params.id);
	if(!channel)return res.sendStatus(404);
	const url=channelLogoUrl(channel,dispatcharr.origin);
	// Re-validate the provider URL against the host allowlist derived from the
	// provider's own playlist. A browser can never supply either input.
	const fallback=channel.sourceLogo?dispatcharr.providerLogo(channel.sourceLogo):'';
	if(!url&&!fallback)return res.sendStatus(404);
	// Record what the upstream actually returned, so a logo that stops working
	// leaves the channel list until the bounded health TTL expires. Transient
	// failures stay unknown and keep the artwork advertised. When Dispatcharr's
	// cache refuses the image, serve the provider's HTTPS logo instead.
	const allow=/^image\/(png|jpeg|webp|gif)(?:;|$)/i;
	const fetchLogo=async(input,init)=>{
		if(init?.signal?.aborted)throw init.signal.reason||Object.assign(Error('Image request closed.'),{name:'AbortError'});
		let cacheFailure=null;
		if(url&&dispatcharr.logoAvailable(channel.logo)){
			try{
				const response=await fetch(input,init);
				if(response.ok&&allow.test(response.headers.get('content-type')||'')){
					dispatcharr.noteLogo(channel.logo,true);
					return response;
				}
				if(response.status===404||response.status===410)dispatcharr.noteLogo(channel.logo,false);
				try{await response.body?.cancel();}catch{}
				cacheFailure=response.status||502;
			}catch(error){cacheFailure=error;}
		}
		if(fallback){
			const image=await providerArtwork.get(fallback);
			if(image)return new Response(image.body,{status:200,headers:{'Content-Type':image.type,'Content-Length':String(image.body.length)}});
		}
		if(cacheFailure instanceof Error)throw cacheFailure;
		return new Response(null,{status:cacheFailure||404,headers:{'Content-Type':'application/json'}});
	};
	return proxyImage(res,{url:url||new URL('/placeholder',dispatcharr.origin),fetchImpl:fetchLogo,maxBytes:3*1024*1024,allow,
		cache:'private, max-age=300, must-revalidate',timeoutMs:10000,label:'Channel image'});
});

app.get('/api/releases/tv', async (req, res) => {
	const now = new Date();
	const since = new Date(now);
	since.setUTCFullYear(since.getUTCFullYear() - 1);
	const params = new URLSearchParams({
		UserId: connection().userId, Recursive: 'true', IncludeItemTypes: 'Episode', IsMissing: 'false', IsUnaired: 'false',
		LocationTypes: 'FileSystem,Remote', Fields: 'PrimaryImageAspectRatio,Genres', Limit: '240',
		SortBy: 'PremiereDate,ParentIndexNumber,IndexNumber', SortOrder: 'Descending',
		MinPremiereDate: since.toISOString(), MaxPremiereDate: now.toISOString()
	});
	const data = await jelly(`/Items?${params}`);
	res.json({ items: recentTvEpisodes(data.Items || [], now).map(itemView) });
});

// "Newly available" is deliberately different from "Recently released" and
// from the Coming soon calendar. It lists titles that are already present as
// real local files and became available recently, so every card is playable or
// opens a real title. Coming soon listings stay unavailable until they arrive.
app.get('/api/newly-available', async (req, res) => {
	res.set('Cache-Control', 'no-store');
	if (!features.jellyfin) return res.json({ items: [] });
	const data = await jelly(`/Items?${newlyAvailableQuery(connection().userId)}`);
	res.json({ items: await libraryItems(newlyAvailableItems(data)) });
});

app.get('/api/releases', async (req, res) => {
	const now = new Date();
	const since = new Date(now);
	since.setUTCFullYear(since.getUTCFullYear() - 1);
	const params = new URLSearchParams({
		UserId: connection().userId, Recursive: 'true', IncludeItemTypes: 'Movie', IsMissing: 'false',
		Fields: 'Overview,Genres,PrimaryImageAspectRatio,ProviderIds', Limit: '12',
		SortBy: 'PremiereDate,SortName', SortOrder: 'Descending',
		MinPremiereDate: since.toISOString(), MaxPremiereDate: now.toISOString()
	});
	const data = await jelly(`/Items?${params}`);
	res.json({ items: await libraryItems(data.Items), total: data.TotalRecordCount });
});

app.get('/api/items', async (req, res) => {
	const params = new URLSearchParams({ UserId: connection().userId, Recursive: 'true', Fields: 'Overview,Genres,PrimaryImageAspectRatio,ProviderIds', Limit: '60', StartIndex: String(Math.max(0, Number(req.query.start) || 0)), SortBy: 'SortName', SortOrder: 'Ascending', EnableTotalRecordCount: 'true' });
	const types = { movies: 'Movie', tvshows: 'Series', music: 'MusicAlbum', recordings: 'Movie,Episode,Video,Series,Audio', all: 'Movie,Series,MusicAlbum' };
	params.set('IncludeItemTypes', types[req.query.type] || types.all);
	if (req.query.parent) params.set('ParentId', itemId(req.query.parent));
	if (req.query.search) {
		params.set('SearchTerm', String(req.query.search).slice(0, 200));
		params.set('IncludeItemTypes', 'Movie,Series,Episode,MusicAlbum,Audio');
	}
	if (req.query.sort === 'new') { params.set('SortBy', 'DateCreated'); params.set('SortOrder', 'Descending'); }
	if (req.query.sort === 'release') {
		params.set('SortBy', 'PremiereDate,SortName');
		params.set('SortOrder', 'Descending');
		params.set('MaxPremiereDate', new Date().toISOString());
		params.set('IsMissing', 'false');
	}
	let data;
	if (req.query.type === 'livetv') {
		data = await jelly(`/LiveTv/Channels?UserId=${connection().userId}&AddCurrentProgram=true&Limit=1000`);
		if (req.query.search) {
			const term = String(req.query.search).toLowerCase();
			data.Items = data.Items.filter(item => `${item.Name} ${item.CurrentProgram?.Name || ''}`.toLowerCase().includes(term));
			data.TotalRecordCount = data.Items.length;
		}
	} else data = await jelly(`/Items?${params}`);
	res.json({ items: await libraryItems(data.Items), total: data.TotalRecordCount });
});

const metadataCache = new Map();
async function metadata(key, load) {
	const hit = metadataCache.get(key);
	if (hit && hit.until > Date.now()) return hit.value;
	if (metadataCache.size > 300) metadataCache.delete(metadataCache.keys().next().value);
	const value = Promise.resolve().then(load);
	const entry = { value, until: Date.now() + 30000 };
	metadataCache.set(key, entry);
	try { return await value; } catch (error) { if (metadataCache.get(key) === entry) metadataCache.delete(key); throw error; }
}
app.get('/api/items/:id', async (req, res) => {
	const data = await metadata(`item:${itemId(req.params.id)}`, () => jelly(`/Users/${connection().userId}/Items/${itemId(req.params.id)}?Fields=RemoteTrailers`));
	res.json((await libraryItems([data]))[0]);
});

app.get('/api/items/:id/children', async (req, res) => {
	const id = itemId(req.params.id);
	let data;
	if (req.query.type === 'Series') data = await metadata(`seasons:${id}`, () => jelly(`/Shows/${id}/Seasons?UserId=${connection().userId}`));
	else {
		const params = new URLSearchParams({ UserId: connection().userId, ParentId: id, SortBy: 'ParentIndexNumber,IndexNumber,SortName', Fields: 'Overview,Genres', IsMissing: 'false', IsUnaired: 'false', Limit: '1000' });
		data = await metadata(`children:${id}`, () => jelly(`/Items?${params}`));
	}
	res.json(data.Items.filter(x => !x.IsVirtualItem).map(itemView));
});

async function seriesEpisodes(id) {
	const data = await metadata(`episodes:${id}`, () => jelly(`/Shows/${id}/Episodes?UserId=${connection().userId}&IsMissing=false&IsUnaired=false&Fields=Overview,Genres`));
	const episodes = orderedEpisodes(data.Items || []);
	// Episodes frequently carry no still of their own. Resolve the series' real
	// poster once and reuse it, so the in-series list is not a row of blank
	// squares on phone or TV. The route is only used when the parent has image
	// evidence; an episode with its own still keeps it.
	let parent = null;
	try {
		parent = await metadata(`series-art:${id}`, () => jelly(`/Users/${connection().userId}/Items/${id}`));
	} catch { parent = null; }
	const index = parent && parent.Type === 'Series' ? seriesArtworkIndex([parent]) : new Map();
	return episodes.map(episode => {
		const view = itemView(episode);
		if (index.size) episodeParentArtwork(view, { SeriesId: episode.SeriesId || id }, index);
		return view;
	});
}
app.get('/api/items/:id/episodes', async (req, res) => {
	res.json({ items: await seriesEpisodes(itemId(req.params.id)) });
});

async function downloadable(req, browserEpisode = false) {
	remoteControls.guard(req.jserverViewer);
	accountLimits.guard(req.jserverViewer,true);
	if (!browserEpisode && !req.jserverApp) throw Object.assign(new Error('Downloads require an approved app.'), { status: 403 });
	const id = itemId(req.params.id);
	const item = await jelly(`/Users/${connection().userId}/Items/${id}`);
	if (!(browserEpisode ? ['Episode'] : ['Movie', 'Episode']).includes(item.Type) || item.IsVirtualItem || item.IsMissing) throw Object.assign(new Error('Only available films and episodes can be downloaded.'), { status: 400 });
	const source = item.MediaSources?.[0];
	if (!source?.Id || !source.Size || !/^[a-z0-9]{1,12}$/i.test(source.Container || '')) throw Object.assign(new Error('A downloadable original file is not available for this title.'), { status: 409 });
	return { item, source };
}
app.get('/api/downloads/status', (req, res) => {
	remoteControls.guard(req.jserverViewer);
	accountLimits.guard(req.jserverViewer,true);
	downloadLimit.check(downloadOwner(req));
	res.set('Cache-Control', 'no-store').json({ available: true });
});
app.get('/api/downloads/:id/info', async (req, res) => {
	const { item, source } = await downloadable(req);
	res.json({ id: item.Id, title: item.SeriesName ? `${item.SeriesName} · ${item.Name}` : item.Name, bytes: source.Size, duration: (source.RunTimeTicks || item.RunTimeTicks || 0) / 1e7, container: source.Container, url: `/api/downloads/${item.Id}/file`, quality: 'Original file' });
});
app.get('/api/episode-downloads/:id/info', async (req, res) => {
	const { item, source } = await downloadable(req, true);
	res.set('Cache-Control', 'no-store');
	res.json({ title: item.SeriesName ? `${item.SeriesName} · ${item.Name}` : item.Name, bytes: source.Size, container: source.Container, options:downloadOptions(item, source), url: `/api/episode-downloads/${item.Id}/file` });
});
app.all('/api/episode-downloads/:id/file', (req, res) => sendDownload(req, res, true));
app.all('/api/downloads/:id/file', (req, res) => sendDownload(req, res));
async function sendDownload(req, res, browserEpisode = false) {
	if (!['GET', 'HEAD'].includes(req.method)) return res.sendStatus(405);
	const { item, source } = await downloadable(req, browserEpisode);
	if (!auth.validOwner(req.jserverOwner)) return res.sendStatus(401);
	const quality = downloadQuality(req.query.quality);
	const encodingId = randomUUID();
	const container = quality ? 'mp4' : source.Container;
	const range = req.get('range');
	if (quality && range) return res.status(416).json({ error:'Smaller copies must be downloaded from the beginning.' });
	if (quality && req.method === 'HEAD') { res.set('Content-Type', 'video/mp4'); res.set('Cache-Control', 'private, no-store'); return res.end(); }
	if (range && !/^bytes=\d+-\d*$/.test(range)) return res.sendStatus(416);
	const finishDownload = req.method === 'GET' ? downloadLimit.enter(downloadOwner(req), encodingId) : () => {};
	const controller = new AbortController();
	const abort = () => controller.abort(); res.on('close', abort);
	if (res.destroyed) controller.abort();
	const timer = setTimeout(abort, 45000);
	try {
		const query = new URLSearchParams({ Static: quality ? 'false' : 'true', MediaSourceId: source.Id });
		if (quality) for (const [key,value] of Object.entries({ VideoCodec:'h264', AudioCodec:'aac', VideoBitRate:quality.bitrate-192000, AudioBitRate:192000, MaxAudioChannels:2, MaxWidth:quality.width, EnableAutoStreamCopy:false, AllowVideoStreamCopy:false, AllowAudioStreamCopy:false, PlaySessionId:encodingId, DeviceId:encodingId, Context:'Streaming' })) query.set(key, String(value));
		const response = await fetch(new URL(`/Videos/${item.Id}/stream.${container}?${query}`, upstream), { method: req.method, redirect: 'error', signal: controller.signal, headers: { ...headers('jserver-download'), ...(range ? { Range: range } : {}) } });
		clearTimeout(timer);
		res.status(response.status);
		for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (response.headers.has(name)) res.setHeader(name, response.headers.get(name));
		if (!response.ok) { await response.body?.cancel(); return res.end(); }
		res.setHeader('Cache-Control', 'private, no-store');
		if (browserEpisode) {
			const numbering = Number.isInteger(item.IndexNumber) && Number.isInteger(item.ParentIndexNumber) ? `S${String(item.ParentIndexNumber).padStart(2, '0')}E${String(item.IndexNumber).padStart(2, '0')}` : '';
			const title = [item.SeriesName, numbering, item.Name].filter(Boolean).join(' - ');
			const safe = title.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').slice(0, 180).replace(/[. ]+$/, '') || 'Episode';
			res.attachment(`${safe}${quality ? " - " + quality.label : ""}.${container.toLowerCase()}`);
		}
		if (req.method === 'HEAD' || !response.body) return res.end();
		const contentRange = response.headers.get('content-range')?.match(/^bytes (\d+)-\d+\/(\d+)$/);
		activity.beginDownload(encodingId, req.jserverViewer, item, { type: browserEpisode ? 'browser_download' : 'app_download',
			offset: contentRange ? Number(contentRange[1]) : 0, totalBytes: contentRange ? Number(contentRange[2]) : Number(response.headers.get('content-length')) || 0,
			mediaRoute: auth.isLocal(req) ? 'local' : 'remote', quality: quality?.label || 'Original file' });
		await sendMedia(response.body, req, res, controller.signal, bytes => activity.downloadProgress(encodingId, bytes));
	} catch (error) {
		if (!controller.signal.aborted) {
			if (!res.headersSent) res.status(502).json({ error: 'Download interrupted. Please retry.' });
			else res.destroy(error);
		}
	} finally {
		finishDownload();
		activity.endDownload(encodingId);
		clearTimeout(timer); res.off('close', abort);
		if (quality) await fetch(new URL('/Videos/ActiveEncodings?' + new URLSearchParams({ deviceId:encodingId, playSessionId:encodingId }), upstream), { method:'DELETE', headers:headers(), signal:AbortSignal.timeout(5000) }).catch(() => {});
	}
}

// Private library artwork: authenticated conditional revalidation. The handler
// re-checks authentication and the same viewer authorization as the mint path
// before any 304, and keeps the bounded proxy for the bytes.
const libraryImage = createLibraryImageHandler({
	upstream,
	headers,
	authorize: (req, { id }) => mayMintArtwork(req, { Id: id }),
});
app.get('/images/:id/:kind', libraryImage);

export function safeStreamUrl(value, base, item) {
	const url = new URL(value, base);
	const expected = new URL(base);
	const route = url.pathname.match(/^\/(Videos|Audio)\/([a-f0-9-]+)\//i);
	if (url.origin !== expected.origin || !route || route[2].replaceAll('-', '').toLowerCase() !== item.replaceAll('-', '').toLowerCase()) throw Object.assign(new Error('Invalid stream address.'), { status: 400 });
	for (const key of [...url.searchParams.keys()]) if (['api_key', 'apikey', 'token', 'access_token'].includes(key.toLowerCase())) url.searchParams.delete(key);
	return url.pathname + url.search;
}

function streamLink(session, value, base = upstream, ticket = '') {
	const relative = safeStreamUrl(value, base, session.itemId);
	const resource = Buffer.from(relative).toString('base64url');
	if (session.shareToken) return `/share/${session.shareToken}/stream/${session.id}/${resource}`;
	return ticket ? castPath(session.id, resource, ticket) : `/stream/${session.id}/${resource}`;
}

export function rewritePlaylist(text, base, session, ticket = '') {
	return text.split('\n').map(line => {
		if (line.trim() && !line.startsWith('#')) return streamLink(session, line.trim(), base, ticket);
		return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${streamLink(session, uri, base, ticket)}"`);
	}).join('\n');
}

app.post('/api/play', preparePlayback);
async function lookupEnglish(item,{release='',fingerprint='',duration=0}={}) {
	if(!['Movie','Episode'].includes(item.Type)||(await subtitleLookup.status()).enabled!==true)return null;
	let series;
	if(item.Type==='Episode'){
		if(!item.SeriesId)return null;
		try{series=await vodLibrary.item(item.SeriesId);}catch{return null;}
	}
	return subtitleLookup.lookup({item,series,release,fingerprint,duration});
}
function relayClientUnsupported(req){return req.body?.relayMedia!==true;}
async function preparePlayback(req, res) {
	remoteControls.guard(req.jserverViewer,{itemId:req.body.id});
	accountLimits.guard(req.jserverViewer,req.body.download===true);
	if(!req.body.download&&req.body.replaceSession){
		const existing=sessions.get(String(req.body.replaceSession));
		if(existing&&existing.owner===req.jserverOwner&&existing.relayLeaseId&&!existing.stopping&&String(existing.itemId)===String(req.body.id))return replaceRelayPlayback(req,res,existing);
	}
	const sessionId=randomUUID(),download=req.body.download===true;
	// Reserve before any asynchronous preparation. The check and insert are one
	// synchronous step, so simultaneous requests cannot both take the last screen.
	// The reservation stays pending until the session is committed after insertion.
	if(!download)sessionLimits.acquire(sessionId,req.jserverViewer,{admin:isAdmin(req),pending:true});
	try {
		if (download) {
			if (!req.jserverApp) return res.sendStatus(403);
			const slot = { key: downloadOwner(req), id: randomUUID() };
			const finish = downloadLimit.enter(slot.key, slot.id);
			req.downloadSlot = slot;
			try { return await preparePlaybackContent(req, res, sessionId); }
			finally { finish([...sessions.values()].some(session => session.downloadSlot === slot) && res.writableEnded && res.statusCode < 400); }
		}
		const result=await preparePlaybackContent(req, res, sessionId);
		// A validation response before playback started must not hold a screen.
		if(sessions.has(sessionId))sessionLimits.commit(sessionId);
		else sessionLimits.release(sessionId);
		return result;
	} catch (error) {
		const session=sessions.get(sessionId);
		if(session)await stop(session).catch(()=>{});
		sessionLimits.release(sessionId);
		throw error;
	}
}
async function replaceRelayPlayback(req,res,existing){
	if(String(req.body.id||'')!==String(existing.itemId))return null;
	const mode=existing.relayMode;
	if(!['live','nonstop','vod','recording','catchup'].includes(mode))return res.status(409).json({error:'This relay session cannot be replaced.',code:'RELAY_REPLACE_UNSUPPORTED'});
	// Replacement follows the same per-mode rungs/defaults as the initial
	// request. An absent value preserves the current ceiling; 0 or an invalid
	// value falls back to the mode default instead of forwarding raw bytes.
	const quality=normalizeRelayQuality(mode,req.body.quality,existing.relayQuality);
	// An absent position keeps the current one (a compatibility retry must not
	// reset the film); an explicit value is still clamped like the initial path.
	const changes={quality,audioIndex:req.body.audioIndex,
		subtitleIndex:req.body.subtitleIndex,position:req.body.position===undefined?undefined:Math.max(0,Number(req.body.position)||0),local:auth.isLocal(req)};
	if(req.body.capabilities!==undefined)changes.capabilities=sanitizeCapabilities(req.body.capabilities);
	if(req.body.compatibility!==undefined)changes.compatibility=Boolean(req.body.compatibility);
	const result=await relayMediaService.replace(existing.relayLeaseId,changes);
	const effectiveQuality=normalizeRelayQuality(mode,result.quality,quality);
	const conversionReason=relayConversionReason(result.method||existing.playMethod,{recording:mode==='recording',catchup:mode==='catchup'});
	existing.updated=Date.now();existing.relayQuality=effectiveQuality;existing.playMethod=result.method||existing.playMethod;
	if(Object.hasOwn(changes,'compatibility'))existing.relayParams={...existing.relayParams,compatibility:changes.compatibility};
	if(changes.capabilities!==undefined)existing.relayCapabilities=changes.capabilities;
	existing.relaySessionUrl=result.url;
	pausedPlayback.clear(existing);
	if(Number.isFinite(Number(result.position))&&Number(result.position)>=0)existing.position=Number(result.position);
	relayMediaService.clientHeartbeat(existing.relayLeaseId);
	activity.update(existing.id,{method:existing.playMethod,mediaRoute:'relay',routeSource:'lease',workerId:result.workerId,replaced:true,conversionReason});
	return res.json({session:existing.id,url:result.url,kind:'hls',live:['live','nonstop'].includes(existing.relayMode),duration:result.duration||0,
		subtitleIndex:Number.isInteger(result.subtitleIndex)?result.subtitleIndex:(req.body.subtitleIndex??-1),subtitles:result.subtitles||[],audio:result.audio||[],
		method:result.method||existing.playMethod,videoCodec:result.videoCodec||'',audioCodec:result.audioCodec||'aac',mediaRoute:'relay',routeSource:'lease',workerId:result.workerId,replaced:true,position:result.position||0,quality:effectiveQuality,conversionReason});
}
async function preparePlaybackContent(req, res, sessionId) {
	if(String(req.body.id||'').startsWith('catchup-'))return prepareCatchup(req,res,sessionId);
	if (String(req.body.id || '').startsWith('dispatch-live-')) return prepareDirectChannel(req,res,sessionId);
	if (/^dispatch-(?:movie-\d+|episode-\d+-\d+)$/.test(req.body.id||''))return prepareVod(req,res,sessionId);
	if (/^dispatch-recording-\d+$/.test(req.body.id||''))return prepareVod(req,res,sessionId);
	const id = itemId(req.body.id);
	const device = 'jimbo-' + randomUUID();
	const item = await jelly(`/Users/${connection().userId}/Items/${id}`);
	if (req.body.download && (!req.jserverApp || !['Movie', 'Episode'].includes(item.Type))) return res.status(403).json({ error: 'Offline preparation requires an approved app and an available film or episode.' });
	const session = { downloadSlot: req.downloadSlot, download: req.body.download === true, admin:isAdmin(req), live:item.Type==='TvChannel', id: sessionId, itemId: id, owner: req.jserverOwner, device, updated: Date.now(), position: 0, playMethod: 'DirectPlay' };
	if (req.jserverShare) {
		if (!['Movie', 'Episode', 'TvChannel'].includes(item.Type) || item.IsVirtualItem) return res.sendStatus(404);
		session.shareToken = req.jserverShareToken;
		session.shareExpires = req.jserverShare.expires;
		const existing = [...sessions.values()].filter(entry => entry.owner === session.owner);
		for (const previous of existing.slice(0, Math.max(0, existing.length - 1))) await stop(previous);
	}
	if (item.MediaType === 'Audio' || item.Type === 'Audio') {
		const query = new URLSearchParams({ UserId: connection().userId, DeviceId: device, Container: 'mp3', AudioCodec: 'mp3', AudioBitRate: '320000', TranscodingContainer: 'mp3', TranscodingProtocol: 'http', EnableRedirection: 'false' });
		session.playSessionId = randomUUID().replaceAll('-', '');
		session.playMethod = 'Transcode';
		if (!auth.validOwner(session.owner)) return res.status(401).json({ error: 'Please sign in again.' });
		session.viewer=req.jserverViewer;sessions.set(session.id, session);
		activity.begin(session.id, req.jserverViewer, item, { purpose: session.download ? 'download' : 'watch' });
		const url = streamLink(session, `/Audio/${id}/universal?${query}`);
		session.resource = url.split('/').at(-1);
		session.kind = 'audio';
		return res.json({ session: session.id, url, kind: 'audio', audio: [], subtitles: [], duration: item.RunTimeTicks / 1e7 });
	}
	const quality = [2000000, 4000000, 8000000, 20000000, 80000000].includes(req.body.quality) ? req.body.quality : 20000000;
	// Local Jellyfin direct-play/codec planning uses the same sanitized client
	// contract as relay/copy. Invalid metadata fails closed to the H264 profile.
	const localCapabilities = req.body.capabilities === undefined ? undefined : sanitizeCapabilities(req.body.capabilities);
	const nativeClient = req.body.native === true || req.body.client === 'android';
	// Channel metadata contains a placeholder ID, not the tuner's playable source.
	// Resolve live sources through PlaybackInfo before binding subtitle/audio indexes.
	const itemSource = item.MediaSources?.[0];
	const mediaSource = item.Type === 'TvChannel' || itemSource?.Type === 'Placeholder' || !itemSource?.Id
		? (await jelly(`/Items/${id}/PlaybackInfo?UserId=${connection().userId}`, { device })).MediaSources?.find(source => source.Type !== 'Placeholder')
		: itemSource;
	if (!mediaSource?.Id) throw new Error('Jellyfin did not provide a media source for this item.');
	const existingTracks=mediaSource.MediaStreams||item.MediaStreams||[];
	const sidecars=req.body.textSubtitles===true&&!req.body.download&&!req.jserverShare&&['Movie','Episode'].includes(item.Type);
	const missingEnglish=!existingTracks.some(s=>s.Type==='Subtitle'&&englishSubtitle(s.Language,s.DisplayTitle,s.Title));
	const lookup=()=>lookupEnglish(item,{release:path.basename(mediaSource.Path||item.Path||'').replace(/\.[^.]+$/,''),fingerprint:id+':'+mediaSource.Id,duration:(mediaSource.RunTimeTicks||item.RunTimeTicks||0)/1e7});
	// Caption downloads must not hold up the video. Legacy clients retain burned captions.
	const lookupEnabled=missingEnglish&&(await subtitleLookup.status()).enabled;
	const external=missingEnglish&&!sidecars?await (wantsSubtitleLookup(req.body)?lookup():subtitleLookup.lookup({item,release:path.basename(mediaSource.Path||item.Path||'').replace(/\.[^.]+$/,''),fingerprint:id+':'+mediaSource.Id,duration:(mediaSource.RunTimeTicks||item.RunTimeTicks||0)/1e7,cachedOnly:true})):null;
	const captionTracks=existingTracks.filter(textSubtitle);
	if(sidecars){
		session.captionSources=new Map(captionTracks.map(track=>[track.Index,{route:`/Videos/${id}/${encodeURIComponent(mediaSource.Id)}/Subtitles/${track.Index}/Stream.vtt`} ]));
		if(lookupEnabled)session.captionSources.set(downloadedSubtitleIndex,{lookup});
	}
	const captionOptions=sidecars?[...existingTracks.filter(s=>s.Type==='Subtitle').map(s=>({index:s.Index,label:s.DisplayTitle||s.Language||'Subtitles',...(textSubtitle(s)?{url:directStreamLink(session,Buffer.from(`subtitle-${s.Index}.vtt`).toString('base64url'))}:{})})),...(lookupEnabled?[{index:downloadedSubtitleIndex,label:'English · OpenSubtitles',url:directStreamLink(session,Buffer.from(`subtitle-${downloadedSubtitleIndex}.vtt`).toString('base64url'))}]:[])]:null;
	if(external&&(req.body.subtitleIndex===downloadedSubtitleIndex||(!Number.isInteger(req.body.subtitleIndex)&&req.body.preferEnglishSubtitles===true))){
		const query=new URLSearchParams({Static:'true',MediaSourceId:mediaSource.Id});
		const direct=await vodPlayer.start({type:'local',route:`/Videos/${id}/stream?${query}`},{quality,audioIndex:req.body.audioIndex,externalSubtitle:external,subtitleIndex:downloadedSubtitleIndex});
		if(!auth.validOwner(session.owner)||res.destroyed){await direct.stop();return res.sendStatus(req.jserverShare?410:401);}
		Object.assign(session,{direct,kind:'hls',playMethod:'Transcode',resource:Buffer.from('index.m3u8').toString('base64url')});
		session.viewer=req.jserverViewer;sessions.set(session.id,session);activity.begin(session.id,req.jserverViewer,item,{purpose:session.download?'download':'watch'});
		activity.update(session.id,{method:'Transcode',qualityMbps:quality/1e6,videoCodec:'h264',audioCodec:'aac',conversionReason:'English OpenSubtitles captions included in the picture'});
		return res.json({session:session.id,url:directStreamLink(session,session.resource),kind:'hls',live:false,duration:direct.duration,subtitleIndex:downloadedSubtitleIndex,subtitles:[...existingTracks.filter(s=>s.Type==='Subtitle').map(s=>({index:s.Index,label:s.DisplayTitle||s.Language||'Subtitles'})),{index:external.index,label:external.label}],audio:direct.audio,method:'Transcode'});
	}
	let subtitleIndex = subtitleChoice(req.body.subtitleIndex===downloadedSubtitleIndex&&!sidecars?{subtitleIndex:-1}:req.body, existingTracks);
	if(sidecars&&lookupEnabled&&subtitleIndex<0&&wantsSubtitleLookup(req.body))subtitleIndex=downloadedSubtitleIndex;
	const separateCaption=sidecars&&session.captionSources.has(subtitleIndex);
	const burnSubtitles = subtitleIndex >= 0&&!separateCaption;
	const forceTranscode = Boolean(req.body.compatibility) || burnSubtitles;
	// A local Jellyfin file must never be refused because our own ceiling is
	// below its bitrate. Jellyfin answers "BitrateExceedsLimit" instead of
	// direct-playing, which looks like a broken file to the viewer. On the LAN
	// the ceiling is raised past the source bitrate; remote playback keeps the
	// chosen quality limit because that genuinely protects bandwidth.
	const localViewer = auth.isLocal(req) || auth.isHome(req);
	const sourceBitrate = Number(mediaSource?.Bitrate) || 0;
	const playbackCeiling = localViewer
		? Math.max(quality, 200000000, sourceBitrate > 0 ? Math.ceil(sourceBitrate * 1.05) : 0)
		: quality;
	const body = {
		UserId: connection().userId, MediaSourceId: mediaSource.Id, DeviceProfile: deviceProfile(forceTranscode, playbackCeiling, nativeClient, req.body.nativeAudio, localCapabilities),
		MaxStreamingBitrate: playbackCeiling, MaxAudioChannels: 2, StartTimeTicks: 0,
		EnableDirectPlay: !forceTranscode && !Number.isInteger(req.body.audioIndex),
		EnableDirectStream: !burnSubtitles, EnableTranscoding: true, AllowVideoStreamCopy: !forceTranscode,
		AllowAudioStreamCopy: true, AutoOpenLiveStream: true, SubtitleStreamIndex: separateCaption ? -1 : subtitleIndex,
		AlwaysBurnInSubtitleWhenTranscoding: burnSubtitles
	};
	if (Number.isInteger(req.body.audioIndex)) body.AudioStreamIndex = req.body.audioIndex;
	let playback = await jelly(`/Items/${id}/PlaybackInfo`, { method: 'POST', body, device });
	if (playback.ErrorCode === 'BitrateExceedsLimit' && localViewer) {
		// Belt and braces: an unusual profile can still trip the limit. One
		// bounded retry at an effectively unlimited ceiling, local viewers only.
		const uncapped = 1000000000;
		playback = await jelly(`/Items/${id}/PlaybackInfo`, { method: 'POST', body: { ...body, MaxStreamingBitrate: uncapped, DeviceProfile: deviceProfile(forceTranscode, uncapped, nativeClient, req.body.nativeAudio, localCapabilities) }, device });
	}
	if (playback.ErrorCode || !playback.MediaSources?.length) throw new Error(playback.ErrorCode === 'BitrateExceedsLimit' ? 'This file is above the streaming bitrate limit for this connection.' : `Jellyfin could not prepare this stream${playback.ErrorCode ? ': ' + playback.ErrorCode : ''}.`);
	const source = playback.MediaSources[0];
	session.playSessionId = playback.PlaySessionId;
	session.mediaSourceId = source.Id;
	session.liveStreamId = source.LiveStreamId;
	let url;
	let kind;
	if (source.SupportsDirectPlay && body.EnableDirectPlay) {
		const query = new URLSearchParams({ Static: 'true', MediaSourceId: source.Id, DeviceId: device, PlaySessionId: playback.PlaySessionId });
		url = `/Videos/${id}/stream.${source.Container || 'mp4'}?${query}`;
		kind = 'video';
	} else if (source.TranscodingUrl) {
		url = source.TranscodingUrl;
		kind = 'hls';
		session.playMethod = 'Transcode';
	} else {
		await stop(session);
		throw new Error('Jellyfin did not offer a browser-compatible stream. Check transcoding on the Jellyfin server.');
	}
	// Media3 cannot seek a Matroska file whose Cues are only named by a chained
	// SeekHead. The app detects that unseekable DirectPlay timeline and asks for
	// the same file through the ffmpeg HLS player, which can seek anywhere.
	if (kind === 'video' && req.body.seekFallback === true && !session.download) {
		if (!auth.validOwner(session.owner)) {
			await stop(session);
			return res.status(req.jserverShare ? 410 : 401).json({ error: req.jserverShare ? 'This shared link is no longer available.' : 'Please sign in again.' });
		}
		// Keep the original sidecar caption menu (including downloaded/external
		// Jellyfin captions) instead of guessing ffprobe stream indexes. HLS
		// can carry those WebVTT tracks alongside the video.
		const keepSidecars = Boolean(sidecars && captionOptions);
		const encoded = await vodPlayer.start({ type: 'local', route: url }, { quality, audioIndex: req.body.audioIndex,
			capabilities: localCapabilities, compatibility: req.body.compatibility === true,
			textSubtitles: keepSidecars ? false : req.body.textSubtitles === true,
			preferEnglishSubtitles: keepSidecars ? false : req.body.preferEnglishSubtitles === true,
			subtitleIndex: keepSidecars ? -1 : req.body.subtitleIndex }).catch(error => {
				// Capacity, not the file, can reject a fallback. Do not turn a
				// working DirectPlay picture into a failed play request.
				if (error.status === 503) return null;
				throw error;
			});
		if (encoded) {
			if (!auth.validOwner(session.owner) || res.destroyed) { await encoded.stop(); return res.sendStatus(req.jserverShare ? 410 : 401); }
			session.direct = encoded;
			session.kind = 'hls';
			const seekMethod = encoded.method || 'Transcode';
			session.playMethod = seekMethod;
			session.resource = Buffer.from('index.m3u8').toString('base64url');
			if (!session.captionSources) session.captionSources = encoded.captionSources;
			for (const track of encoded.subtitles) if (session.captionSources?.has(track.index)) track.url = directStreamLink(session, Buffer.from(`subtitle-${track.index}.vtt`).toString('base64url'));
			session.viewer = req.jserverViewer;
			sessions.set(session.id, session);
			activity.begin(session.id, req.jserverViewer, item, { purpose: 'watch' });
			activity.update(session.id, { method: seekMethod, qualityMbps: quality / 1e6, videoCodec: encoded.videoCodec || 'h264', audioCodec: encoded.audioCodec || 'aac',
				conversionReason: seekMethod === 'Copy' ? 'Original file has no usable seek index; video and audio copied'
					: seekMethod === 'Remux' ? 'Original file has no usable seek index; audio remuxed to AAC'
						: 'Original file has no usable seek index' });
			const seekReason = seekMethod === 'Copy' ? 'Original file has no usable seek index; video and audio copied'
				: seekMethod === 'Remux' ? 'Original file has no usable seek index; audio remuxed to AAC'
					: 'Original file has no usable seek index';
			session.conversionReason = seekReason;
			return res.json({ session: session.id, url: directStreamLink(session, session.resource), kind: 'hls', live: false,
				duration: encoded.duration, subtitleIndex: keepSidecars ? subtitleIndex : encoded.subtitleIndex,
				subtitles: keepSidecars ? captionOptions : encoded.subtitles, audio: encoded.audio,
				method: seekMethod, videoCodec: encoded.videoCodec || '', audioCodec: encoded.audioCodec || 'aac', seekFallback: true,
				conversionReason: seekReason });
		}
	}
	if (!auth.validOwner(session.owner)) {
		await stop(session);
		return res.status(req.jserverShare ? 410 : 401).json({ error: req.jserverShare ? 'This shared link is no longer available.' : 'Please sign in again.' });
	}
	session.viewer=req.jserverViewer;sessions.set(session.id, session);
	activity.begin(session.id, req.jserverViewer, item, { purpose: session.download ? 'download' : 'watch' });
	const video = (source.MediaStreams || []).find(track => track.Type === 'Video');
	const audioTrack = (source.MediaStreams || []).find(track => track.Type === 'Audio');
	const conversionReason = session.playMethod === 'DirectPlay' ? 'Original file supported'
		: jellyfinTranscodeReason(source, source.TranscodingUrl || url, { forceTranscode, burnSubtitles });
	session.conversionReason = conversionReason;
	activity.update(session.id, { method: session.playMethod, qualityMbps: quality / 1e6, sourceMbps: Math.round((source.Bitrate || 0) / 10000) / 100,
		videoCodec: video?.Codec || '', audioCodec: audioTrack?.Codec || '', resolution: video?.Width && video?.Height ? `${video.Width}×${video.Height}` : '',
		conversionReason });
	session.resource = streamLink(session, url).split('/').at(-1);
	session.kind = kind;
	if(kind==='video'&&req.body.client==='android'&&captionOptions){
		const tracks=existingTracks.filter(track=>track.Type==='Subtitle');
		for(const option of captionOptions){const track=tracks.find(track=>track.Index===option.index);if(track&&!track.IsExternal&&textSubtitle(track))Object.assign(option,{embedded:true,ordinal:tracks.indexOf(track),language:track.Language||'',nativeTitle:track.Title||''});}
	}
	// The requested rung is already the negotiated ceiling for this local
	// PlaybackInfo (MaxStreamingBitrate/DeviceProfile use the same value). Echo
	// it so the client can show and step from the real ceiling instead of
	// treating the answer as unknown (0).
	res.json({ session: session.id, url: streamLink(session, url), kind, subtitleIndex, quality,
		duration: (source.RunTimeTicks || item.RunTimeTicks || 0) / 1e7, live: item.Type === 'TvChannel',
		audio: (source.MediaStreams || []).filter(x => x.Type === 'Audio').map(x => ({ index: x.Index, label: x.DisplayTitle || x.Language || 'Audio', selected: x.Index === source.DefaultAudioStreamIndex })),
		subtitles: captionOptions || [...(source.MediaStreams || []).filter(x => x.Type === 'Subtitle').map(x => ({ index: x.Index, label: x.DisplayTitle || x.Language || 'Subtitles' })),...(external?[{index:external.index,label:external.label}]:[])],
		method: session.playMethod, ...(conversionReason ? { conversionReason } : {})
	});
}

async function prepareCatchup(req,res,sessionId){
	if(!features.catchup)return res.status(404).json({error:'Catch-up is not enabled on this server.'});
	if(req.body.download)return res.sendStatus(403);
	if(req.jserverShare&&!features.relayMedia)return res.sendStatus(403);
	const quality=normalizeRelayQuality('catchup',req.body.quality);
	const item=await catchup.resolve(req.body.id),channel=(await dispatcharr.channels()).find(c=>'dispatch-live-'+c.id===item.ChannelId);
	if(!channel)return res.sendStatus(404);
	if(features.relayMedia){
		if(relayClientUnsupported(req))throw Object.assign(Error('This app version cannot use relay media. Update the app; main media was not used as a fallback.'),{status:409,code:'RELAY_CLIENT_UNSUPPORTED'});
		const relay=await relayMediaService.prepare({session:{id:sessionId},viewer:req.jserverViewer,itemId:item.Id,mode:'catchup',
			params:{channelId:channel.id,item},quality,position:Math.max(0,Number(req.body.position)||0),local:auth.isLocal(req),share:Boolean(req.jserverShare),onRelease:(id,detail)=>{sessionLimits.release(id);}});
		if(!auth.validOwner(req.jserverOwner)||res.destroyed){await relayMediaService.stop(relay.leaseId,{acknowledged:false,reason:'owner_race'});return res.sendStatus(req.jserverShare?410:401);}
		const session={id:sessionId,admin:isAdmin(req),itemId:item.Id,owner:req.jserverOwner,updated:Date.now(),position:0,kind:'hls',playMethod:relay.method||'Relay',
			relayLeaseId:relay.leaseId,relayWorkerId:relay.workerId,mediaRoute:'relay',routeSource:'lease',resource:'',relaySessionUrl:relay.url,relayMode:'catchup',relayParams:{channelId:channel.id,item},relayQuality:quality};
		if(req.jserverShare){session.shareToken=req.jserverShareToken;session.shareExpires=req.jserverShare.expires;}
		session.viewer=req.jserverViewer;sessions.set(session.id,session);activity.begin(session.id,req.jserverViewer,item,{purpose:'watch'});
		activity.update(session.id,{method:'Relay',qualityMbps:quality/1e6,mediaRoute:'relay',routeSource:'lease',workerId:relay.workerId});
		return res.json({session:session.id,url:relay.url,kind:'hls',live:false,duration:relay.duration||0,subtitleIndex:Number.isInteger(relay.subtitleIndex)?relay.subtitleIndex:-1,subtitles:relay.subtitles||[],audio:relay.audio||[],method:relay.method||'Relay',mediaRoute:'relay',routeSource:'lease',workerId:relay.workerId,position:relay.position||0,quality,
			conversionReason:relayConversionReason(relay.method||'Relay',{catchup:true})});
	}
	const direct=await catchupPlayer.start(channel,item,Math.max(0,Number(req.body.position)||0),{quality});
	if(!auth.validOwner(req.jserverOwner)||res.destroyed){await direct.stop();return res.sendStatus(401);}
	const session={id:sessionId,admin:isAdmin(req),itemId:item.Id,owner:req.jserverOwner,updated:Date.now(),position:0,kind:'hls',playMethod:direct.method,direct,resource:Buffer.from('index.m3u8').toString('base64url')};
	session.viewer=req.jserverViewer;sessions.set(session.id,session);activity.begin(session.id,req.jserverViewer,item,{purpose:'watch'});
	res.json({session:session.id,url:directStreamLink(session,session.resource),kind:'hls',live:false,duration:direct.duration,subtitleIndex:-1,subtitles:[],audio:direct.audio,method:direct.method,quality:direct.quality,
		conversionReason:relayConversionReason(direct.method,{catchup:true})});
}

async function prepareDirectChannel(req,res,sessionId) {
	if(req.body.download)return res.sendStatus(403);
	const channel=(await dispatcharr.channels()).find(c=>'dispatch-live-'+c.id===req.body.id);
	if(!channel)return res.status(404).json({error:'This channel is no longer in Dispatcharr.'});
	remoteControls.guard(req.jserverViewer,{nonstop:channel.nonstop});
	const quality=normalizeRelayQuality(channel.nonstop?'nonstop':'live',req.body.quality);
	const capabilities=req.body.capabilities===undefined?undefined:sanitizeCapabilities(req.body.capabilities);
	if(features.relayMedia){
		if(relayClientUnsupported(req))throw Object.assign(Error('This app version cannot use relay media. Update the app; main media was not used as a fallback.'),{status:409,code:'RELAY_CLIENT_UNSUPPORTED'});
		const relay=await relayMediaService.prepare({session:{id:sessionId},viewer:req.jserverViewer,itemId:req.body.id,mode:channel.nonstop?'nonstop':'live',
			params:{channelId:channel.id,compatibility:Boolean(req.body.compatibility)},quality,audioIndex:req.body.audioIndex,position:Math.max(0,Number(req.body.position)||0),local:auth.isLocal(req),share:Boolean(req.jserverShare),
			capabilities,onRelease:(id,detail)=>{sessionLimits.release(id);}});
		if(!auth.validOwner(req.jserverOwner)||res.destroyed){await relayMediaService.stop(relay.leaseId,{acknowledged:false,reason:'owner_race'});return res.sendStatus(req.jserverShare?410:401);}
		const session={nonstop:Boolean(channel.nonstop),live:true,id:sessionId,admin:isAdmin(req),itemId:req.body.id,owner:req.jserverOwner,updated:Date.now(),position:0,kind:'hls',playMethod:relay.method||'Relay',
			resource:'',relayLeaseId:relay.leaseId,relayWorkerId:relay.workerId,mediaRoute:'relay',routeSource:'lease',relaySessionUrl:relay.url,
			relayMode:channel.nonstop?'nonstop':'live',relayParams:{channelId:channel.id,compatibility:Boolean(req.body.compatibility)},relayQuality:quality,relayCapabilities:capabilities};
		if(req.jserverShare){session.shareToken=req.jserverShareToken;session.shareExpires=req.jserverShare.expires;}
		session.viewer=req.jserverViewer;sessions.set(session.id,session);
		activity.begin(session.id,req.jserverViewer,channelView(channel),{purpose:'watch'});
		activity.update(session.id,{method:relay.method||'Relay',qualityMbps:quality/1e6,mediaRoute:'relay',routeSource:'lease',workerId:relay.workerId});
		return res.json({session:session.id,url:relay.url,kind:'hls',live:true,duration:0,subtitleIndex:-1,subtitles:[],audio:relay.audio||[],method:relay.method||'Relay',mediaRoute:'relay',routeSource:'lease',workerId:relay.workerId,position:relay.position||0,quality,
			conversionReason:relayConversionReason(relay.method||'Relay')});
	}
	const session={nonstop:Boolean(channel.nonstop),live:true,id:sessionId,admin:isAdmin(req),itemId:req.body.id,owner:req.jserverOwner,updated:Date.now(),position:0,kind:'hls',quality};
	if(req.jserverShare){session.shareToken=req.jserverShareToken;session.shareExpires=req.jserverShare.expires;}
	session.viewer=req.jserverViewer;
	const direct=await directPlayer.start(channel,{quality,compatibility:Boolean(req.body.compatibility),audioIndex:req.body.audioIndex,capabilities,
		onStopped:()=>directSessionCleanup.finalize(session)});
	if(directSessionCleanup.finalized(session)){
		try{await direct.stop();}catch{}
		return res.status(503).json({error:'This channel stopped while starting. Please try again.'});
	}
	if(!auth.validOwner(req.jserverOwner)||res.destroyed){await direct.stop();return res.sendStatus(401);}
	Object.assign(session,{playMethod:direct.method,direct,resource:Buffer.from('index.m3u8').toString('base64url')});
	sessions.set(session.id,session);
	activity.begin(session.id,req.jserverViewer,channelView(channel),{purpose:'watch'});
	activity.update(session.id,{method:direct.method,qualityMbps:quality/1e6,videoCodec:direct.videoCodec,audioCodec:direct.audioCodec,copyBlockers:direct.copyBlockers,
		conversionReason:direct.method==='Remux'?'Dispatcharr · original video, browser-compatible audio':'Dispatcharr · compatible video conversion'});
	res.json({session:session.id,url:directStreamLink(session,session.resource),kind:'hls',live:true,duration:0,subtitleIndex:-1,subtitles:[],audio:direct.audio,method:direct.method,quality,
		conversionReason:relayConversionReason(direct.method)});
}

async function prepareVod(req,res,sessionId) {
	if(req.body.download)return res.sendStatus(403);
	if(req.jserverShare&&!features.relayMedia)return res.sendStatus(403);
	const recorded=String(req.body.id).startsWith('dispatch-recording-');
	// Return the effective rung so an Auto client can resolve a strictly lower
	// quality instead of assuming 80 Mbps. Unknown values keep the per-mode
	// default, which is also what the worker/player clamp to.
	const quality=normalizeRelayQuality(recorded?'recording':'vod',req.body.quality);
	const capabilities=req.body.capabilities===undefined?undefined:sanitizeCapabilities(req.body.capabilities);
	const item=recorded?await recordings.item(req.body.id):await vodLibrary.item(req.body.id);
	if(item?.Source==='local'&&(item.IsMissing===true||(item.Type==='Series'&&Number(item.ChildCount)===0)))return res.status(409).json({error:'This local copy is not currently playable.'});
	if(item?.Type==='Series'){
		// A season container is not proof of a playable episode. Refuse a direct
		// series play request unless the bounded episode check proves availability.
		const availability=await vodLibrary.verifySeries([item.Id],{limit:1,deadlineMs:1200,concurrency:1});
		if(availability.states.get(item.Id)!=='available')return res.status(409).json({error:'No playable episodes are available for this series yet.'});
	}
	if(recorded&&!item?.Playable)return res.status(409).json({error:'This recording is not ready to play yet. It will appear as ready when Dispatcharr finishes saving it.'});
	const source=recorded?{type:'recording',id:item.RecordingId,provider:'Dispatcharr recording'}:await vodSource(req.body.id);
	const lookupAvailable=!recorded&&(await subtitleLookup.status()).enabled;
	if(features.relayMedia){
		if(relayClientUnsupported(req))throw Object.assign(Error('This app version cannot use relay media. Update the app; main media was not used as a fallback.'),{status:409,code:'RELAY_CLIENT_UNSUPPORTED'});
		const position=Math.max(0,Number(req.body.position)||0);
		let relay=await relayMediaService.prepare({session:{id:sessionId},viewer:req.jserverViewer,itemId:req.body.id,mode:recorded?'recording':'vod',
			params:recorded?{recordingId:item.RecordingId,compatibility:Boolean(req.body.compatibility)}:{type:source.type,uuid:source.uuid,account:source.account,streamId:source.streamId,provider:source.provider,
				textSubtitles:req.body.textSubtitles===true,preferEnglishSubtitles:req.body.preferEnglishSubtitles===true,compatibility:Boolean(req.body.compatibility)},
			quality,audioIndex:req.body.audioIndex,subtitleIndex:req.body.subtitleIndex,position,local:auth.isLocal(req),share:Boolean(req.jserverShare),
			capabilities,onRelease:(id,detail)=>{sessionLimits.release(id);}});
		if(!auth.validOwner(req.jserverOwner)||res.destroyed){await relayMediaService.stop(relay.leaseId,{acknowledged:false,reason:'owner_race'});return res.sendStatus(req.jserverShare?410:401);}
		// Only look up an external subtitle when the worker's own probe found no
		// embedded English track. Explicit external selection always wins.
		const embeddedEnglish=(relay.subtitles||[]).some(track=>/^en(g)?$/i.test(track.language||'')||/english/i.test(track.label||''));
		const wantsExternal=lookupAvailable&&(req.body.subtitleIndex===downloadedSubtitleIndex||(!embeddedEnglish&&(req.body.textSubtitles===true||req.body.preferEnglishSubtitles===true)));
		if(wantsExternal){
			const found=await lookupEnglish(item,{fingerprint:source.uuid,duration:(item.RunTimeTicks||0)/1e7}).catch(()=>null);
			if(found){
				try{relay=await relayMediaService.replace(relay.leaseId,{externalSubtitle:srtToVtt(await readFile(found.file,'utf8')),subtitleIndex:1000001,position});}
				catch{/* Keep the embedded/no-subtitle session rather than fail video. */}
			}
		}
		const session={id:sessionId,admin:isAdmin(req),itemId:item.Id,owner:req.jserverOwner,updated:Date.now(),position,kind:'hls',playMethod:relay.method||'Relay',relayLeaseId:relay.leaseId,relayWorkerId:relay.workerId,vod:true,mediaRoute:'relay',routeSource:'lease',resource:'',
			relaySessionUrl:relay.url,relayMode:recorded?'recording':'vod',relayParams:recorded?{recordingId:item.RecordingId,compatibility:Boolean(req.body.compatibility)}:{type:source.type,uuid:source.uuid,account:source.account,streamId:source.streamId,provider:source.provider,compatibility:Boolean(req.body.compatibility)},relayQuality:quality,relayCapabilities:capabilities};
		const conversionReason=relayConversionReason(relay.method||'Relay',{recording:recorded});
		if(req.jserverShare){session.shareToken=req.jserverShareToken;session.shareExpires=req.jserverShare.expires;}
		session.viewer=req.jserverViewer;sessions.set(session.id,session);activity.begin(session.id,req.jserverViewer,item,{purpose:'watch'});
		activity.update(session.id,{method:relay.method||'Relay',qualityMbps:quality/1e6,videoCodec:relay.videoCodec||'',audioCodec:relay.audioCodec||'aac',mediaRoute:'relay',routeSource:'lease',workerId:relay.workerId,conversionReason});
		return res.json({session:session.id,url:relay.url,kind:'hls',live:false,duration:relay.duration||(item.RunTimeTicks||0)/1e7,
			subtitleIndex:Number.isInteger(relay.subtitleIndex)?relay.subtitleIndex:-1,subtitles:relay.subtitles||[],audio:relay.audio||[],method:relay.method||'Relay',
			videoCodec:relay.videoCodec||'',audioCodec:relay.audioCodec||'aac',
			provider:source.provider,mediaRoute:'relay',routeSource:'lease',workerId:relay.workerId,position,quality,conversionReason});
	}
	const direct=await vodPlayer.start(source,{textSubtitles:req.body.textSubtitles===true,quality,audioIndex:req.body.audioIndex,subtitleIndex:req.body.subtitleIndex,preferEnglishSubtitles:req.body.preferEnglishSubtitles,
		capabilities,compatibility:Boolean(req.body.compatibility),
		...(lookupAvailable?{lookupSubtitles:duration=>lookupEnglish(item,{fingerprint:source.uuid,duration})}:{})});
	if(!auth.validOwner(req.jserverOwner)||res.destroyed){await direct.stop();return res.sendStatus(401);}
	const session={id:sessionId,admin:isAdmin(req),itemId:item.Id,owner:req.jserverOwner,updated:Date.now(),position:0,kind:'hls',playMethod:direct.method||'Transcode',direct,vod:true,quality,resource:Buffer.from('index.m3u8').toString('base64url')};
	session.captionSources=direct.captionSources;
	for(const track of direct.subtitles)if(session.captionSources?.has(track.index))track.url=directStreamLink(session,Buffer.from(`subtitle-${track.index}.vtt`).toString('base64url'));
	session.viewer=req.jserverViewer;sessions.set(session.id,session);activity.begin(session.id,req.jserverViewer,item,{purpose:'watch'});
	activity.update(session.id,{method:direct.method||'Transcode',qualityMbps:quality/1e6,videoCodec:direct.videoCodec||'h264',audioCodec:direct.audioCodec||'aac',conversionReason:source.provider+' · streamed title prepared for your browser'});
	res.json({session:session.id,url:`/stream/${session.id}/${session.resource}`,kind:'hls',live:false,duration:direct.duration,subtitleIndex:direct.subtitleIndex,subtitles:direct.subtitles,audio:direct.audio,method:direct.method||'Transcode',videoCodec:direct.videoCodec||'',audioCodec:direct.audioCodec||'aac',provider:source.provider,quality,
		conversionReason:relayConversionReason(direct.method||'Transcode')});
}

app.post('/api/sessions/:id/prepare', async (req, res) => {
	const session = sessions.get(req.params.id);
	if (!session) return res.sendStatus(410);
	if (session.owner !== req.jserverOwner) return res.sendStatus(403);
	if (session.direct || session.playStarted || session.warming || session.kind !== 'hls') return res.sendStatus(204);
	session.warming = true;
	session.warmTimer = setTimeout(() => { if (!session.playStarted) void stop(session); }, 20000).unref();
	const controller = new AbortController();
	if (!session.controllers) session.controllers = new Set();
	session.controllers.add(controller);
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		await primeStream(Buffer.from(session.resource, 'base64url').toString(), {
			signal: controller.signal,
			fetchResource: (resource, signal) => fetch(new URL(safeStreamUrl(resource, upstream, session.itemId), upstream), { headers: headers(session.device), redirect: 'error', signal }),
			resolve: (base, entry) => safeStreamUrl(new URL(entry, new URL(base, upstream)).href, upstream, session.itemId)
		});
	} catch { /* Best effort: normal playback can still start this session. */ }
	finally { clearTimeout(timeout); session.controllers.delete(controller); }
	res.sendStatus(204);
});
app.post('/api/sessions/:id/cast', (req, res) => {
	const session = sessions.get(req.params.id);
	if (!session) return res.sendStatus(410);
	if (session.owner !== req.jserverOwner) return res.sendStatus(403);
	// Require an explicit same-origin JSON action before creating a receiver capability.
	if ((req.get('origin') !== req.jserverOrigin && !(req.jserverLocal && req.get('origin') === process.env.PUBLIC_ORIGIN)) || !req.is('application/json')) return res.sendStatus(403);
	const origin = process.env.PUBLIC_ORIGIN || '';
	if (!origin.startsWith('https://')) return res.status(409).json({ error: 'The secure public address must be configured before casting.' });
	if (session.relayLeaseId) {
		if (!session.relaySessionUrl) return res.status(409).json({ error: 'This relay session has no cast address.', code: 'RELAY_CAST_UNAVAILABLE' });
		session.updated = Date.now();
		const url = new URL(session.relaySessionUrl, origin).href;
		const lease = relayMediaService.leases.get(session.relayLeaseId);
		const expires = Math.min(lease?.hardEndsAt || Date.now() + 6 * 60 * 60 * 1000, Date.now() + 6 * 60 * 60 * 1000);
		return res.json({ url, localUrl: url, contentType: 'application/x-mpegURL', relay: true, leaseId: session.relayLeaseId, expires });
	}
	const ticket = issueCastTicket(session, origin);
	session.updated = Date.now();
	// Only a sender that reached the LAN entry receives the local receiver address.
	const localUrl = req.jserverLocal ? new URL(new URL(ticket.url).pathname, localPlaybackOrigin).href : undefined;
	res.json({ ...ticket, localUrl, contentType: session.kind === 'hls' ? 'application/x-mpegURL' : session.kind === 'audio' ? 'audio/mpeg' : 'video/mp4' });
});

app.get('/stream/:session/:resource', serveStream);
async function serveStream(req, res) {
	const session = sessions.get(req.params.session);
	if (!session) return res.status(410).send('Playback expired. Please press play again.');
	if (session.relayLeaseId) return res.status(410).send('This relay session plays from the relay media prefix, not from this server.');
	if (session.owner !== req.jserverOwner) return res.sendStatus(403);
	if (!auth.validOwner(session.owner)) return res.sendStatus(410);
	return proxyStream(req, res, session);
}

async function proxyStream(req, res, session, ticket = '') {
	// Re-evaluate the media connection; a session prepared at home may move away.
	const connection=auth.identity(req);
	session.viewer={...session.viewer,local:connection.local,home:connection.home,client:connection.client,...(connection.appMarkers?{appMarkers:connection.appMarkers}:{})};
	// Account links can change while a stream is open. Re-key it and count it now.
	sessionLimits.touch(session.id,session.viewer,{admin:session.admin||isAdmin(req),download:Boolean(session.download)});
	remoteControls.guard(session.viewer,session);
	accountLimits.guard(session.viewer,Boolean(session.download));
	const slot = session.downloadSlot;
	if (!session.download || !slot || req.method === 'HEAD') return proxyStreamContent(req, res, session, ticket);
	const finish = downloadLimit.enter(slot.key, slot.id);
	try { return await proxyStreamContent(req, res, session, ticket); }
	finally { finish(!session.stopping && res.statusCode < 400 && res.writableEnded); }
}
async function proxyStreamContent(req, res, session, ticket = '') {
	const caption=/^subtitle-(\d+)\.vtt$/.exec(Buffer.from(req.params.resource,'base64url').toString());
	if(caption){
		const source=session.captionSources?.get(Number(caption[1]));
		if(!source)return res.sendStatus(404);
		// This route has already passed normal owner or single-session capability validation.
		res.type('text/vtt').set('Cache-Control','private, no-store');
		if(req.method==='HEAD')return res.end();
		if(!source.pending)source.pending=(async()=>{
			if(source.lookup){const found=await source.lookup();return found?srtToVtt(await readFile(found.file,'utf8')):'WEBVTT\n\n';}
			const response=await fetch(new URL(source.route,upstream),{headers:headers(session.device),redirect:'error',signal:AbortSignal.timeout(60000)});
			if(!response.ok){await response.body?.cancel();throw Error('Caption extraction failed');}
			let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>4*1024*1024)throw Error('Captions too large');chunks.push(chunk);}
			const text=Buffer.concat(chunks).toString('utf8');if(!text.trimStart().startsWith('WEBVTT'))throw Error('Invalid captions');return text;
		})().catch(()=>{source.pending=null;return 'WEBVTT\n\n';});
		return res.send(await source.pending);
	}
	if(session.direct)return proxyDirectStream(req,res,session,ticket);
	session.playStarted = true; clearTimeout(session.warmTimer);
	session.updated = Date.now();
	const relative = safeStreamUrl(Buffer.from(req.params.resource, 'base64url').toString(), upstream, session.itemId);
	const url = new URL(relative, upstream);
	const controller = new AbortController();
	if (!session.controllers) session.controllers = new Set();
	session.controllers.add(controller);
	const timeout = setTimeout(() => controller.abort(), 60000);
	const abort = () => controller.abort();
	res.on('close', abort);
	try {
		const requestHeaders = headers(session.device);
		if (req.headers.range) requestHeaders.Range = req.headers.range;
		const response = await fetch(url, { headers: requestHeaders, signal: controller.signal, redirect: 'error', method: req.method === 'HEAD' ? 'HEAD' : 'GET' });
		clearTimeout(timeout);
		res.status(response.status);
		const type = response.headers.get('content-type') || 'application/octet-stream';
		if (!response.ok && response.status !== 206) { await response.body?.cancel(); return res.send('Jellyfin could not provide this stream.'); }
		if (req.method !== 'HEAD') {
			const identity = auth.identity(req);
			activity.update(session.id, { state: 'playing', client: identity.client, ...(identity.appMarkers ? { appMarkers: identity.appMarkers } : {}), local: auth.isLocal(req), mediaRoute: auth.isLocal(req) ? 'local' : 'remote', mediaIp: identity.ip });
		}
		res.setHeader('Cache-Control', 'no-store');
		if (url.pathname.endsWith('.m3u8') || type.includes('mpegurl')) {
			res.type('application/vnd.apple.mpegurl');
			if (req.method === 'HEAD') return res.end();
			return res.send(rewritePlaylist(await response.text(), url, session, ticket));
		}
		for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (response.headers.has(name)) res.setHeader(name, response.headers.get(name));
		if (req.method === 'HEAD' || !response.body) return res.end();
		await sendMedia(response.body, req, res, controller.signal);
	} catch (error) {
		if (!controller.signal.aborted && !res.headersSent) res.status(502).send('The stream was interrupted. Please try again.');
	} finally { clearTimeout(timeout); res.off('close', abort); session.controllers.delete(controller); }
}

export function directStreamLink(session,resource,ticket='') {
	if(session.shareToken)return `/share/${session.shareToken}/stream/${session.id}/${resource}`;
	return ticket?castPath(session.id,resource,ticket):`/stream/${session.id}/${resource}`;
}
// Client-visible media errors are JSON, bounded and free of provider URLs,
// credentials and local internals. The player already produces user-safe text;
// this is a final guard for any other terminal error on the media route.
function boundedMediaError(error) {
	const text=String(error?.message||'The stream was interrupted. Please try again.')
		.replace(/\bhttps?:\/\/\S+/gi,'[url]')
		.replace(/\b(access_?token|token|api_?key|password|passwd|pwd|auth|authorization|signature|sig|secret)=([^\s&,;"'<>]+)/gi,'$1=[redacted]')
		.replace(/[ \t]+/g,' ').trim();
	return (text||'The stream was interrupted. Please try again.').slice(0,320);
}
async function proxyDirectStream(req,res,session,ticket) {
	const file=mediaFile(Buffer.from(req.params.resource,'base64url').toString());
	session.playStarted=true;session.updated=Date.now();
	let body;
	try{body=await session.direct.read(file);}
	catch(error){
		if(error.code==='VOD_COMPATIBILITY_REQUIRED'){
			res.set('Cache-Control','no-store').set('X-Tellybox-Compatibility','required');
			res.on('finish',()=>{void stop(session).catch(()=>{});});
			return res.status(409).type('text/plain').send('Compatibility playback is required.');
		}
		if(error.code==='ENOENT')throw Object.assign(Error('This TV segment has expired.'),{status:410});
		if(error.status&&error.code){
			res.set('Cache-Control','no-store');
			return res.status(error.status).json({error:boundedMediaError(error),code:String(error.code).slice(0,80)});
		}
		throw error;
	}
	res.set('Cache-Control','no-store');
	if(file.endsWith('.m3u8')) {
		const playlist=body.toString().split('\n').map(line=>{
			if(line.startsWith('#'))return line.replace(/URI="([^"\r\n]+)"/g,(_,file)=>'URI="'+directStreamLink(session,Buffer.from(mediaFile(file)).toString('base64url'),ticket)+'"');
			if(!line.trim())return line;
			const resource=Buffer.from(mediaFile(line.trim())).toString('base64url');
			return directStreamLink(session,resource,ticket);
		}).join('\n');
		return res.type('application/vnd.apple.mpegurl').send(req.method==='HEAD'?'':playlist);
	}
	if(file.endsWith('.vtt'))return res.type('text/vtt').send(req.method==='HEAD'?'':body);
	res.type('video/mp2t').set('Content-Length',body.length);
	if(req.method==='HEAD')return res.end();
	const identity=auth.identity(req);
	activity.update(session.id,{state:'playing',client:identity.client,...(identity.appMarkers?{appMarkers:identity.appMarkers}:{}),local:auth.isLocal(req),mediaRoute:auth.isLocal(req)?'local':'remote',mediaIp:identity.ip});
	const controller=new AbortController(), abort=()=>controller.abort();
	session.controllers ||= new Set();session.controllers.add(controller);res.on('close',abort);
	try{await sendMedia(Readable.toWeb(Readable.from([body])),req,res,controller.signal);}catch(error){if(!controller.signal.aborted)throw error;}
	finally{res.off('close',abort);session.controllers.delete(controller);}
}

async function sendMedia(body, req, res, signal, onBytes) {
	const source = Readable.fromWeb(body);
	const session = sessions.get(req.params.session);
	async function* progress(stream) {
		for await (const chunk of stream) {
			if (onBytes) onBytes(chunk.length);
			if (session?.download) { session.downloadBytes = (session.downloadBytes || 0) + chunk.length; activity.update(session.id, { downloadBytes: session.downloadBytes }); }
			yield chunk;
		}
	}
	// Inspect the actual entry point for each request. A home IP through Oracle still
	// uses internet upload; LAN cast receivers and opted-in local streams do not.
	async function* checked(){for await(const chunk of source){
		remoteControls.guard(session?.viewer||req.jserverViewer,session);
		accountLimits.guard(session?.viewer||req.jserverViewer,Boolean(session?.download||onBytes));
		if(session&&!session.download){sessionLimits.media(session.id,session.viewer,{admin:session.admin||isAdmin(req)});accountLimits.media(session.id,session.viewer);}
		yield chunk;
	}}
	const viewer=session?.viewer||req.jserverViewer||{};
	const highPriority=Boolean(session?.admin||isAdmin(req)||viewer.home);
	const transfer=auth.isLocal(req)
		? checked()
		: uploadLimit.stream(checked(),signal,req.params.session||`download:${req.jserverOwner}:${req.params.id}`,{
			account:accountLimits.key(viewer)||req.jserverOwner||'guest',
			weight:highPriority?3:1
		});
	await pipeline(onBytes || session?.download ? progress(transfer) : transfer, res, { signal });
}

async function report(session, action, values = {}) {
	if(session.direct || session.relayLeaseId || session.mediaRoute === 'relay') return;
	return jelly(`/Sessions/Playing${action === 'start' ? '' : '/' + (action === 'stop' ? 'Stopped' : 'Progress')}`, {
		method: 'POST', device: session.device,
		body: { ItemId: session.itemId, MediaSourceId: session.mediaSourceId, PlaySessionId: session.playSessionId,
			PositionTicks: Math.round(session.position * 1e7), PlayMethod: session.playMethod, CanSeek: true, IsPaused: Boolean(values.paused), IsMuted: Boolean(values.muted), VolumeLevel: 100 }
	});
}

async function stop(session, { relayRevoke = false } = {}) {
	if (session.stopping) return session.stopping;
	if (session.direct) {
		session.stopping = (async () => {
			directSessionCleanup.finalize(session);
			try { await session.direct.stop(); } catch {}
		})();
		return session.stopping;
	}
	pausedPlayback.clear(session);
	// A relay revoke keeps the screen slot as a tombstone until the worker
	// acknowledges the stop or the tombstone expires. Every other stop releases now.
	if (!relayRevoke) sessionLimits.release(session.id);
	session.stopping = (async () => {
	clearTimeout(session.warmTimer);
	for (const controller of session.controllers || []) controller.abort();
	activity.update(session.id, { state: 'ended', position: session.position });
	if(session.relayLeaseId){
		if(relayRevoke){session.relayRevoked=true;await relayMediaService.revoke(session.relayLeaseId,'owner_revoked');}
		else await relayMediaService.stop(session.relayLeaseId,{acknowledged:true,reason:'client_stop'});
		accountLimits.end(session.id);sessions.delete(session.id);return;
	}
	await Promise.allSettled([
		report(session, 'stop'),
		jelly(`/Videos/ActiveEncodings?DeviceId=${session.device}&PlaySessionId=${session.playSessionId}`, { method: 'DELETE', device: session.device }),
		...(session.liveStreamId ? [jelly('/LiveStreams/Close?' + new URLSearchParams({ liveStreamId: session.liveStreamId }), { method: 'POST', device: session.device })] : [])
	]);
	})().then(() => { accountLimits.end(session.id);sessionLimits.release(session.id);sessions.delete(session.id); if (session.downloadSlot) downloadLimit.release(session.downloadSlot.key, session.downloadSlot.id); }).catch(error => { sessionLimits.release(session.id); session.stopping = null; throw error; });
	return session.stopping;
}

app.post('/api/sessions/:id', updateSession);
function terminalStopFor(id, owner) {
	return terminalStopRecord(pausedStops, id, owner);
}
function terminalStop(session, code, message) {
	if (!session || pausedStops.has(session.id) || session.stopping) return;
	pausedStops.set(session.id, {
		owner: session.owner,
		position: Number(session.position) || 0,
		at: Date.now(),
		code,
		message
	});
	pausedPlayback.clear(session);
	pausedEnforcer.enforce(session);
}
async function updateSession(req, res) {
	const session = sessions.get(req.params.id);
	const stopped = terminalStopFor(req.params.id, req.jserverOwner);
	if (!session) {
		if (stopped) return res.status(409).json({ error: stopped.message, code: stopped.code, position: stopped.position });
		return res.sendStatus(204);
	}
	if (session.owner !== req.jserverOwner) return res.sendStatus(403);
	if (stopped) return res.status(409).json({ error: stopped.message, code: stopped.code, position: stopped.position });
	if (session.stopping) { await session.stopping; return res.sendStatus(204); }
	if(req.body.action!=='stop'){remoteControls.guard(session.viewer,session);accountLimits.guard(session.viewer,Boolean(session.download));}
	session.updated = Date.now();
	if (Number.isFinite(req.body.position)) session.position = Math.max(0, req.body.position);
	session.direct?.touch?.(Boolean(req.body.paused));
	// Stop always wins. It must not touch the screen reservation (which may have
	// expired or moved while the session was open). stop() aborts controllers and
	// releases the screen at once, then completes upstream cleanup.
	if (req.body.action === 'stop') {
		pausedPlayback.clear(session);
		await stop(session);
		return res.sendStatus(204);
	}
	pausedPlayback.observe(session, req.body);
	if(session.relayLeaseId){
		relayMediaService.clientHeartbeat(session.relayLeaseId);
		// Relay media never passes through sendMedia, so start the existing
		// wall-clock account/viewing interval from authenticated client progress.
		accountLimits.media(session.id,req.jserverViewer||session.viewer);
		if(!session.download)sessionLimits.media(session.id,req.jserverViewer||session.viewer,{admin:session.admin||isAdmin(req)});
	}
	if(!session.download)sessionLimits.touch(session.id,req.jserverViewer||session.viewer,{admin:session.admin||isAdmin(req),heartbeat:true});
	accountLimits.heartbeat(session.id,!req.body.paused&&!req.body.buffering);
	const fallback = ['disabled', 'away', 'unreachable', 'playback-failed', 'lan_ok', 'lan_timeout', 'lan_refused', 'lan_instance_mismatch', 'lan_origin_rejected', 'remote_only'].includes(req.body.localFallback) ? req.body.localFallback : undefined;
	if (session.viewer && req.jserverViewer?.client) session.viewer.client = req.jserverViewer.client;
	if (session.viewer && req.jserverViewer?.appMarkers) session.viewer.appMarkers = req.jserverViewer.appMarkers;
	activity.update(session.id, { position: session.position, heartbeat: true, ...(req.jserverViewer?.client ? { client: req.jserverViewer.client } : {}), ...(req.jserverViewer?.appMarkers ? { appMarkers: req.jserverViewer.appMarkers } : {}), rate: req.body.rate, state: req.body.buffering ? 'buffering' : req.body.paused ? 'paused' : 'playing', ...(fallback ? { localFallback: fallback } : {}) });
	if (['start', 'progress'].includes(req.body.action)) await report(session, req.body.action, req.body);
	res.sendStatus(204);
}

setInterval(()=>{
	accountLimits.tick();relayMediaService.tick();
	for(const session of pausedPlayback.expired(sessions)){
		const minutes=pausedTimeout.status().minutes;
		terminalStop(session,PAUSED_TIMEOUT,`Playback was paused for ${minutes} minutes. Your place was saved; choose the title again to resume.`);
	}
	pausedEnforcer.tick();
	for(const session of sessions.values())if(!remoteControls.allowed(session.viewer,session)||!accountLimits.allowed(session.viewer,Boolean(session.download)))void stop(session,{relayRevoke:Boolean(session.relayLeaseId)}).catch(()=>{});
},1000).unref();

setInterval(() => {
	for (const session of sessions.values()) {
		if (session.shareExpires && session.shareExpires <= Date.now()) void stop(session);
		else if (session.castExpires && session.castExpires <= Date.now()) void stop(session);
		else if (!session.controllers?.size) {
			const paused = pausedPlayback.state(session).paused;
			const pauseMinutes = pausedTimeout.status().minutes;
			// A configured pause timeout owns this session. Only the 0 disabled
			// setting falls back to a long idle safety cap so media is not held forever.
			if (paused && pauseMinutes > 0) continue;
			const idleMs = paused ? 6 * 60 * 60 * 1000 : (session.download ? 8 * 60 : 5) * 60 * 1000;
			if (Date.now() - session.updated > idleMs) terminalStop(session, SESSION_IDLE, 'Playback was closed after a long idle period. Your place was saved; choose the title again to resume.');
		}
	}
	for (const [id, stopped] of pausedStops) if (Date.now() - stopped.at > TERMINAL_TOMBSTONE_MS) pausedStops.delete(id);
}, 60000).unref();

// Prepare/warm-up TTLs and idle sessions must release remote screens even if a
// client never sends another heartbeat or media request.
setInterval(()=>sessionLimits.tick(),15000).unref();

app.get('/vendor/hls.min.js', (req, res) => {
	// Versioned or not, this vendored file changes only with a release. It is
	// safe to keep in the browser cache for a year.
	res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
	res.sendFile(path.join(root, 'node_modules/hls.js/dist/hls.min.js'));
});
// These shell files are reached only after the auth gate above. The explicit
// route lets them keep their ETag while replacing the auth-wide no-store, and
// still leaves unauthenticated requests rejected exactly as before.
for (const file of ['app.js', 'home-124.css']) {
	app.get('/' + file, (req, res) => {
		res.setHeader('Cache-Control', 'max-age=0, must-revalidate');
		res.sendFile(path.join(root, 'public', file));
	});
}
app.use(publicAssets.page({ isLocal: isLocalOrHome }));
app.use(express.static(path.join(root, 'public')));
app.use((error, req, res, next) => {
	if (res.headersSent) return next(error);
	console.error('Request failed:', req.method, /^\/(cast-stream|share)\//.test(req.path) ? '/capability/[redacted]' : req.path.split('/').slice(0, 3).join('/'), error.name);
	if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
	res.status(error.status || 500).json({ error: error.message || 'Something went wrong. Please try again.', ...(error.code ? { code:error.code } : {}), ...(error.retryAfter ? { retryAfter:error.retryAfter } : {}) });
});

// A conservative shared background-work gate. It includes downloads and
// unknown activity; if the activity snapshot cannot be read, heavy work waits.
const backgroundBusy=()=>{
	try{return activity.snapshot().active.length>0;}catch{return true;}
};
const playbackBusy=()=>{
	try{return activity.snapshot().active.some(item=>item.purpose!=='download');}catch{return true;}
};
const ownerSession=createOwnerSession({origin:setupStreamsOrigin()});
const cacheJobs=createCacheJobs({
	file:path.join(process.env.CATALOGUE_CACHE_DIR||process.env.AUTH_DIR||path.join(root,'auth-data'),'cache-refresh-state.json'),
	isBusy:backgroundBusy,
	generation:()=>String(seerr.discoverCache?.generation?.()||'')+'\u0000'+String(seerr.status?.().source||''),
	tasks:{
		// TTL-aware: a fresh snapshot is skipped, never forcibly rebuilt.
		discover:()=>seerr.discoverCache?.warmNow?seerr.discoverCache.warmNow():{skipped:1},
		trending:({isBusy})=>seerr.warmTrending({isBusy}),
		// The normal bounded slice; the provider catalogue is fetched only when
		// it is genuinely stale. No force:true and no full rebuild.
		index:({isBusy})=>vodLibrary.refreshSeriesIndex({isBusy})
	}
});
const requireOwner=async(req,res)=>{
	const result=await ownerSession(req);
	if(result.ok)return true;
	if(result.unavailable)res.status(503).json({error:'Installation sign-in service is unavailable.'});
	else res.status(401).json({error:'Sign in as installation administrator.',signInRequired:true});
	return false;
};
installQbittorrentRoutes(app,{
	requireOwner,
	allowSummary:req=>auth.isOwnerAdmin(req),
	allowDownloads:req=>auth.isOwnerAdmin(req),
	directory:process.env.AUTH_DIR||path.join(root,'auth-data'),
	sameOrigin:req=>req.get('origin')===req.jserverOrigin
});
// Owner-only cached status and queued refresh. The queue shares the existing
// bounded tasks; it never adds a second scheduler or bypasses playback.
app.get('/api/admin/cache/status',async(req,res)=>{
	res.set('Cache-Control','no-store');
	if(!await requireOwner(req,res))return;
	const status=cacheJobs.status();
	const discover=seerr.discoverCache?.status?.()||null;
	const trending=seerr.status?.()||null;
	const index=vodLibrary.status().seriesIndex;
	const DAY=86400000, HOUR=3600000, now=Date.now();
	res.json({...status,
		services:{discover,trending,index},
		// Estimates from the existing automatic jobs, not a promise of an exact
		// second. Null means the job has not completed yet in this process.
		nextExpected:{
			discover:Number(discover?.lastDailyAt)>0?Number(discover.lastDailyAt)+DAY:null,
			trending:Number(trending?.newestAt)>0?Number(trending.newestAt)+HOUR:null,
			index:Number(index?.updated)>0?Number(index.updated)+HOUR:null
		}});
});
app.post('/api/admin/cache/refresh',async(req,res)=>{
	res.set('Cache-Control','no-store');
	if(!await requireOwner(req,res))return;
	if(!req.is('application/json')||req.get('origin')!==req.jserverOrigin)return res.sendStatus(403);
	const result=cacheJobs.request(req.body?.scope??'all',{manual:true});
	if(result.accepted||result.reason==='coalesced')return res.status(202).json(result);
	if(result.reason==='cooldown'){
		res.set('Retry-After',String(Math.max(1,Math.ceil(Number(result.retryAfterMs||0)/1000))));
		return res.status(429).json(result);
	}
	return res.status(400).json(result);
});

if (process.env.NODE_ENV !== 'test') {
	// Durable shared-public Discover snapshots refresh daily without a visit.
	// Existing personalised/request/availability overlays stay per request.
	void seerr.startDiscoverCache();
	void homeNetwork.refresh();
	setInterval(() => { void homeNetwork.refresh(); }, 60000).unref();
	// Run independently of browsing; previously saved series are usable during startup and refresh.
	// Sweep only a small stale slice (never force the whole catalogue) and never
	// while live playback is active. A busy/deferred run retries shortly instead
	// of spinning, and the next bounded slice is attempted an hour later.
	let indexTimer;
	const scheduleSeriesIndex=(delay)=>{
		indexTimer=setTimeout(async()=>{
			let deferred=false;
			try{const result=await vodLibrary.refreshSeriesIndex({isBusy:backgroundBusy});deferred=Boolean(result?.deferred);}catch{}
			scheduleSeriesIndex(deferred?10*60000:3600000);
		},delay);
		indexTimer.unref?.();
	};
	scheduleSeriesIndex(1500);
	// Default Discover charts are a separate cache from the browse/provider
	// snapshots. Warm only the first-screen rows, sequentially, on a clock and
	// never while live playback is active. Failures retain last-good snapshots
	// and retry later instead of spinning.
	const trendingPreload = createTrendingPreload({
		// Forward the scheduler's playback/download gate so it is also checked
		// between chart rows and between chart resolution pairs mid-run.
		warm: (options = {}) => seerr.warmTrending(options),
		isBusy: backgroundBusy,
		clock: Date.now
	});
	trendingPreload.start();
	app.listen(Number(process.env.PORT || 8082), '0.0.0.0', () => console.log(`jServer local entry on port ${process.env.PORT || 8082}`));
	app.listen(Number(process.env.REMOTE_PORT || 8083), '0.0.0.0', () => console.log(`jServer password-protected entry on port ${process.env.REMOTE_PORT || 8083}`));
}
export { app };
