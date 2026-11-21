/* Release 134: the owner-only Activity downloads page shell.
 * It is served from the owner-gated route in qbittorrent.mjs so the public
 * static directory never exposes even an empty copy of this surface. */
export const DOWNLOADS_PAGE = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<title>Activity downloads - Tellybox</title>
	<link rel="icon" href="/icon.svg" type="image/svg+xml">
	<link rel="stylesheet" href="/style.css">
	<link rel="stylesheet" href="/qbittorrent.css">
	<script src="/navigation.js" defer></script>
	<script src="/qbittorrent-downloads.js" defer></script>
</head>
<body class="activity-page qb-downloads-page">
	<header class="topbar">
		<a class="brand" href="/" aria-label="Tellybox home"><img class="brand-logo" src="/tellybox-logo.png" alt="Tellybox"></a>
		<button class="menu-toggle" id="menuToggle" aria-controls="siteNavigation" aria-expanded="false"><span class="menu-icon" aria-hidden="true">☰</span><span>Menu</span></button>
		<div id="siteNavigation" class="navigation-panel">
			<nav aria-label="Primary"><a class="nav-item" href="/">Home</a><a class="nav-item" href="/discover">Discover</a><a class="nav-item nav-coming" href="/coming-soon">Coming soon</a><a class="nav-item" href="/?view=movies">Films</a><a class="nav-item" href="/?view=tvshows">Series</a><a class="nav-item" href="/?view=livetv">Live TV</a><a class="nav-item" href="/?view=nonstop">24/7</a><a class="nav-item" href="/?view=recordings">Recordings</a><a class="nav-item" href="/search">Search</a><a class="nav-item" href="/activity">Activity</a></nav>
			<div class="account-actions"><a href="/settings" id="remoteSettings">Settings</a></div>
		</div>
	</header>
	<main class="auth-card activity-card qb-downloads-card">
		<p class="eyebrow">OWNER ONLY · MONITORING AND CONFIRMED REMOVAL</p>
		<h1>Activity downloads</h1>
		<p class="auth-description">The server's qBittorrent queue, separate from offline downloads in the apps. Only the installation owner can see this page. Nothing is added, paused or changed unless you review and confirm one specific torrent below.</p>

		<div class="qb-toolbar" role="group" aria-label="Download filters">
			<label>State<select id="qbFilter">
				<option value="all">Everything</option>
				<option value="downloading" selected>Downloading</option>
				<option value="completed">Completed</option>
				<option value="seeding">Seeding</option>
				<option value="paused">Paused</option>
				<option value="stalled">Stalled</option>
				<option value="errored">Error</option>
			</select></label>
			<label>Category<select id="qbCategory"><option value="">All categories</option></select></label>
			<button class="button secondary" id="qbRefresh" type="button">Refresh now</button>
			<span class="activity-pill" id="qbCount" hidden></span>
		</div>

		<div id="qbStatus" class="qb-status" role="status" aria-live="polite" aria-atomic="true" aria-busy="false">Checking qBittorrent...</div>
		<p class="auth-note" id="qbGlobal"></p>
		<div id="qbRows" class="qb-list"></div>
		<p class="auth-note" id="qbEmpty" hidden></p>

		<nav class="activity-paging qb-paging" aria-label="Download pages">
			<button class="button secondary" id="qbPrevious" type="button">Newer</button>
			<button class="button secondary" id="qbNext" type="button">Older</button>
		</nav>

		<p class="auth-note">Completed in qBittorrent does not mean imported or playable in Tellybox. A missing or stalled download is not proof of a broken release. "Needs attention" only means this integration measured no progress for the configured window while the torrent was downloading.</p>
		<p class="auth-note">Polling stops when this tab is hidden or signed out. Monitoring is off when the integration is disabled, and no qBittorrent request is made then.</p>
		<a href="/activity">Back to Activity →</a>
	</main>

	<dialog id="qbReview" class="qb-dialog" aria-labelledby="qbReviewTitle">
		<form method="dialog" class="qb-dialog-body">
			<h2 id="qbReviewTitle">Review this torrent</h2>
			<div id="qbReviewSummary" class="qb-review-summary"></div>
			<div id="qbReviewWarning" class="qb-review-warning" role="alert"></div>

			<label class="qb-ack" id="qbAckRow" hidden>
				<input type="checkbox" id="qbDeleteAck">
				<span>I understand the downloaded files cannot be recovered, and may be shared or hardlinked with library files used elsewhere.</span>
			</label>

			<p id="qbReviewMessage" class="auth-note" role="status"></p>
			<p id="qbReviewExpiry" class="auth-note"></p>
			<div class="settings-actions qb-dialog-actions">
				<button class="button quiet" id="qbCancel" type="button">Cancel</button>
				<button class="button secondary" id="qbRemove" type="button">Remove torrent, keep files</button>
				<button class="button danger" id="qbDeleteFiles" type="button" hidden>Delete torrent and downloaded files</button>
			</div>
		</form>
	</dialog>
</body>
</html>
`;
