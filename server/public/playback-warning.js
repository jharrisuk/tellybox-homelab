/* Shared buffering warning policy for the web player.
 * Genuine buffering only: startup grace, continuous 60 seconds, or 25 seconds
 * cumulative in a rolling 60-second window. Uses monotonic elapsed time, not
 * buffering event counts. */
(function (root) {
	'use strict';
	var DEFAULTS = Object.freeze({
		startupGraceMs: 15000,
		continuousMs: 60000,
		cumulativeMs: 25000,
		windowMs: 60000,
		recoveryMs: 10000,
		dismissMs: 120000
	});
	var QUALITY_RUNGS = Object.freeze([80000000, 20000000, 8000000, 4000000, 2000000]);

	// Auto (0 or lower) resolves against the negotiated playback ceiling so the
	// trouble panel can still step down. An explicit choice is the ceiling, and
	// a missing negotiated value falls back to 8 Mbps (never 80 Mbps: some VOD
	// paths default to 8 Mbps). Nothing at or above the ceiling is ever returned.
	function nextLowerQuality(current, rungs, negotiated) {
		var c = Number(current);
		var n = Number(negotiated);
		var list = Array.isArray(rungs) ? rungs : QUALITY_RUNGS;
		var effective = c > 0 ? c : (n > 0 ? n : 8000000);
		for (var i = 0; i < list.length; i++) {
			var rung = Number(list[i]);
			if (Number.isFinite(rung) && rung > 0 && rung < effective) return rung;
		}
		return 0;
	}

	function Monitor(options) {
		this.options = Object.assign({}, DEFAULTS, options || {});
		this.reset(0, '');
	}

	Monitor.prototype.reset = function (now, streamKey) {
		this.streamKey = String(streamKey || '');
		this.startedAt = Number(now) || 0;
		this.graceUntil = this.startedAt + this.options.startupGraceMs;
		this.segmentStart = null;
		this.continuousStart = null;
		this.segments = [];
		this.shown = false;
		this.dismissedUntil = 0;
		this.recoveredSince = null;
		this.lastReason = '';
		this.lastAt = this.startedAt;
	};

	Monitor.prototype._prune = function (now) {
		var floor = now - this.options.windowMs;
		this.segments = (this.segments || []).filter(function (segment) { return segment.end > floor; });
	};

	Monitor.prototype._cumulative = function (now) {
		var floor = now - this.options.windowMs;
		var total = 0;
		for (var i = 0; i < this.segments.length; i++) {
			var segment = this.segments[i];
			total += Math.max(0, Math.min(segment.end, now) - Math.max(segment.start, floor));
		}
		if (this.segmentStart !== null) total += Math.max(0, now - Math.max(this.segmentStart, floor));
		return total;
	};

	Monitor.prototype._closeSegment = function (now) {
		if (this.segmentStart !== null) {
			if (now > this.segmentStart) this.segments.push({ start: this.segmentStart, end: now });
			this.segmentStart = null;
		}
	};

	function result(show, hide, reason) {
		return { show: Boolean(show), hide: Boolean(hide), reason: reason || '' };
	}

	Monitor.prototype.update = function (state) {
		state = state || {};
		var now = Number(state.now) || 0;
		var streamKey = String(state.streamKey || '');
		if (streamKey !== this.streamKey) this.reset(now, streamKey);
		if (!this.startedAt) this.startedAt = now;
		var previous = this.lastAt === null ? now : this.lastAt;
		this.lastAt = now;
		if (state.ended) {
			this._closeSegment(previous);
			this.continuousStart = null;
			this.shown = false;
			this.recoveredSince = null;
			return result(false, true, 'ended');
		}
		if (state.paused || state.seeking) {
			this._closeSegment(previous);
			this.continuousStart = null;
			this.recoveredSince = null;
			this.shown = false;
			return result(false, true, state.seeking ? 'seeking' : 'paused');
		}
		// Initial preparation is not a playback stall. Do not count buffering
		// until the first frame has actually been decoded and presented.
		if (state.started === false) {
			this._closeSegment(previous);
			this.continuousStart = null;
			this.recoveredSince = null;
			this.shown = false;
			return result(false, true, 'starting');
		}
		if (now < this.graceUntil) return result(false, false, 'grace');
		if (now < this.dismissedUntil) return result(false, false, 'dismissed');
		if (state.buffering) {
			if (this.segmentStart === null) this.segmentStart = now;
			if (this.continuousStart === null) this.continuousStart = now;
			this.recoveredSince = null;
		} else {
			this._closeSegment(previous);
			this.continuousStart = null;
			if (this.shown) {
				if (this.recoveredSince === null) this.recoveredSince = now;
				if (now - this.recoveredSince >= this.options.recoveryMs) {
					this.shown = false;
					this.recoveredSince = null;
					this.segments = [];
					return result(false, true, 'recovered');
				}
			}
		}
		this._prune(now);
		var reason = '';
		if (this.continuousStart !== null && now - this.continuousStart >= this.options.continuousMs) reason = 'continuous';
		else if (this._cumulative(now) >= this.options.cumulativeMs) reason = 'cumulative';
		// Only genuine buffering may open the warning. A segment can cross the
		// threshold on the same tick that playback recovers; showing then would
		// interrupt healthy playback.
		if (state.buffering && reason && !this.shown) {
			this.shown = true;
			this.lastReason = reason;
			return result(true, false, reason);
		}
		return result(false, false, reason);
	};

	Monitor.prototype.dismiss = function (now) {
		this.shown = false;
		this.dismissedUntil = (Number(now) || 0) + this.options.dismissMs;
		this._closeSegment(Number(now) || 0);
		this.continuousStart = null;
		this.segments = [];
		this.recoveredSince = null;
		this.lastReason = '';
	};

	Monitor.prototype.isShown = function () { return this.shown; };

	root.TellyboxBufferingWarning = { Monitor: Monitor, DEFAULTS: DEFAULTS, QUALITY_RUNGS: QUALITY_RUNGS, nextLowerQuality: nextLowerQuality };
})(typeof globalThis !== 'undefined' ? globalThis : this);
