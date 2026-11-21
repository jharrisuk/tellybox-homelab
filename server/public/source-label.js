/* Shared source-label copy for Home, Search, Discover and detail surfaces.
 * A known upstream provider is shown after the middle dot. Dispatcharr is the
 * exact fallback requested for an unknown catalogue provider, matching the
 * transport that actually serves the stream. */
(function (root) {
	'use strict';

	function providerName(item) {
		var value = typeof item?.Provider === 'string' ? item.Provider.trim() : '';
		var discovery = typeof item?.vodProvider === 'string' ? item.vodProvider.trim() : '';
		// Discovery can carry the real provider while the catalogue field is the
		// transport fallback. Prefer the known provider, never invent one.
		if (discovery && (!value || value.toLowerCase() === 'dispatcharr')) value = discovery;
		return (value || 'Dispatcharr').slice(0, 100);
	}

	function streamed(item) {
		return 'Streamed \u00b7 ' + providerName(item);
	}

	function streamNow(item) {
		return 'Stream now \u00b7 ' + providerName(item);
	}

	function available(item) {
		return 'Available through ' + providerName(item) + '.';
	}

	var api = { providerName: providerName, streamed: streamed, streamNow: streamNow, available: available };
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (root) root.TellyboxSourceLabel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
