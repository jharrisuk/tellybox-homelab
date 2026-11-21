const $=selector=>document.querySelector(selector);
const sourceLabel = window.TellyboxSourceLabel || { streamed: item => 'Streamed', streamNow: item => 'Stream now', available: item => 'Available in the streamed catalogue.' };
const initial=new URLSearchParams(location.search);
let query=(initial.get('q')||'').slice(0,200),type=['movie','tv'].includes(initial.get('type'))?initial.get('type'):'all',generation=0,timer,restorePending=null,availableOffset=0;
function element(tag,text,className) { const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node; }
function resultCard(item,discovery) {
	const name=discovery?item.title:item.Name,link=element('a',undefined,'discover-card');
	link.href=discovery?'/discover?type='+item.type+'&title='+encodeURIComponent(item.id):'/?item='+encodeURIComponent(item.Id)+'&from=search';
	if(!discovery)link.addEventListener('click',saveHandoffState);
	const poster=element('span',undefined,'discover-poster'),image=element('img');image.alt='';image.loading='lazy';
	const source=item.Artwork||(discovery?(item.poster?'https://image.tmdb.org/t/p/w342'+item.poster:''):(item.watchId?'/images/'+encodeURIComponent(item.watchId)+'/Primary?width=342':'/images/'+encodeURIComponent(item.Id)+'/Primary?width=342'));
	const fallback = discovery ? (item.type==='tv'?'TV':'FILM') : item.Type==='Movie'?'FILM':'TV';
	if(source){
		if(item.ArtworkLocal){image.dataset.tellyboxLocal=item.ArtworkLocal;image.dataset.tellyboxFallback='1';}
		if(/^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(item.poster||''))image.dataset.tellyboxPoster='https://image.tmdb.org/t/p/w342'+item.poster;
		image.src=source;image.onerror=()=>{if(!image.dataset.tellyboxFallback)poster.replaceChildren(element('span',fallback));};poster.append(image);
	}else poster.append(element('span',fallback));
	const kind=discovery?(item.type==='tv'?'TV show':'Film'):item.Type==='TvChannel'?(item.Nonstop?'24/7 channel':'Live TV'):item.Type==='Episode'?'Episode':item.Type==='Series'?'TV show':'Film',year=discovery?(item.date||'').slice(0,4):item.ProductionYear;
	const action=discovery?(item.watchId?'Watch now · local':item.vodAvailable?sourceLabel.streamNow(item):item.statusLabel==='Not requested'&&item.requestable?'Add to local library':item.statusLabel):(item.Type==='TvChannel'?'Watch live':item.Source==='streamed'?sourceLabel.streamNow(item):'Watch now · local');
	link.append(poster,element('strong',item.SeriesName?item.SeriesName+' · '+name:name),element('span',kind+(year?' · '+year:''),'discover-meta'),element('span',action,'search-action'));
	return link;
}

// Cross-document handoff state. Following a /?item=... link leaves Search for
// the home player; app.js arms a one-shot marker on the way back. Only that
// immediate return restores the loaded result page and scroll. Query and type
// are already in the URL.
const handoffMarkerKey='tellybox-handoff';
const handoffStateKey='tellybox-handoff-search';
const handoffTtl=5*60*1000;
function scrollHost(){return document.scrollingElement||document.documentElement;}
function saveHandoffState(){
	try{
		const host=scrollHost();
		const scroll=host&&Number.isFinite(host.scrollTop)?host.scrollTop:0;
		if(!Number.isFinite(scroll)||scroll<0||scroll>1e9)return;
		// Remember where the viewer's focus was, so the one-shot return can put
		// it back instead of dumping it on the document body. Only the query
		// input or a result card index is stored - never any content data.
		const active=document.activeElement;
		const cardIndex=active&&active.closest?[...document.querySelectorAll('#availableSection .discover-card')].indexOf(active.closest('.discover-card')):-1;
		const focus=active&&active.id==='query'?{kind:'query'}:cardIndex>=0?{kind:'card',index:cardIndex}:null;
		const raw=JSON.stringify({scroll,availableOffset:Number.isInteger(availableOffset)&&availableOffset>0?availableOffset:0,path:location.pathname,at:Date.now(),expiresAt:Date.now()+handoffTtl,focus});
		if(raw.length>2048)return;
		sessionStorage.setItem(handoffStateKey,raw);
	}catch{}
}
function arrivedViaBack(){
	try{const entries=performance.getEntriesByType('navigation');if(entries&&entries.length&&entries[0].type)return entries[0].type==='back_forward';}catch{}
	return false;
}
function takeHandoffState(){
	try{
		const markerRaw=sessionStorage.getItem(handoffMarkerKey);
		if(!markerRaw)return null;
		let marker=null;try{marker=JSON.parse(markerRaw);}catch{marker=null;}
		if(!marker||marker.path!==location.pathname)return null;
		sessionStorage.removeItem(handoffMarkerKey);
		if(!Number.isFinite(marker.expiresAt)||Date.now()>marker.expiresAt)return null;
		if(!arrivedViaBack())return null;
		const stateRaw=sessionStorage.getItem(handoffStateKey);
		if(!stateRaw)return null;
		let state=null;try{state=JSON.parse(stateRaw);}catch{state=null;}
		sessionStorage.removeItem(handoffStateKey);
		if(!state||!Number.isFinite(state.scroll))return null;
		if(!Number.isFinite(state.expiresAt)||Date.now()>state.expiresAt)return null;
		return state;
	}catch{return null;}
}
async function restoreHandoff(saved){
	if(!saved)return;
	try{
		if(Number.isInteger(saved.availableOffset)&&saved.availableOffset>0){
			for(let offset=60;offset<=saved.availableOffset;offset+=60)await section('available',offset,generation);
		}
		const host=scrollHost();
		if(host)host.scrollTop=Math.max(0,Math.min(Math.round(saved.scroll),1e9));
		// Focus restoration is best-effort and never scrolls the page again.
		if(saved.focus&&saved.focus.kind==='query'){const input=$('#query');if(input)try{input.focus({preventScroll:true});}catch{}}
		else if(saved.focus&&saved.focus.kind==='card'&&Number.isInteger(saved.focus.index)){
			const card=[...document.querySelectorAll('#availableSection .discover-card')][saved.focus.index];
			if(card)try{card.focus({preventScroll:true});}catch{}
		}
	}catch{}
}
async function section(scope,offset=0,token=generation) {
	if(scope==='available')availableOffset=offset;
	const host=$('#'+(scope+'Section')),status=host.querySelector('.status'),grid=host.querySelector('.discover-grid'),more=host.querySelector('button');
	status.replaceChildren();status.textContent='Searching…';more.hidden=true;
	try {
		const params=new URLSearchParams({q:query,type,scope,[scope!=='more'?'start':'page']:String(scope!=='more'?offset:offset||1)});
		const response=await fetch('/api/search?'+params);
		if(response.status===401){location.assign('/login');return;}
		const data=await response.json();if(!response.ok)throw Error(data.error||'Search is unavailable.');if(token!==generation)return;
		grid.append(...data.items.map(item=>resultCard(item,scope==='more')));
		if (['channels','episodes'].includes(scope)) host.hidden = !grid.childElementCount && !data.notice;
		status.textContent=data.notice||(grid.childElementCount?'':scope==='available'?'Not in the collection yet. Choose a title below to add it.':scope==='more'?'No other matching titles. Try another name or spelling.':'No matching '+scope+'.');
		const next=scope!=='more'?offset+60:data.page+1,hasMore=scope!=='more'?next<data.total:next<=data.pages;
		more.hidden=!hasMore;more.onclick=()=>section(scope,next,token);
	}catch(error){if(token!==generation)return;status.textContent=error.message+' ';const retry=element('button','Try again','button quiet');retry.onclick=()=>section(scope,offset,token);status.append(retry);}
}
function search() {
	query=$('#query').value.trim();const token=++generation;
	history.replaceState(null,'','/search?'+new URLSearchParams({q:query,type}));
	$('#searchHint').hidden=Boolean(query);
	for(const button of document.querySelectorAll('#searchTypes button')){button.classList.toggle('active',button.dataset.type===type);button.setAttribute('aria-pressed',String(button.dataset.type===type));}
	const tasks=[];
	for(const scope of ['available','channels','episodes','more']){const host=$('#'+(scope+'Section'));host.hidden=!query||(scope==='channels'&&type!=='all')||(scope==='episodes'&&type==='movie');host.querySelector('.discover-grid').replaceChildren();if(!host.hidden)tasks.push(section(scope,0,token));}
	if(restorePending){const saved=restorePending;restorePending=null;Promise.all(tasks).then(()=>restoreHandoff(saved));}
}
$('#query').value=query;
$('#globalSearch').onsubmit=event=>{event.preventDefault();clearTimeout(timer);search();};
$('#query').oninput=()=>{clearTimeout(timer);++generation;timer=setTimeout(search,450);};
for(const button of document.querySelectorAll('#searchTypes button'))button.onclick=()=>{type=button.dataset.type;clearTimeout(timer);search();};
window.addEventListener('pagehide',saveHandoffState);
// A back/forward-cache restore re-shows the page without re-running this script
// and the browser already restored the scroll and content, so just consume the
// one-shot marker/state so a later visit does not restore stale state.
window.addEventListener('pageshow',event=>{if(event&&event.persisted){try{const raw=sessionStorage.getItem(handoffMarkerKey);if(raw){let marker=null;try{marker=JSON.parse(raw);}catch{marker=null;}if(marker&&marker.path===location.pathname)sessionStorage.removeItem(handoffMarkerKey);}sessionStorage.removeItem(handoffStateKey);}catch{}}});
restorePending=takeHandoffState();
search();
