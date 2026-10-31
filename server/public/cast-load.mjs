// A receiver can start playing before the SDK's load promise settles.
// Confirm this exact media URL from receiver state, with a bounded wait.
export function loadCastMedia(target, request, { isCurrent = () => true, timeoutMs = 30000, pollMs = 250 } = {}) {
	return new Promise((resolve, reject) => {
		let finished = false;
		let poll;
		let deadline;
		const finish = error => {
			if (finished) return;
			finished = true;
			clearInterval(poll);
			clearTimeout(deadline);
			error ? reject(error) : resolve();
		};
		const confirmed = () => {
			const media = target.getMediaSession();
			return media?.media?.contentId === request.media.contentId
				&& ['PLAYING', 'PAUSED', 'BUFFERING'].includes(media.playerState);
		};
		const check = () => {
			if (finished) return;
			if (!isCurrent()) return finish(Object.assign(new Error('Casting cancelled.'), { code: 'cancel' }));
			try { if (confirmed()) finish(); } catch { /* Wait for the next receiver update. */ }
		};
		poll = setInterval(check, pollMs);
		deadline = setTimeout(() => {
			check();
			if (!finished) finish(Object.assign(new Error('The TV did not confirm the stream.'), { code: 'timeout' }));
		}, timeoutMs);
		try {
			Promise.resolve(target.loadMedia(request)).then(result => {
				check();
				if (result && !finished) finish(Object.assign(new Error('The TV rejected the stream.'), { code: result }));
			}, error => { check(); if (!finished) finish(error || new Error('The TV rejected the stream.')); });
		} catch (error) { finish(error); }
		check();
	});
}
