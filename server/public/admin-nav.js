/* Activity is an administrator surface. Hide the entry before first paint, then
 * reveal it only when the server says this session is an installation owner or
 * an approved admin app. The server refuses /activity regardless; this only
 * stops a dead link being offered to a viewer. */
(() => {
	'use strict';
	const style = document.createElement('style');
	style.setAttribute('data-admin-nav', '');
	style.textContent = 'a[href="/activity"]{display:none!important}';
	(document.head || document.documentElement).append(style);
	const reveal = () => style.remove();
	fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' })
		.then(response => response.ok ? response.json() : null)
		.then(status => { if (status?.admin === true) reveal(); })
		.catch(() => { /* Leave hidden: the page itself is gated. */ });
})();
