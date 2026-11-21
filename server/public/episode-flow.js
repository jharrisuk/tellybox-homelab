/* Shared episode timing policy for the browser player.
 *
 * Times in this file are milliseconds. Media segment times from the server are
 * seconds, so callers convert before asking for an intro, outro or card state.
 * The Android app mirrors these rules in EpisodeFlow.java.
 */
(function (root) {
	'use strict';

	const COUNTDOWN_SECONDS = 10;
	const FALLBACK_LEAD_MS = 45000;
	const MIN_FALLBACK_LEAD_MS = 5000;
	const EARLY_COUNTDOWN_LEAD_MS = 15000;
	const MIN_EARLY_COUNTDOWN_LEAD_MS = 10000;
	const EARLY_COUNTDOWN_FRACTION = 0.1;
	const INTRO_MIN_MS = 2000;
	const INTRO_MAX_MS = 300000;
	const RECAP_MAX_MS = 900000;
	const OUTRO_MIN_MS = 5000;
	const OUTRO_MAX_MS = 900000;
	const OUTRO_TAIL_FRACTION = 0.8;
	const OUTRO_MAX_TAIL_MS = 240000;
	const DURATION_TOLERANCE_MS = 5000;

	function finite(value) {
		return typeof value === 'number' && Number.isFinite(value);
	}

	function segmentWindow(segment, type, durationMs, maxLengthMs) {
		if (!segment || segment.type !== type) return null;
		const start = Number(segment.start), end = Number(segment.end);
		if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
		if (start < 0 || end <= start) return null;
		const startMs = start * 1000, endMs = end * 1000;
		if (endMs - startMs < INTRO_MIN_MS || endMs - startMs > maxLengthMs) return null;
		if (durationMs > 0 && (startMs >= durationMs || endMs > durationMs + DURATION_TOLERANCE_MS)) return null;
		return { segment, startMs, endMs };
	}

	function validIntro(segment, durationMs) {
		return Boolean(segmentWindow(segment, 'Intro', durationMs, INTRO_MAX_MS));
	}

	function validOutro(segment, durationMs) {
		return Boolean(segmentWindow(segment, 'Outro', durationMs, OUTRO_MAX_MS));
	}

	function firstActive(segments, positionMs, durationMs, types) {
		if (!Array.isArray(segments) || !Number.isFinite(positionMs)) return null;
		for (const segment of segments) {
			const type = segment && segment.type;
			if (!types.includes(type)) continue;
			const window = segmentWindow(segment, type, durationMs, type === 'Intro' ? INTRO_MAX_MS : RECAP_MAX_MS);
			if (window && positionMs >= window.startMs && positionMs < window.endMs) return segment;
		}
		return null;
	}

	/** A confirmed intro marker that contains the current timeline position. */
	function introAt(segments, positionMs, durationMs) {
		return firstActive(segments, positionMs, durationMs, ['Intro']);
	}

	/** Intro or recap, used only for the manual Skip button. Outros never appear here. */
	function manualAt(segments, positionMs, durationMs) {
		return firstActive(segments, positionMs, durationMs, ['Intro', 'Recap']);
	}

	/** A conservative outro: in the final fifth, at most four minutes of credits,
	 * and at least five seconds long. Anything looser falls back to end timing. */
	function isReliableOutro(outro, durationMs) {
		const window = segmentWindow(outro, 'Outro', durationMs, OUTRO_MAX_MS);
		if (!window) return false;
		const tailMs = durationMs - window.startMs;
		return window.startMs >= durationMs * OUTRO_TAIL_FRACTION
			&& tailMs <= OUTRO_MAX_TAIL_MS
			&& window.endMs - window.startMs >= OUTRO_MIN_MS;
	}

	function reliableOutro(segments, durationMs) {
		if (!Array.isArray(segments) || !(durationMs > 0)) return null;
		let found = null;
		for (const segment of segments) {
			if (!isReliableOutro(segment, durationMs)) continue;
			const startMs = Number(segment.start) * 1000;
			if (!found || startMs > Number(found.start) * 1000) found = segment;
		}
		return found;
	}

	/** Without a confirmed outro the card appears about 45 seconds early, but
	 * short episodes keep the lead to at most a fifth (and half) of their length. */
	function fallbackLeadMs(durationMs) {
		if (!(durationMs > 0)) return 0;
		const lead = Math.max(MIN_FALLBACK_LEAD_MS, durationMs * 0.2);
		return Math.min(FALLBACK_LEAD_MS, lead, durationMs / 2);
	}

	/** Whether the next card should be visible at this position. */
	function cardDue(positionMs, durationMs, ended, outro) {
		if (ended) return true;
		if (!Number.isFinite(positionMs) || !(durationMs > 0)) return false;
		if (outro && isReliableOutro(outro, durationMs)) {
			return positionMs >= Number(outro.start) * 1000;
		}
		const lead = fallbackLeadMs(durationMs);
		return lead > 0 && positionMs >= durationMs - lead;
	}

	/** Without a confirmed outro the countdown starts 15 seconds before the
	 * end. Keep it to at most a tenth of the runtime; when that would be less
	 * than ten seconds, wait for the real end instead of cutting a short episode. */
	function earlyCountdownLeadMs(durationMs) {
		if (!(durationMs > 0)) return 0;
		const lead = Math.min(EARLY_COUNTDOWN_LEAD_MS, durationMs * EARLY_COUNTDOWN_FRACTION);
		return lead >= MIN_EARLY_COUNTDOWN_LEAD_MS ? lead : 0;
	}

	/** A countdown may run during confirmed credits, in the final fallback
	 * window, or once playback has ended. A confirmed outro always wins. */
	function creditsCountdown(positionMs, durationMs, ended, outro) {
		if (ended) return true;
		if (!Number.isFinite(positionMs) || !(durationMs > 0) || positionMs < 0) return false;
		if (outro && isReliableOutro(outro, durationMs)) return positionMs >= Number(outro.start) * 1000;
		const lead = earlyCountdownLeadMs(durationMs);
		return lead > 0 && positionMs >= durationMs - lead && positionMs <= durationMs + DURATION_TOLERANCE_MS;
	}

	/** Pause, buffering, a hidden tab, casting or a stopped player must not
	 * consume countdown time. An ended player is allowed to count down. */
	function countdownCanAdvance(state) {
		const value = state || {};
		if (value.hidden || value.casting || value.stopped || value.live || value.blocked) return false;
		if (value.ended) return true;
		return Boolean(value.playing) && !value.buffering && !value.seeking;
	}

	/** Skip each intro marker once per playback, even if the viewer seeks back. */
	class IntroLedger {
		constructor() {
			this.seen = new Set();
		}
		static key(marker) {
			return marker ? String(marker.start) + ':' + String(marker.end) : '';
		}
		shouldSkip(marker, positionMs, durationMs) {
			if (!validIntro(marker, durationMs)) return false;
			const window = segmentWindow(marker, 'Intro', durationMs, INTRO_MAX_MS);
			if (!window || positionMs < window.startMs || positionMs >= window.endMs) return false;
			return !this.seen.has(IntroLedger.key(marker));
		}
		mark(marker) {
			if (marker) this.seen.add(IntroLedger.key(marker));
		}
		reset() {
			this.seen.clear();
		}
	}

	/** TMDB air dates are date-only. Keep the calendar date; never apply a
	 * midnight timezone conversion. */
	function dateOnly(value) {
		const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
		if (!match) return '';
		const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
		const date = new Date(Date.UTC(year, month - 1, day));
		if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
		return match[1] + '-' + match[2] + '-' + match[3];
	}

	function airDateInfo(value, now = new Date()) {
		const date = dateOnly(value);
		if (!date) return { date: '', phase: 'unknown', difference: null, label: 'Date not announced' };
		const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7)), day = Number(date.slice(8, 10));
		const target = Date.UTC(year, month - 1, day);
		const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
		const difference = Math.round((target - today) / 86400000);
		const formatted = new Date(target).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
		return { date, phase: difference < 0 ? 'past' : difference === 0 ? 'today' : 'future', difference,
			label: difference === 0 ? 'Today' : difference === 1 ? 'Tomorrow' : formatted };
	}

	function nextEpisodeIdentity(next) {
		if (!next) return '';
		const label = 'S' + next.season + ' E' + next.episode;
		return next.title ? label + ' - ' + next.title : label;
	}

	/** Copy for the finished screen. It never claims the episode is available
	 * in Tellybox merely because it has a broadcast date. */
	function nextScheduleCopy(schedule, now = new Date()) {
		if (!schedule || !schedule.next || !['scheduled', 'aired-missing'].includes(schedule.status)) return null;
		const air = airDateInfo(schedule.next.airDate, now);
		if (schedule.status === 'aired-missing') {
			const when = air.phase === 'unknown' ? 'Aired; date not announced'
				: air.phase === 'today' ? 'Aired today'
				: 'Aired ' + air.label;
			return { phase: 'aired', identity: nextEpisodeIdentity(schedule.next), when, detail: 'Not yet available in Tellybox.' };
		}
		const when = air.phase === 'today' ? 'Airs today'
			: air.phase === 'future' ? 'Airs ' + air.label
			: air.phase === 'past' ? 'Scheduled date has passed' : 'Scheduled; date not announced';
		return { phase: 'scheduled', identity: nextEpisodeIdentity(schedule.next), when, detail: 'Not yet available in Tellybox.' };
	}

	root.TellyboxEpisodeFlow = {
		COUNTDOWN_SECONDS,
		FALLBACK_LEAD_MS,
		validIntro,
		validOutro,
		introAt,
		manualAt,
		reliableOutro,
		fallbackLeadMs,
		earlyCountdownLeadMs,
		cardDue,
		creditsCountdown,
		countdownCanAdvance,
		dateOnly,
		airDateInfo,
		nextEpisodeIdentity,
		nextScheduleCopy,
		IntroLedger
	};
})(typeof globalThis !== 'undefined' ? globalThis : this);
