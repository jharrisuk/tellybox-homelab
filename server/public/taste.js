(() => {
	const interests = ['Documentary','Crime','Comedy','Drama','Action','Adventure','Science Fiction','Fantasy','Family','Animation','History','Mystery','Thriller','Horror','Romance','Music'];
	function read() { try { return JSON.parse(localStorage.getItem('tellybox-taste') || '{}'); } catch { return {}; } }
	function save(value) { localStorage.setItem('tellybox-taste', JSON.stringify(value)); window.dispatchEvent(new Event('tastechange')); }
	function key(item) { return item.Id || 'tmdb:' + item.type + ':' + item.id; }
	function genres(item) { return (item.Genres || item.genres || []).filter(g => typeof g === 'string').flatMap(g => { const name=g.toLowerCase(); if(name==='sci-fi & fantasy')return ['Science Fiction','Fantasy']; if(name==='action & adventure')return ['Action','Adventure']; if(name==='sci-fi')return ['Science Fiction']; if(name==='documentaries')return ['Documentary']; return interests.filter(i=>i.toLowerCase()===name); }); }
	function payload() {
		const data = read(), weights = {}, exclude = new Set();
		for (const name of data.interests || []) weights[name] = 3;
		for (const [id, vote] of Object.entries(data.votes || {})) {
			for (const name of vote.genres || []) if (interests.includes(name)) weights[name] = (weights[name] || 0) + vote.value;
			if (vote.value < 0) { exclude.add(id); if (vote.watchId) exclude.add(vote.watchId); }
		}
		for (let n = 0; n < localStorage.length; n++) { const id = localStorage.key(n); if (id.startsWith('tellybox-watched-') && localStorage.getItem(id) === 'true') exclude.add(id.slice(17)); }
		return { genres:Object.entries(weights).map(([name,weight]) => ({name,weight:Math.max(-50,Math.min(50,weight))})), exclude:[...exclude].filter(id => /^(?:[a-f0-9-]{32,36}|tmdb:(?:movie|tv):[1-9][0-9]{0,9})$/i.test(id)).slice(-300) };
	}
	function controls(item) {
		const group = document.createElement('div'); group.className = 'taste-controls'; group.setAttribute('aria-label','Your opinion');
		const paths = { up:'M7 10v10H3V10h4zm3 10h7a2 2 0 0 0 2-1.6l1-6A2 2 0 0 0 18 10h-5l1-5a2 2 0 0 0-2-2l-5 7v10h3z', down:'M7 14V4H3v10h4zm3-10h7a2 2 0 0 1 2 1.6l1 6A2 2 0 0 1 18 14h-5l1 5a2 2 0 0 1-2 2l-5-7V4h3z' };
		function render() {
			group.replaceChildren();
			for (const [label,value,icon] of [['Like',1,'up'],['Not for me',-1,'down']]) {
				const button = document.createElement('button'); button.className='button quiet'; button.type='button';
				const active=read().votes?.[key(item)]?.value===value; button.setAttribute('aria-pressed',String(active));
				button.innerHTML='<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="'+paths[icon]+'" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
				button.append(document.createTextNode(label));
				button.onclick=()=>{try { const data=read(); data.votes ||= {}; data.votes[key(item)]={value:active?0:value,genres:genres(item),watchId:item.watchId || item.Id}; const entries=Object.entries(data.votes); data.votes=Object.fromEntries(entries.slice(-500)); save(data); render(); } catch { button.textContent='Browser storage is unavailable'; }};
				group.append(button);
			}
		}
		render(); return group;
	}
	window.TellyboxTaste = { interests, payload, controls, selected:()=>read().interests || [], select:values=>{ const data=read(); data.interests=values; save(data); } };
})();
