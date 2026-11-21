/*
 * Small, testable playback-policy helpers.
 *
 * The browser's autoplay decision is not a media failure. A genuine
 * NotAllowedError needs one explicit tap; an AbortError is usually our own
 * source swap or ready race and can be retried once the new source is ready.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === 'object' && module.exports) module.exports = api;
	else root.TellyboxAutoplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	function classify(error) {
		const name = error && typeof error.name === 'string' ? error.name : '';
		if (name === 'NotAllowedError') return 'blocked';
		if (name === 'AbortError') return 'race';
		if (name === 'NotSupportedError' || name === 'NotReadableError') return 'unsupported';
		return 'unknown';
	}

	function status(kind, live) {
		if (kind === 'blocked') return live
			? 'Your browser needs one tap to start live playback. Press Play live.'
			: 'Your browser needs one tap to start playback. Press play.';
		if (kind === 'unsupported') return 'This browser could not start the stream. Try compatibility mode below.';
		if (kind === 'race') return 'Preparing playback…';
		return 'Ready. Press play to start.';
	}

	function shouldRetry(kind) {
		return kind === 'race';
	}

	function loadingVisible(state) {
		if (state.blocked) return false;
		if (state.starting) return true;
		return !state.paused;
	}

	function playVisible(state) {
		return Boolean(state.live && state.paused && state.hasSource);
	}

	function localProbeTimeout() { return 4000; }
	function localFailureCacheMs() { return 300000; }
	function localProbeDue(routing, now = Date.now()) {
		if (routing.direct || !routing.home || !routing.origin || !routing.preferLocal) return false;
		if (!routing.checked) return true;
		if (routing.enabled) return false;
		return now - (routing.checkedAt || 0) >= localFailureCacheMs();
	}

	return { classify, status, shouldRetry, loadingVisible, playVisible, localProbeTimeout, localFailureCacheMs, localProbeDue };
});
