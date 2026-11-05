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
import { randomUUID } from 'node:crypto';
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
import { recentTvEpisodes, episodeReleaseDates } from './tv-releases.mjs';
import { createShares, installPublicShares } from './shares.mjs';
import {createAccountLimits} from './account-limits.mjs';
import {createSessionLimits} from './session-limits.mjs';
import {createRemoteControls} from './remote-controls.mjs';
import { createUploadLimit } from './upload-limit.mjs';
import { createPlaybackDefaults } from './playback-defaults.mjs';
import { primeStream } from './warmup.mjs';
import { proxyImage } from './image-proxy.mjs';
import { deviceProfile, textSubtitle, wantsSubtitleLookup, srtToVtt } from './playback-profile.mjs';
import { readFile } from 'node:fs/promises';
import { subtitleChoice, englishSubtitle } from './subtitle-choice.mjs';
import { createSubtitleLookup, downloadedSubtitleIndex } from './subtitle-lookup.mjs';
import { createDispatcharr } from './dispatcharr.mjs';
import { createDispatcharrGuide, channelView } from './dispatcharr-guide.mjs';
import {createCatchup} from './catchup.mjs';
import {createBroadcastResume} from './broadcast-resume.mjs';
import {createCatchupPlayer} from './catchup-player.mjs';
import { createDirectPlayer, mediaFile } from './dispatcharr-player.mjs';
import { createVodLibrary } from './vod-library.mjs';
import { createVodMetadata } from './vod-metadata.mjs';
import { trailerView } from './trailers.mjs';
import { createNonstopMetadata } from './nonstop-metadata.mjs';
import { createVodPlayer } from './vod-player.mjs';
import { createRecordings } from './recordings.mjs';
import { createRecordingDeletion, installRecordingDeletion } from './recording-deletion.mjs';
import { loadCapabilities, optionalDispatcharr } from './homelab/runtime.mjs';
import { installReleaseVersion, serverRelease } from './release-version.mjs';
import { createHomeAssistantIntegration, installHomeAssistantStats } from './home-assistant.mjs';
import { createRelayMediaService } from './relay-media/install.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const upstream = new URL(process.env.JELLYFIN_URL || 'http://127.0.0.1:1');
const configPath = path.join(process.env.DATA_DIR || path.join(root, 'data'), 'connection.json');
const features = loadCapabilities(path.dirname(configPath));
const dispatcharr = optionalDispatcharr(createDispatcharr({ file:path.join(process.env.AUTH_DIR || path.join(root, 'auth-data'), 'dispatcharr.json'), origin:process.env.DISPATCHARR_URL || 'http://127.0.0.1:1' }), features);
const dispatcharrGuide = features.live ? createDispatcharrGuide(dispatcharr,fetch,Date.now,path.join(process.env.CATALOGUE_CACHE_DIR || process.env.AUTH_DIR || path.join(root,'auth-data'),'dispatcharr-guide.json')) : Object.assign(async () => ({channels:[],available:false,stale:false}), {archive:async () => ({channels:[],available:false})});
const directPlayer = createDirectPlayer({origin:dispatcharr.origin});
const subtitleLookup=createSubtitleLookup({directory:process.env.AUTH_DIR||path.join(root,'auth-data')});
const vodPlayer = createVodPlayer({open:(source,options)=>source.type==='local'?fetch(new URL(source.route,upstream),{headers:{...headers(),...(options.range?{Range:options.range}:{})},redirect:'error',signal:options.signal}):source.type==='recording'?dispatcharr.recordingFile(source.id,options):dispatcharr.stream(source,options),close:(token,source)=>['recording','local'].includes(source.type)?Promise.resolve():dispatcharr.stopStream(token)});
const recordings = createRecordings({dispatcharr,guide:dispatcharrGuide});
const sessions = new Map();
const downloadLimit = createDownloadLimit();
const instanceId = randomUUID();
const localPlaybackOrigin = new URL(process.env.LOCAL_PLAYBACK_ORIGIN || 'http://127.0.0.1:8082').origin;
const app = express();
app.disable('x-powered-by');
app.get('/homelab-ready', (req, res) => res.json({ instance: process.env.HOMELAB_INSTANCE || '' }));
app.use(express.json({ limit: '16kb' }));
// Installation settings have one owner. Legacy editors must not change generated files.
app.use((req,res,next)=>{
	if(process.env.HOMELAB==='1'&&req.method==='POST'&&['/api/dispatcharr/connection','/api/subtitles/connection','/api/auth/email/config'].includes(req.path))
		return res.status(409).json({error:'Manage this connection in Installation settings. Save and Apply there to keep all settings together.'});
	next();
});
app.use((req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('Referrer-Policy', 'no-referrer');
	res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' https://www.gstatic.com; style-src 'self'; img-src 'self' data: https://image.tmdb.org https://artworks.thetvdb.com; media-src 'self' blob: ${localPlaybackOrigin}; connect-src 'self' ${localPlaybackOrigin}; frame-src https://www.gstatic.com; worker-src 'self' blob:; frame-ancestors 'none'`);
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

const activity = createActivity(process.env.AUTH_DIR || path.join(root, 'auth-data'), { bandwidth: () => uploadLimit.status(), transfer: id => uploadLimit.measuredMbps(id) });
const accountLimits=createAccountLimits(process.env.AUTH_DIR||path.join(root,'auth-data'),{resolveViewer:viewer=>auth.viewerAccount(viewer)});
const sessionLimits=createSessionLimits({accountLimits,exists:id=>sessions.has(id)});
const remoteControls=createRemoteControls(process.env.AUTH_DIR||path.join(root,'auth-data'));
const isAdmin=req=>req.jserverApp?.role==='admin';
const uploadLimit = createUploadLimit(process.env.AUTH_DIR || path.join(root, 'auth-data'));
const playbackDefaults = createPlaybackDefaults(process.env.AUTH_DIR || path.join(root, 'auth-data'));
// Private main-worker control is registered before the viewer gate. Caddy blocks
// /internal/* publicly; the handler also verifies worker signatures and peers.
const relayMediaService = createRelayMediaService({ directory: process.env.RELAY_STATE_DIR || path.dirname(configPath), accountLimits, publicOrigin: process.env.PUBLIC_ORIGIN || '', maxSessions: 3,
	enabled: process.env.RELAY_MEDIA_ENABLED === '1' || features.relayMedia === true });
relayMediaService.install(app);
const serverHealth = createServerHealth(process.env.HOST_HEALTH_PATH || path.join(path.dirname(configPath), 'host-health.json'), { bandwidth: () => uploadLimit.status(), streaming: () => activity.snapshot().active.filter(item => item.purpose !== 'download').length });
const homeAssistant = createHomeAssistantIntegration({
	directory: process.env.AUTH_DIR || path.join(root, 'auth-data'),
	activity, serverHealth, uploadLimit, version: serverRelease.version
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
	seriesEpisodes: async id => (await jelly(`/Shows/${itemId(id)}/Episodes?UserId=${connection().userId}&IsMissing=false&Fields=Overview`)).Items.filter(x => !x.IsVirtualItem).map(itemView),
	sharedItem: async id => jelly(`/Users/${connection().userId}/Items/${itemId(id)}`),
	sameOrigin: req => req.get('origin') === process.env.PUBLIC_ORIGIN || req.get('origin') === `${req.protocol}://${req.get('host')}`
});
const homeNetwork = createHomeNetwork(process.env.HOME_IP_ENDPOINT || '', { onChange: previous => auth.revokeOwner(`home:${previous}`) });
const auth = installAuth(app, {
	installationCapabilities: {...features,managedInstallation:process.env.HOMELAB==='1',publicOrigin:process.env.PUBLIC_ORIGIN||''},
	audit: activity,
	uploadLimit,playbackDefaults,accountLimits,remoteControls,serverHealth,
	validShareOwner: shares.validOwner,
	instanceId,
	localPlaybackOrigin,
	tunnelStatus: async () => ({ ...await remoteAccessStatus(process.env.PUBLIC_ORIGIN || '', process.env.QUICK_TUNNEL_METRICS || 'http://quick-tunnel:2000'), homeAccess: homeNetwork.status() }),
	homeNetwork,
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

const insights = insightsFromFile(path.join(path.dirname(configPath), 'insights.json'));
installTvControl(app, { auth, sessions });
// Only the signed-in caller's own allowance. No person, device or other account details.
app.get('/api/viewing-status', (req, res) => {
	res.set('Cache-Control', 'no-store');
	const admin = isAdmin(req);
	res.json(accountLimits.viewing(req.jserverViewer, { admin, activeSessions: sessionLimits.count(req.jserverViewer, { admin }) }));
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
const seerr=installSeerr(app, { configPath: path.join(path.dirname(configPath), 'seerr.json'), audit: activity.record, enrich:async items=>vodLibrary.availability(await insights.enrich(items)), library:discoveryLibrary });
app.get('/api/coming-soon', async (req, res) => {
	res.set('Cache-Control', 'no-store');
	res.json(await insights.upcoming());
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
	for (const key of ['Id', 'Name', 'Type', 'MediaType', 'CollectionType', 'Overview', 'ProductionYear', 'PremiereDate', 'DateCreated', 'ProviderIds', 'OfficialRating', 'CommunityRating', 'RunTimeTicks', 'Genres', 'IndexNumber', 'ParentIndexNumber', 'SeriesName', 'SeriesId', 'Album', 'Artists', 'ImageTags', 'BackdropImageTags', 'ParentBackdropItemId', 'ParentBackdropImageTags', 'PrimaryImageAspectRatio', 'ChildCount', 'CurrentProgram']) {
		if (item[key] !== undefined) result[key] = item[key];
	}
	if (item.CurrentProgram) result.CurrentProgram = { Name: item.CurrentProgram.Name, Overview: item.CurrentProgram.Overview };
	if (['Movie', 'Series'].includes(item.Type)) result.Ratings = [score('Viewer score', item.CommunityRating), score('Critics', item.CriticRating, 100)].filter(Boolean);
	const trailer = trailerView({ remoteTrailers: item.RemoteTrailers });
	if (trailer) result.Trailer = trailer;
	return result;
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
const vodLibrary=createVodLibrary({dispatcharr,metadata:vodMetadata,file:path.join(process.env.CATALOGUE_CACHE_DIR || process.env.AUTH_DIR || path.join(root,'auth-data'),'vod-catalogue.json'),
	linksFile:path.join(process.env.CATALOGUE_CACHE_DIR || process.env.AUTH_DIR || path.join(root,'auth-data'),'series-links.json'),
	localItems:async()=>{
		if (!features.jellyfin) return [];
		const items=[];
		for(let start=0;start<100000;start+=1000){
			const query=new URLSearchParams({UserId:connection().userId,Recursive:'true',IncludeItemTypes:'Movie,Series',LocationTypes:'FileSystem',Fields:'Overview,Genres,ProviderIds,DateCreated,PrimaryImageAspectRatio',Limit:'1000',StartIndex:String(start)});
			const data=await jelly('/Items?'+query);items.push(...(data.Items||[]).filter(i=>!i.IsVirtualItem));
			if(!data.Items?.length||items.length>=data.TotalRecordCount||data.Items.length<1000)break;
		}
		return libraryItems(items);
	},
	localItem:async id=>(await libraryItems([await jelly(`/Users/${connection().userId}/Items/${itemId(id)}?Fields=RemoteTrailers`)]))[0],
	localEpisodes:async id=>(await seriesEpisodes(itemId(id))).map(itemView)
});
app.get('/api/web/items',async(req,res)=>res.json(await vodLibrary.list(req.query)));
const globalSearch=createGlobalSearch({library:vodLibrary,discover:seerr,channels:async()=>(await dispatcharr.channels()).map(channelView)});
app.get('/api/search',async(req,res)=>{res.set('Cache-Control','no-store');res.json(await globalSearch(req.query));});
app.get('/search',(req,res)=>res.sendFile(path.join(root,'public','search.html')));
app.get('/api/web/releases',async(req,res)=>res.json({items:await vodLibrary.releases('Movie')}));
app.get('/api/web/releases/tv',async(req,res)=>{
	const query=new URLSearchParams({UserId:connection().userId,Recursive:'true',IncludeItemTypes:'Episode',IsMissing:'false',Fields:'Genres,DateCreated',Limit:'500',SortBy:'PremiereDate',SortOrder:'Descending'});
	const added=new URLSearchParams(query);added.set('SortBy','DateCreated');
	const [dated,newlyAdded,streamed,airings]=await Promise.all([jelly('/Items?'+query),jelly('/Items?'+added),vodLibrary.releasedEpisodes(),insights.recentEpisodeDates()]);
	const local=[...new Map([...(dated.Items||[]),...(newlyAdded.Items||[])].map(item=>[item.Id,item])).values()];
	const available=episodeReleaseDates([...local,...streamed],airings);
	res.json({items:recentTvEpisodes(available,new Date(),20).map(item=>item.Source==='streamed'?item:itemView(item))});
});
app.get('/api/dispatcharr/catalogue',dispatcharrAdmin,(req,res)=>res.json(vodLibrary.status()));
app.post('/api/dispatcharr/catalogue/refresh',dispatcharrAdmin,(req,res)=>{void vodLibrary.refreshSeriesIndex({force:true});res.status(202).json({ok:true});});
app.get('/api/web/items/:id',async(req,res)=>{
	if (/^dispatch-live-[a-f0-9-]{36}$/i.test(req.params.id)) return res.json(await shareItem(req.params.id));
	const item=await vodLibrary.item(req.params.id);
	if(item.Source==='streamed'&&item.Type==='Movie')item.Provider=(await vodSource(req.params.id)).provider;
	res.json(item);
});
app.get('/api/web/items/:id/episodes',async(req,res)=>res.json(await vodLibrary.episodes(req.params.id)));
const episodeNext = createEpisodeNext({ library: vodLibrary, metadata: seerr.catalogueMetadata });
const mediaSegments = createMediaSegments({ directory: process.env.AUTH_DIR || path.join(root, 'auth-data'), item: vodLibrary.item, jelly });
app.get(['/api/web/items/:id/next', '/api/items/:id/next'], async (req, res) => res.json(await episodeNext(req.params.id, String(req.query.series || ''))));
app.get(['/api/web/items/:id/segments', '/api/items/:id/segments'], async (req, res) => res.json(await mediaSegments.get(req.params.id)));
app.get('/api/web/art/:kind/:id',async(req,res)=>{
	if(!['movie','series'].includes(req.params.kind)||!/^\d+$/.test(req.params.id))return res.sendStatus(404);
	const item=await vodLibrary.raw(`dispatch-${req.params.kind}-${req.params.id}`),logo=Number(item.data.logo?.id);
	if(!Number.isSafeInteger(logo)||logo<=0)return res.sendStatus(404);
	return proxyImage(res,{url:new URL(`/api/vod/vodlogos/${logo}/cache/`,dispatcharr.origin),maxBytes:3*1024*1024,
		allow:/^image\/(png|jpeg|webp|gif)(?:;|$)/i,cache:'private, max-age=1800',label:'Artwork'});
});
app.get('/api/web/tmdb-art/:type/:id/:kind',async(req,res)=>{
	const {type,id,kind}=req.params;
	if(!['movie','tv'].includes(type)||!/^\d+$/.test(id)||!['poster','backdrop'].includes(kind))return res.sendStatus(404);
	const image=await vodMetadata.artwork(type,id,kind);if(!image)return res.sendStatus(404);
	return proxyImage(res,{url:`https://image.tmdb.org/t/p/${kind==='backdrop'?'w1280':'w500'}${image}`,maxBytes:5*1024*1024,
		allow:/^image\/(png|jpeg|webp)(?:;|$)/i,cache:'private, max-age=86400',timeoutMs:10000,label:'TMDB artwork'});
});
const vodSources=new Map();
async function vodSource(id) {
	const hit=vodSources.get(id);if(hit&&Date.now()-hit.time<300000)return hit.value;
	const raw=await vodLibrary.raw(id);
	if(!['Movie','Episode'].includes(raw.type))throw Object.assign(Error('Choose a film or episode to play.'),{status:400});
	let account,streamId,provider='Dispatcharr';
	if(raw.type==='Movie'){
		const providers=await dispatcharr.api(`/api/vod/movies/${raw.id}/providers/`);
		const chosen=providers.filter(p=>p.m3u_account?.is_active!==false).sort((a,b)=>(Number(b.m3u_account?.priority)||0)-(Number(a.m3u_account?.priority)||0))[0];
		if(chosen){account=Number(chosen.m3u_account?.id);streamId=chosen.stream_id;provider=String(chosen.m3u_account?.name||'Dispatcharr').slice(0,100);}
	}
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
installRecordingDeletion(app,{manager:recordingDeletion,allowed:req=>auth.isHome(req)||req.jserverApp?.role==='admin',audit:activity.record});
app.get('/api/local-recordings',async(req,res)=>res.json({items:features.jellyfin?(await recordingDeletion.localList()).map(item=>({...itemView(item),Source:'local-recording',State:'completed',Playable:true,ChannelName:'Local recording',StartDate:item.DateCreated})):[]}));
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
	res.json({items:enriched.map(c=>({...channelView(c),Genres:c.genres})), groups:[...new Set(channels.map(c=>channelView(c).Group))], categorisation:nonstopMetadata.status()});
});
app.get('/api/dispatcharr/channels/:id/image', async (req,res) => {
	const channel=(await dispatcharr.channels()).find(c=>c.id===req.params.id);
	if(!channel?.logo)return res.sendStatus(404);
	const url=new URL(channel.logo,dispatcharr.origin);
	if(url.origin!==dispatcharr.origin || !/^\/api\/channels\/logos\/\d+\/cache\/$/.test(url.pathname))return res.sendStatus(404);
	return proxyImage(res,{url,maxBytes:3*1024*1024,allow:/^image\/(png|jpeg|webp|gif)(?:;|$)/i,
		cache:'private, max-age=1800',timeoutMs:10000,label:'Channel image'});
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
		const params = new URLSearchParams({ UserId: connection().userId, ParentId: id, SortBy: 'ParentIndexNumber,IndexNumber,SortName', Fields: 'Overview,Genres', IsMissing: 'false', Limit: '1000' });
		data = await metadata(`children:${id}`, () => jelly(`/Items?${params}`));
	}
	res.json(data.Items.filter(x => !x.IsVirtualItem).map(itemView));
});

async function seriesEpisodes(id) {
	const data = await metadata(`episodes:${id}`, () => jelly(`/Shows/${id}/Episodes?UserId=${connection().userId}&IsMissing=false&Fields=Overview,Genres`));
	return orderedEpisodes(data.Items || []);
}
app.get('/api/items/:id/episodes', async (req, res) => {
	res.json({ items: (await seriesEpisodes(itemId(req.params.id))).map(itemView) });
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

app.get('/images/:id/:kind', async (req, res) => {
	const id = itemId(req.params.id);
	const kind = req.params.kind === 'Backdrop' ? 'Backdrop' : 'Primary';
	const width = Math.min(1920, Math.max(100, Number(req.query.width) || 400));
	return proxyImage(res,{url:new URL(`/Items/${id}/Images/${kind}?maxWidth=${width}&quality=85`, upstream),headers:headers(),
		maxBytes:10*1024*1024,cache:'private, no-store',label:'Image',fallbackType:'image/jpeg'});
});

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
	const result=await relayMediaService.replace(existing.relayLeaseId,{quality:req.body.quality??existing.relayQuality,audioIndex:req.body.audioIndex,
		subtitleIndex:req.body.subtitleIndex,position:Number(req.body.position)||0});
	existing.updated=Date.now();existing.relayQuality=req.body.quality??existing.relayQuality;existing.playMethod=result.method||existing.playMethod;
	existing.relaySessionUrl=result.url;existing.position=Number(result.position)||existing.position;
	relayMediaService.clientHeartbeat(existing.relayLeaseId);
	activity.update(existing.id,{method:existing.playMethod,mediaRoute:'relay',routeSource:'lease',workerId:result.workerId,replaced:true});
	return res.json({session:existing.id,url:result.url,kind:'hls',live:['live','nonstop'].includes(existing.relayMode),duration:result.duration||0,
		subtitleIndex:Number.isInteger(result.subtitleIndex)?result.subtitleIndex:(req.body.subtitleIndex??-1),subtitles:result.subtitles||[],audio:result.audio||[],
		method:result.method||existing.playMethod,mediaRoute:'relay',routeSource:'lease',workerId:result.workerId,replaced:true,position:result.position||0});
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
	const session = { downloadSlot: req.downloadSlot, download: req.body.download === true, admin:isAdmin(req), id: sessionId, itemId: id, owner: req.jserverOwner, device, updated: Date.now(), position: 0, playMethod: 'DirectPlay' };
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
	const body = {
		UserId: connection().userId, MediaSourceId: mediaSource.Id, DeviceProfile: deviceProfile(forceTranscode, quality, req.body.client === 'android', req.body.nativeAudio),
		MaxStreamingBitrate: quality, MaxAudioChannels: 2, StartTimeTicks: 0,
		EnableDirectPlay: !forceTranscode && !Number.isInteger(req.body.audioIndex),
		EnableDirectStream: !burnSubtitles, EnableTranscoding: true, AllowVideoStreamCopy: !forceTranscode,
		AllowAudioStreamCopy: true, AutoOpenLiveStream: true, SubtitleStreamIndex: separateCaption ? -1 : subtitleIndex,
		AlwaysBurnInSubtitleWhenTranscoding: burnSubtitles
	};
	if (Number.isInteger(req.body.audioIndex)) body.AudioStreamIndex = req.body.audioIndex;
	const playback = await jelly(`/Items/${id}/PlaybackInfo`, { method: 'POST', body, device });
	if (playback.ErrorCode || !playback.MediaSources?.length) throw new Error(`Jellyfin could not prepare this stream${playback.ErrorCode ? ': ' + playback.ErrorCode : ''}.`);
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
			session.playMethod = 'Transcode';
			session.resource = Buffer.from('index.m3u8').toString('base64url');
			if (!session.captionSources) session.captionSources = encoded.captionSources;
			for (const track of encoded.subtitles) if (session.captionSources?.has(track.index)) track.url = directStreamLink(session, Buffer.from(`subtitle-${track.index}.vtt`).toString('base64url'));
			session.viewer = req.jserverViewer;
			sessions.set(session.id, session);
			activity.begin(session.id, req.jserverViewer, item, { purpose: 'watch' });
			activity.update(session.id, { method: 'Transcode', qualityMbps: quality / 1e6, videoCodec: 'h264', audioCodec: 'aac', conversionReason: 'Original file has no usable seek index' });
			return res.json({ session: session.id, url: directStreamLink(session, session.resource), kind: 'hls', live: false,
				duration: encoded.duration, subtitleIndex: keepSidecars ? subtitleIndex : encoded.subtitleIndex,
				subtitles: keepSidecars ? captionOptions : encoded.subtitles, audio: encoded.audio,
				method: 'Transcode', seekFallback: true });
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
	activity.update(session.id, { method: session.playMethod, qualityMbps: quality / 1e6, sourceMbps: Math.round((source.Bitrate || 0) / 10000) / 100,
		videoCodec: video?.Codec || '', audioCodec: audioTrack?.Codec || '', resolution: video?.Width && video?.Height ? `${video.Width}×${video.Height}` : '',
		conversionReason: session.playMethod === 'DirectPlay' ? 'Original file supported' : burnSubtitles ? 'Subtitles included in the picture' : forceTranscode ? 'Compatible playback requested by this app' : 'Original format or bitrate needs conversion' });
	session.resource = streamLink(session, url).split('/').at(-1);
	session.kind = kind;
	if(kind==='video'&&req.body.client==='android'&&captionOptions){
		const tracks=existingTracks.filter(track=>track.Type==='Subtitle');
		for(const option of captionOptions){const track=tracks.find(track=>track.Index===option.index);if(track&&!track.IsExternal&&textSubtitle(track))Object.assign(option,{embedded:true,ordinal:tracks.indexOf(track),language:track.Language||'',nativeTitle:track.Title||''});}
	}
	res.json({ session: session.id, url: streamLink(session, url), kind, subtitleIndex,
		duration: (source.RunTimeTicks || item.RunTimeTicks || 0) / 1e7, live: item.Type === 'TvChannel',
		audio: (source.MediaStreams || []).filter(x => x.Type === 'Audio').map(x => ({ index: x.Index, label: x.DisplayTitle || x.Language || 'Audio', selected: x.Index === source.DefaultAudioStreamIndex })),
		subtitles: captionOptions || [...(source.MediaStreams || []).filter(x => x.Type === 'Subtitle').map(x => ({ index: x.Index, label: x.DisplayTitle || x.Language || 'Subtitles' })),...(external?[{index:external.index,label:external.label}]:[])],
		method: session.playMethod
	});
}

async function prepareCatchup(req,res,sessionId){
	if(!features.catchup)return res.status(404).json({error:'Catch-up is not enabled on this server.'});
	if(req.body.download)return res.sendStatus(403);
	if(req.jserverShare&&!features.relayMedia)return res.sendStatus(403);
	const item=await catchup.resolve(req.body.id),channel=(await dispatcharr.channels()).find(c=>'dispatch-live-'+c.id===item.ChannelId);
	if(!channel)return res.sendStatus(404);
	if(features.relayMedia){
		if(relayClientUnsupported(req))throw Object.assign(Error('This app version cannot use relay media. Update the app; main media was not used as a fallback.'),{status:409,code:'RELAY_CLIENT_UNSUPPORTED'});
		const relay=await relayMediaService.prepare({session:{id:sessionId},viewer:req.jserverViewer,itemId:item.Id,mode:'catchup',
			params:{channelId:channel.id,item},position:Math.max(0,Number(req.body.position)||0),local:auth.isLocal(req),share:Boolean(req.jserverShare),onRelease:(id,detail)=>{sessionLimits.release(id);}});
		if(!auth.validOwner(req.jserverOwner)||res.destroyed){await relayMediaService.stop(relay.leaseId,{acknowledged:false,reason:'owner_race'});return res.sendStatus(req.jserverShare?410:401);}
		const session={id:sessionId,admin:isAdmin(req),itemId:item.Id,owner:req.jserverOwner,updated:Date.now(),position:0,kind:'hls',playMethod:relay.method||'Relay',
			relayLeaseId:relay.leaseId,relayWorkerId:relay.workerId,mediaRoute:'relay',routeSource:'lease',resource:'',relaySessionUrl:relay.url,relayMode:'catchup',relayParams:{channelId:channel.id,item}};
		if(req.jserverShare){session.shareToken=req.jserverShareToken;session.shareExpires=req.jserverShare.expires;}
		session.viewer=req.jserverViewer;sessions.set(session.id,session);activity.begin(session.id,req.jserverViewer,item,{purpose:'watch'});
		activity.update(session.id,{method:'Relay',mediaRoute:'relay',routeSource:'lease',workerId:relay.workerId});
		return res.json({session:session.id,url:relay.url,kind:'hls',live:false,duration:relay.duration||0,subtitleIndex:Number.isInteger(relay.subtitleIndex)?relay.subtitleIndex:-1,subtitles:relay.subtitles||[],audio:relay.audio||[],method:relay.method||'Relay',mediaRoute:'relay',routeSource:'lease',workerId:relay.workerId,position:relay.position||0});
	}
	const direct=await catchupPlayer.start(channel,item);
	if(!auth.validOwner(req.jserverOwner)||res.destroyed){await direct.stop();return res.sendStatus(401);}
	const session={id:sessionId,admin:isAdmin(req),itemId:item.Id,owner:req.jserverOwner,updated:Date.now(),position:0,kind:'hls',playMethod:direct.method,direct,resource:Buffer.from('index.m3u8').toString('base64url')};
	session.viewer=req.jserverViewer;sessions.set(session.id,session);activity.begin(session.id,req.jserverViewer,item,{purpose:'watch'});
	res.json({session:session.id,url:directStreamLink(session,session.resource),kind:'hls',live:false,duration:direct.duration,subtitleIndex:-1,subtitles:[],audio:direct.audio,method:direct.method});
}

async function prepareDirectChannel(req,res,sessionId) {
	if(req.body.download)return res.sendStatus(403);
	const channel=(await dispatcharr.channels()).find(c=>'dispatch-live-'+c.id===req.body.id);
	if(!channel)return res.status(404).json({error:'This channel is no longer in Dispatcharr.'});
	remoteControls.guard(req.jserverViewer,{nonstop:channel.nonstop});
	const quality=[2000000,4000000,8000000,20000000,80000000].includes(req.body.quality)?req.body.quality:20000000;
	if(features.relayMedia){
		if(relayClientUnsupported(req))throw Object.assign(Error('This app version cannot use relay media. Update the app; main media was not used as a fallback.'),{status:409,code:'RELAY_CLIENT_UNSUPPORTED'});
		const relay=await relayMediaService.prepare({session:{id:sessionId},viewer:req.jserverViewer,itemId:req.body.id,mode:channel.nonstop?'nonstop':'live',
			params:{channelId:channel.id,compatibility:Boolean(req.body.compatibility)},quality,audioIndex:req.body.audioIndex,position:Math.max(0,Number(req.body.position)||0),local:auth.isLocal(req),share:Boolean(req.jserverShare),
			onRelease:(id,detail)=>{sessionLimits.release(id);}});
		if(!auth.validOwner(req.jserverOwner)||res.destroyed){await relayMediaService.stop(relay.leaseId,{acknowledged:false,reason:'owner_race'});return res.sendStatus(req.jserverShare?410:401);}
		const session={nonstop:Boolean(channel.nonstop),id:sessionId,admin:isAdmin(req),itemId:req.body.id,owner:req.jserverOwner,updated:Date.now(),position:0,kind:'hls',playMethod:relay.method||'Relay',
			resource:'',relayLeaseId:relay.leaseId,relayWorkerId:relay.workerId,mediaRoute:'relay',routeSource:'lease',relaySessionUrl:relay.url,
			relayMode:channel.nonstop?'nonstop':'live',relayParams:{channelId:channel.id,compatibility:Boolean(req.body.compatibility)},relayQuality:quality};
		if(req.jserverShare){session.shareToken=req.jserverShareToken;session.shareExpires=req.jserverShare.expires;}
		session.viewer=req.jserverViewer;sessions.set(session.id,session);
		activity.begin(session.id,req.jserverViewer,channelView(channel),{purpose:'watch'});
		activity.update(session.id,{method:relay.method||'Relay',qualityMbps:quality/1e6,mediaRoute:'relay',routeSource:'lease',workerId:relay.workerId});
		return res.json({session:session.id,url:relay.url,kind:'hls',live:true,duration:0,subtitleIndex:-1,subtitles:[],audio:relay.audio||[],method:relay.method||'Relay',mediaRoute:'relay',routeSource:'lease',workerId:relay.workerId,position:relay.position||0});
	}
	const direct=await directPlayer.start(channel,{quality,compatibility:Boolean(req.body.compatibility),audioIndex:req.body.audioIndex});
	if(!auth.validOwner(req.jserverOwner)||res.destroyed){await direct.stop();return res.sendStatus(401);}
	const session={nonstop:Boolean(channel.nonstop),id:sessionId,admin:isAdmin(req),itemId:req.body.id,owner:req.jserverOwner,updated:Date.now(),position:0,kind:'hls',playMethod:direct.method,direct,
		resource:Buffer.from('index.m3u8').toString('base64url')};
	if(req.jserverShare){session.shareToken=req.jserverShareToken;session.shareExpires=req.jserverShare.expires;}
	session.viewer=req.jserverViewer;sessions.set(session.id,session);
	activity.begin(session.id,req.jserverViewer,channelView(channel),{purpose:'watch'});
	activity.update(session.id,{method:direct.method,qualityMbps:quality/1e6,videoCodec:direct.videoCodec,audioCodec:direct.audioCodec,
		conversionReason:direct.method==='Remux'?'Dispatcharr · original video, browser-compatible audio':'Dispatcharr · compatible video conversion'});
	res.json({session:session.id,url:directStreamLink(session,session.resource),kind:'hls',live:true,duration:0,subtitleIndex:-1,subtitles:[],audio:direct.audio,method:direct.method});
}

async function prepareVod(req,res,sessionId) {
	if(req.body.download)return res.sendStatus(403);
	if(req.jserverShare&&!features.relayMedia)return res.sendStatus(403);
	const recorded=String(req.body.id).startsWith('dispatch-recording-');
	const item=recorded?await recordings.item(req.body.id):await vodLibrary.item(req.body.id);
	if(recorded&&!item?.Playable)return res.status(409).json({error:'This recording is not ready to play yet. It will appear as ready when Dispatcharr finishes saving it.'});
	const source=recorded?{type:'recording',id:item.RecordingId,provider:'Dispatcharr recording'}:await vodSource(req.body.id);
	const lookupAvailable=!recorded&&(await subtitleLookup.status()).enabled;
	if(features.relayMedia){
		if(relayClientUnsupported(req))throw Object.assign(Error('This app version cannot use relay media. Update the app; main media was not used as a fallback.'),{status:409,code:'RELAY_CLIENT_UNSUPPORTED'});
		const position=Math.max(0,Number(req.body.position)||0);
		let relay=await relayMediaService.prepare({session:{id:sessionId},viewer:req.jserverViewer,itemId:req.body.id,mode:recorded?'recording':'vod',
			params:recorded?{recordingId:item.RecordingId}:{type:source.type,uuid:source.uuid,account:source.account,streamId:source.streamId,provider:source.provider,
				textSubtitles:req.body.textSubtitles===true,preferEnglishSubtitles:req.body.preferEnglishSubtitles===true,compatibility:Boolean(req.body.compatibility)},
			quality:req.body.quality,audioIndex:req.body.audioIndex,subtitleIndex:req.body.subtitleIndex,position,local:auth.isLocal(req),share:Boolean(req.jserverShare),
			onRelease:(id,detail)=>{sessionLimits.release(id);}});
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
			relaySessionUrl:relay.url,relayMode:recorded?'recording':'vod',relayParams:recorded?{recordingId:item.RecordingId}:{type:source.type,uuid:source.uuid,account:source.account,streamId:source.streamId,provider:source.provider},relayQuality:req.body.quality};
		if(req.jserverShare){session.shareToken=req.jserverShareToken;session.shareExpires=req.jserverShare.expires;}
		session.viewer=req.jserverViewer;sessions.set(session.id,session);activity.begin(session.id,req.jserverViewer,item,{purpose:'watch'});
		activity.update(session.id,{method:relay.method||'Relay',mediaRoute:'relay',routeSource:'lease',workerId:relay.workerId});
		return res.json({session:session.id,url:relay.url,kind:'hls',live:false,duration:relay.duration||(item.RunTimeTicks||0)/1e7,
			subtitleIndex:Number.isInteger(relay.subtitleIndex)?relay.subtitleIndex:-1,subtitles:relay.subtitles||[],audio:relay.audio||[],method:relay.method||'Relay',
			provider:source.provider,mediaRoute:'relay',routeSource:'lease',workerId:relay.workerId,position});
	}
	const direct=await vodPlayer.start(source,{textSubtitles:req.body.textSubtitles===true,quality:req.body.quality,audioIndex:req.body.audioIndex,subtitleIndex:req.body.subtitleIndex,preferEnglishSubtitles:req.body.preferEnglishSubtitles,
		...(lookupAvailable?{lookupSubtitles:duration=>lookupEnglish(item,{fingerprint:source.uuid,duration})}:{})});
	if(!auth.validOwner(req.jserverOwner)||res.destroyed){await direct.stop();return res.sendStatus(401);}
	const session={id:sessionId,admin:isAdmin(req),itemId:item.Id,owner:req.jserverOwner,updated:Date.now(),position:0,kind:'hls',playMethod:'Transcode',direct,vod:true,resource:Buffer.from('index.m3u8').toString('base64url')};
	session.captionSources=direct.captionSources;
	for(const track of direct.subtitles)if(session.captionSources?.has(track.index))track.url=directStreamLink(session,Buffer.from(`subtitle-${track.index}.vtt`).toString('base64url'));
	session.viewer=req.jserverViewer;sessions.set(session.id,session);activity.begin(session.id,req.jserverViewer,item,{purpose:'watch'});
	activity.update(session.id,{method:'Transcode',videoCodec:'h264',audioCodec:'aac',conversionReason:source.provider+' · streamed title prepared for your browser'});
	res.json({session:session.id,url:`/stream/${session.id}/${session.resource}`,kind:'hls',live:false,duration:direct.duration,subtitleIndex:direct.subtitleIndex,subtitles:direct.subtitles,audio:direct.audio,method:'Transcode',provider:source.provider});
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
	session.viewer={...session.viewer,local:connection.local,home:connection.home};
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
			activity.update(session.id, { state: 'playing', local: auth.isLocal(req), mediaRoute: auth.isLocal(req) ? 'local' : 'remote', mediaIp: identity.ip });
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
async function proxyDirectStream(req,res,session,ticket) {
	const file=mediaFile(Buffer.from(req.params.resource,'base64url').toString());
	session.playStarted=true;session.updated=Date.now();
	const body=await session.direct.read(file).catch(error=>{if(error.code==='ENOENT')throw Object.assign(Error('This TV segment has expired.'),{status:410});throw error;});
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
	activity.update(session.id,{state:'playing',local:auth.isLocal(req),mediaRoute:auth.isLocal(req)?'local':'remote',mediaIp:identity.ip});
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
	if(session.direct){await session.direct.stop();return;}
	await Promise.allSettled([
		report(session, 'stop'),
		jelly(`/Videos/ActiveEncodings?DeviceId=${session.device}&PlaySessionId=${session.playSessionId}`, { method: 'DELETE', device: session.device }),
		...(session.liveStreamId ? [jelly('/LiveStreams/Close?' + new URLSearchParams({ liveStreamId: session.liveStreamId }), { method: 'POST', device: session.device })] : [])
	]);
	})().then(() => { accountLimits.end(session.id);sessionLimits.release(session.id);sessions.delete(session.id); if (session.downloadSlot) downloadLimit.release(session.downloadSlot.key, session.downloadSlot.id); }).catch(error => { sessionLimits.release(session.id); session.stopping = null; throw error; });
	return session.stopping;
}

app.post('/api/sessions/:id', updateSession);
async function updateSession(req, res) {
	const session = sessions.get(req.params.id);
	if (!session) return res.sendStatus(204);
	if (session.owner !== req.jserverOwner) return res.sendStatus(403);
	if (session.stopping) { await session.stopping; return res.sendStatus(204); }
	if(req.body.action!=='stop'){remoteControls.guard(session.viewer,session);accountLimits.guard(session.viewer,Boolean(session.download));}
	session.updated = Date.now();
	if (Number.isFinite(req.body.position)) session.position = Math.max(0, req.body.position);
	// Stop always wins. It must not touch the screen reservation (which may have
	// expired or moved while the session was open). stop() aborts controllers and
	// releases the screen at once, then completes upstream cleanup.
	if (req.body.action === 'stop') {
		await stop(session);
		return res.sendStatus(204);
	}
	session.direct?.touch?.(Boolean(req.body.paused));
	if(session.relayLeaseId){
		relayMediaService.clientHeartbeat(session.relayLeaseId);
		// Relay media never passes through sendMedia, so start the existing
		// wall-clock account/viewing interval from authenticated client progress.
		accountLimits.media(session.id,req.jserverViewer||session.viewer);
		if(!session.download)sessionLimits.media(session.id,req.jserverViewer||session.viewer,{admin:session.admin||isAdmin(req)});
	}
	if(!session.download)sessionLimits.touch(session.id,req.jserverViewer||session.viewer,{admin:session.admin||isAdmin(req),heartbeat:true});
	accountLimits.heartbeat(session.id,!req.body.paused&&!req.body.buffering);
	const fallback = ['disabled', 'away', 'unreachable', 'playback-failed'].includes(req.body.localFallback) ? req.body.localFallback : undefined;
	activity.update(session.id, { position: session.position, heartbeat: true, rate: req.body.rate, state: req.body.buffering ? 'buffering' : req.body.paused ? 'paused' : 'playing', ...(fallback ? { localFallback: fallback } : {}) });
	if (['start', 'progress'].includes(req.body.action)) await report(session, req.body.action, req.body);
	res.sendStatus(204);
}

setInterval(()=>{accountLimits.tick();relayMediaService.tick();for(const session of sessions.values())if(!remoteControls.allowed(session.viewer,session)||!accountLimits.allowed(session.viewer,Boolean(session.download)))void stop(session,{relayRevoke:Boolean(session.relayLeaseId)}).catch(()=>{});},1000).unref();

setInterval(() => {
	for (const session of sessions.values()) {
		if (session.shareExpires && session.shareExpires <= Date.now()) void stop(session);
		else if (session.castExpires && session.castExpires <= Date.now()) void stop(session);
		else if (!session.controllers?.size && Date.now() - session.updated > (session.download ? 8 * 60 : 5) * 60 * 1000) void stop(session);
	}
}, 60000).unref();

// Prepare/warm-up TTLs and idle sessions must release remote screens even if a
// client never sends another heartbeat or media request.
setInterval(()=>sessionLimits.tick(),15000).unref();

app.get('/vendor/hls.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/hls.js/dist/hls.min.js')));
app.use(express.static(path.join(root, 'public')));
app.use((error, req, res, next) => {
	if (res.headersSent) return next(error);
	console.error('Request failed:', req.method, /^\/(cast-stream|share)\//.test(req.path) ? '/capability/[redacted]' : req.path.split('/').slice(0, 3).join('/'), error.name);
	if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
	res.status(error.status || 500).json({ error: error.message || 'Something went wrong. Please try again.', ...(error.code ? { code:error.code } : {}), ...(error.retryAfter ? { retryAfter:error.retryAfter } : {}) });
});

if (process.env.NODE_ENV !== 'test') {
	void homeNetwork.refresh();
	setInterval(() => { void homeNetwork.refresh(); }, 60000).unref();
	// Run independently of browsing; previously saved series are usable during startup and refresh.
	const indexStart=setTimeout(()=>{void vodLibrary.refreshSeriesIndex();},1500);indexStart.unref();
	setInterval(()=>{void vodLibrary.refreshSeriesIndex({force:true});},3600000).unref();
	app.listen(Number(process.env.PORT || 8082), '0.0.0.0', () => console.log(`jServer local entry on port ${process.env.PORT || 8082}`));
	app.listen(Number(process.env.REMOTE_PORT || 8083), '0.0.0.0', () => console.log(`jServer password-protected entry on port ${process.env.REMOTE_PORT || 8083}`));
}
export { app };
