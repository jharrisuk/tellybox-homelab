// Shared relay quality contract. Live/nonstop default to 20 Mbps; streamed
// VOD, recordings and catch-up default to 8 Mbps. Explicit values must be one
// of the supported rungs. An absent value preserves the caller's prior rung
// when it is valid, so a seek/replacement does not silently reset quality.
export const RELAY_QUALITY_RUNGS = Object.freeze([2000000, 4000000, 8000000, 20000000, 80000000]);

export function relayQualityDefault(mode) {
	return ['live', 'nonstop'].includes(mode) ? 20000000 : 8000000;
}

export function normalizeRelayQuality(mode, requested, fallback) {
	const value = Number(requested);
	if (RELAY_QUALITY_RUNGS.includes(value)) return value;
	if (requested === undefined || requested === null) {
		const prior = Number(fallback);
		if (RELAY_QUALITY_RUNGS.includes(prior)) return prior;
	}
	return relayQualityDefault(mode);
}
