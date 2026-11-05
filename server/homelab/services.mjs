// One catalogue drives the setup cards and the technical guide.
const field = (key, label, type = 'text', required = false, hint = '') => ({ key, label, type, required, hint });
export const services = [
	{
		id: 'jellyfin', name: 'Jellyfin', group: 'Your media', icon: 'library',
		sameServerUrl: 'http://host.docker.internal:8096',
		summary: 'Watch the films and series stored on your own disks.',
		description: 'Jellyfin organises your local files, supplies artwork and episode details, and prepares compatible video streams. Tellybox provides the browsing and playback interface.',
		enables: ['Local films and series', 'Local episode libraries', 'Jellyfin playback and media segments'],
		requires: 'An existing Jellyfin server, an API key and the ID of a dedicated viewer account with access to the libraries you want to share.',
		without: 'You can still use Dispatcharr for live TV and streamed films or series.',
		note: 'Use a dedicated viewer account. Tellybox viewers share its permitted libraries; do not use an administrator account for playback.',
		docs: 'https://jellyfin.org/docs/',
		fields: [field('url', 'Server address', 'url', true, 'For example http://jellyfin:8096 — reachable from the Tellybox container'), field('key', 'API key', 'secret', true), field('userId', 'Viewer user ID', 'text', true)]
	},
	{
		id: 'dispatcharr', name: 'Dispatcharr', group: 'Your media', icon: 'tv',
		locations: ['onThisServer', 'relay', 'anotherServer'],
		sameServerUrl: 'http://host.docker.internal:9191',
		summary: 'Bring live TV, a programme guide and your streamed catalogue together.',
		description: 'Dispatcharr manages your IPTV sources. Tellybox connects directly for live channels, a separate 24/7 area, on-demand films and series, and supported recording and catch-up features.',
		enables: ['Live TV and programme guide', '24/7 channels', 'Streamed films and series', 'Recordings and catch-up where available'],
		requires: 'A running Dispatcharr server with channels, guide data and any VOD accounts already configured. Use a personal API key for the catalogue and recording controls.',
		without: 'Your Jellyfin collection continues to work normally.',
		note: 'Tellybox does not supply channels. Catch-up needs provider archive support. Recording controls need DVR management permission in Dispatcharr. 24/7 grouping comes from your channel groups and names.',
		docs: 'https://dispatcharr.github.io/Dispatcharr-Docs/',
		fields: [field('url', 'Server address', 'url', false, 'Required for Another server. On this server and On relay are discovered automatically.'), field('key', 'Personal API key', 'secret'), field('live', 'Live TV and 24/7', 'boolean'), field('vod', 'On-demand catalogue', 'boolean'), field('recordings', 'Recordings', 'boolean'), field('catchup', 'Catch-up', 'boolean'),
			field('relayMetadataUrl', 'Relay metadata address', 'url', false, 'Advanced only: discovered from the checked relay. Used by main for catalogue, guide and control.'),
			field('relayUrl', 'Worker Dispatcharr address', 'url', false, 'Advanced only: loopback address the worker uses for media.'),
			field('relayKey', 'Worker Dispatcharr API key', 'secret', false, 'Worker-only key. Never sent to viewers or returned by status.')]
	},
	{
		id: 'seerr', name: 'Seerr', group: 'Discovery & requests', icon: 'search',
		sameServerUrl: 'http://host.docker.internal:5055',
		summary: 'Discover something new and request it for your local collection.',
		description: 'Seerr provides the discovery catalogue and handles requests through its own Sonarr and Radarr connections. It also supplies metadata used to enrich streamed titles.',
		enables: ['Discover and provider browsing', 'Requests for local copies', 'Extra catalogue artwork and metadata'],
		requires: 'A configured Seerr server and its API key. Set its library, request destinations, quality profiles and download settings in Seerr first.',
		without: 'You can browse and play connected libraries; catalogue discovery and requests stay hidden.',
		note: 'Seerr is not a video provider or download client. Sonarr/Radarr and a download client do the acquisition separately. TMDB metadata is accessed through Seerr in this edition.',
		docs: 'https://docs.seerr.dev/',
		fields: [field('url', 'Server address', 'url', true), field('key', 'API key', 'secret', true),
			field('specials','Allow requests for specials','boolean'),
			...['radarr','sonarr'].flatMap(id=>[field(id+'ServerId',id==='radarr'?'Film request server ID':'Series request server ID','number'),field(id+'ProfileId','Quality profile ID','number'),field(id+'RootFolder','Destination folder','text',false,'Use the destination configured in Seerr. Leave all three empty for discovery without requests.')])]
	},
	{
		id: 'sonarr', name: 'Sonarr', group: 'Discovery & requests', icon: 'calendar',
		sameServerUrl: 'http://host.docker.internal:8989',
		summary: 'Show when monitored series have new episodes coming up.',
		description: 'This connection reads your existing Sonarr calendar and episode dates for Coming soon and recent releases. Seerr remains responsible for adding requested series to Sonarr.',
		enables: ['Upcoming episode calendar', 'Episode air-date enrichment'],
		requires: 'Your Sonarr address and API key from Settings → General. Series must already be monitored there.',
		without: 'Series still play; the Sonarr calendar is unavailable.',
		note: 'Connecting here does not install a download client or change your root folders and quality profiles.',
		docs: 'https://wiki.servarr.com/sonarr',
		fields: [field('url', 'Server address', 'url', true), field('key', 'API key', 'secret', true)]
	},
	{
		id: 'radarr', name: 'Radarr', group: 'Discovery & requests', icon: 'film',
		sameServerUrl: 'http://host.docker.internal:7878',
		summary: 'Add upcoming films and the ratings already in your Radarr library.',
		description: 'Tellybox reads monitored films, release dates and available ratings. Seerr handles requests for new local films through its own Radarr configuration.',
		enables: ['Upcoming films', 'Additional film ratings when supplied'],
		requires: 'Your Radarr address and API key from Settings → General.',
		without: 'Films still play using metadata from Jellyfin or Dispatcharr.',
		note: 'Tellybox does not manufacture missing IMDb or Rotten Tomatoes scores.',
		docs: 'https://wiki.servarr.com/radarr',
		fields: [field('url', 'Server address', 'url', true), field('key', 'API key', 'secret', true)]
	},
	{
		id: 'opensubtitles', name: 'OpenSubtitles', group: 'Playback extras', icon: 'captions',
		summary: 'Look for English subtitles when a film or episode has none.',
		description: 'Tellybox searches OpenSubtitles.com for matching English captions and caches downloaded subtitle files. Embedded and existing subtitles are preferred.',
		enables: ['English subtitle lookup for films and episodes'],
		requires: 'An OpenSubtitles.com API consumer key. Account sign-in is optional and uses that account’s allowance.',
		without: 'Existing subtitles still work. No external subtitle search takes place.',
		note: 'Does not apply to live TV or 24/7. Availability, timing and download allowances depend on OpenSubtitles and the release being watched.',
		docs: 'https://opensubtitles.stoplight.io/docs/opensubtitles-api',
		fields: [field('key', 'API consumer key', 'secret', true), field('username', 'Account username'), field('password', 'Account password', 'secret')]
	},
	{
		id: 'introdb', name: 'IntroDB', group: 'Playback extras', icon: 'skip',
		summary: 'Offer Skip intro on recognised episodes.',
		description: 'Tellybox first checks Jellyfin’s media segments for local episodes. When enabled, IntroDB can provide community timings for recognised episodes in either local or streamed collections.',
		enables: ['Additional intro, recap and outro timings'],
		requires: 'Internet access and matching series identifiers. No API key is entered here.',
		without: 'Jellyfin’s own media segments can still provide Skip intro.',
		note: 'Coverage is not universal. Timings can differ between releases. Tellybox only shows a skip control when usable timings are available.',
		docs: 'https://introdb.app/', fields: []
	},
	{
		id: 'resend', name: 'Resend', group: 'Remote access', icon: 'mail',
		summary: 'Send email sign-in codes to approved remote viewers.',
		description: 'Resend delivers approval messages and short-lived login codes. Local web viewing remains login-free; remote approval is managed in Tellybox.',
		enables: ['Remote email sign-in', 'Approval emails'],
		requires: 'A Resend API key, a verified sender domain and a sender address on that domain. Configure a public HTTPS address first.',
		without: 'Local viewing and approved app access remain available. Email login is unavailable.',
		note: 'The test sender is unsuitable for friends and family. Check your account’s current sending allowance; this setup does not purchase a plan.',
		docs: 'https://resend.com/docs/introduction',
		fields: [field('key', 'API key', 'secret', true), field('from', 'Sender email address', 'email', true)]
	},
	{
		id: 'pushGateway', name: 'Tellybox notifications', group: 'Remote access', icon: 'bell',
		summary: 'Send activity alerts to your HomeLab administrators without setting up Firebase.',
		description: 'The shared Tellybox service wakes opted-in HomeLab apps. Each app then signs in to your own server to retrieve the notification details.',
		enables: ['HomeLab administrator push notifications'],
		requires: 'Internet access and an approved administrator using the official HomeLab Android app. No API keys are needed.',
		without: 'Periodic background alerts remain available. Existing personal Firebase notifications are unchanged.',
		note: 'The shared service receives opaque registration handles and event IDs, never names, email addresses or viewing titles. Enable admin alerts in the phone app after applying this setting.',
		docs: 'https://homelab.tellyboxapp.com/', fields: []
	},
	{
		id: 'firebase', name: 'Firebase Cloud Messaging', group: 'Remote access', icon: 'bell',
		summary: 'Send prompt activity notifications to opted-in Android administrators.',
		description: 'Firebase wakes the administrator’s app. The app authenticates with your server before retrieving the activity details. Periodic background alerts remain the fallback.',
		enables: ['Android administrator push notifications'],
		requires: 'Your own Firebase project, client settings matching each Android app you use, and a service-account JSON file with messaging permission.',
		without: 'Periodic background alerts remain available; Android can delay them.',
		note: 'Use your own project and signing certificate. The service-account private key stays in the server’s configuration volume and is never sent to an app.',
		docs: 'https://firebase.google.com/docs/cloud-messaging',
		fields: [field('projectId', 'Project ID', 'text', true), field('applicationId', 'Your custom Android Firebase app ID'), field('publicApplicationId', 'Your HomeLab Android Firebase app ID', 'text', false, 'Use your Firebase app registered for app.tellybox.homelab. Configure at least one edition.'), field('senderId', 'Messaging sender ID', 'text', true), field('apiKey', 'Client API key', 'secret', true), { ...field('serviceAccount', 'Service account JSON', 'secret', true), jsonFile: true }]
	}
];

export const infrastructure = [
	{ name: 'Tailscale', summary: 'A private connection between your home server and an optional public relay.', requires: 'Your own Tailscale account and approval of both machines.', note: 'No exit node or subnet router is needed. Tailscale does not make a public website by itself.', docs: 'https://tailscale.com/docs/install/linux' },
	{ name: 'Caddy', summary: 'The relay’s HTTPS front door, forwarding requests to Tellybox over the private connection.', requires: 'A hostname pointed at the relay and web ports allowed by its firewall.', note: 'Management stays separate from the public viewing route. Existing Caddy sites must be preserved.', docs: 'https://caddyserver.com/docs/automatic-https' },
];

export const presets = [
	{ id: 'local', name: 'My own collection', services: ['jellyfin'], summary: 'Start with films and series on your disks.' },
	{ id: 'iptv', name: 'Live TV & streamed titles', services: ['dispatcharr'], summary: 'Use Dispatcharr without a Jellyfin server.' },
	{ id: 'mixed', name: 'A bit of both', services: ['jellyfin', 'dispatcharr'], summary: 'Browse local and streamed titles together.' },
	{ id: 'custom', name: 'Choose for myself', services: [], summary: 'Enable only the services you want, now or later.' }
];
