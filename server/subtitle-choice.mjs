export function englishSubtitle(language, ...labels) {
	return [language, ...labels].some(label => /(?:^|[^a-z])(?:english|eng|en)(?=$|[^a-z])/i.test(String(label || '').normalize('NFKC')));
}

// Explicit choices (including Off) take precedence over the installation preference.
export function subtitleChoice(request, streams = []) {
	if (Number.isInteger(request.subtitleIndex)) return request.subtitleIndex;
	if (request.preferEnglishSubtitles !== true) return -1;
	const english = streams.filter(track => track.Type === 'Subtitle'
		&& englishSubtitle(track.Language, track.DisplayTitle, track.Title) && Number.isInteger(track.Index));
	// Text captions can switch in the player without restarting video conversion.
	const text = request.textSubtitles === true ? english.find(track => /^(subrip|srt|ass|ssa|webvtt|vtt|mov_text|text)$/i.test(track.Codec || '')) : null;
	return (text || english[0])?.Index ?? -1;
}
