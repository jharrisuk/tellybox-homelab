/* Playback tuning policy for the web player.
 *
 * Provider playback (Dispatcharr live/24-7, catch-up, provider recordings and
 * streamed VOD) and all live TV use the server's normal playback defaults.
 * Only a local Jellyfin library film/episode/recording keeps the Quality,
 * Audio, Subtitles and compatibility controls plus the browser preferences.
 *
 * The predicate is positive: a local item is the absence of every provider
 * marker. A local Jellyfin item has Source "local" (or no Source), a Jellyfin
 * GUID rather than a dispatch-/catchup- id, no Provider label and a library
 * Type. It therefore cannot match, except for live TV, which is intentionally
 * hidden by Type TvChannel.
 */
(function (root) {
	'use strict';

	// The first option in the player's Quality select ("Auto · up to 20 Mbps").
	// It is the normal visible default, not a provider-specific rung.
	var PROVIDER_DEFAULT_QUALITY = 20000000;
	var PROVIDER_ID = /^(?:dispatch-(?:live|movie|series|episode|recording)-|catchup-)/i;

	function text(value) {
		return typeof value === 'string' ? value.trim() : '';
	}

	function isProviderPlayback(item, live) {
		// A play response that reports a live transport is authoritative even if
		// the catalogue item carried no provider marker.
		if (live === true) return true;
		if (!item || typeof item !== 'object') return false;
		var source = text(item.Source).toLowerCase();
		var provider = text(item.Provider).toLowerCase();
		var type = text(item.Type);
		var id = text(item.Id);
		if (source === 'streamed') return true;
		if (provider === 'dispatcharr') return true;
		if (type === 'TvChannel' || type === 'Catchup') return true;
		return PROVIDER_ID.test(id);
	}

	function applyVisibility(nodes, hide) {
		var list = Array.isArray(nodes) ? nodes : [];
		for (var i = 0; i < list.length; i++) {
			if (list[i] && typeof list[i] === 'object' && 'hidden' in list[i]) list[i].hidden = hide === true;
		}
	}

	root.TellyboxPlaybackTuning = {
		isProviderPlayback: isProviderPlayback,
		applyVisibility: applyVisibility,
		PROVIDER_DEFAULT_QUALITY: PROVIDER_DEFAULT_QUALITY
	};
})(typeof globalThis !== 'undefined' ? globalThis : this);
