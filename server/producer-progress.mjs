const DEFAULT_DIAGNOSTIC_BYTES = 8192;

export function sanitizeDiagnosticLine(value, limit = 500) {
	let text = String(value || '').replace(/https?:\/\/\S+/gi, '[url]').replace(/\b(token|key|sig|signature|auth)=([^\s&]+)/gi, '$1=[redacted]');
	if (text.length > limit) text = text.slice(0, limit) + '...';
	return text.trim();
}

export function createDiagnosticsBuffer({ limit = DEFAULT_DIAGNOSTIC_BYTES } = {}) {
	let text = '';
	const lines = [];
	return {
		push(value) {
			const line = sanitizeDiagnosticLine(value);
			if (!line) return;
			lines.push(line);
			if (lines.length > 80) lines.shift();
			text = lines.join('\n');
			if (text.length > limit) text = text.slice(-limit);
		},
		text() { return text; },
		lines() { return [...lines]; },
		clear() { text = ''; lines.length = 0; }
	};
}

/**
 * Track playlist sequence progress separately from client reads. A stalled
 * producer must not be kept alive by repeated requests for the same playlist.
 */
export function createProducerProgress({ timeoutMs = 60000, now = Date.now, onStall = () => {} } = {}) {
	let sequence = null;
	let lastSegment = null;
	let progressAt = now();
	let exited = false;
	let stopped = false;
	let reason = '';
	let fired = false;
	let exitCode = 0;
	function fire(value) {
		if (fired || stopped) return value;
		fired = true;
		reason = value;
		try { onStall(value); } catch {}
		return value;
	}
	return {
		observe(text) {
			if (stopped) return;
			const value = String(text || '');
			const match = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(value);
			const segments = [...value.matchAll(/segment(\d+)\.ts/g)].map(entry => Number(entry[1]));
			const newest = segments.length ? Math.max(...segments) : null;
			const sequenceChanged = match ? (sequence === null || Number(match[1]) !== sequence) : false;
			const segmentChanged = newest !== null && (lastSegment === null || newest > lastSegment);
			if (match) sequence = Number(match[1]);
			if (newest !== null) lastSegment = newest;
			if (sequenceChanged || segmentChanged) progressAt = now();
		},
		exit(code = 0) {
			exited = true;
			exitCode = Number(code) || 0;
			return fire('exited');
		},
		tick() {
			if (stopped) return '';
			if (exited) return fire('exited');
			if (now() - progressAt > timeoutMs) return fire('stalled');
			return '';
		},
		stop() { stopped = true; },
		get sequence() { return sequence; },
		get lastSegment() { return lastSegment; },
		get reason() { return reason; },
		get exited() { return exited; },
		get exitCode() { return exitCode; }
	};
}
