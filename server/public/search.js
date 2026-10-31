const $=selector=>document.querySelector(selector);
const initial=new URLSearchParams(location.search);
let query=(initial.get('q')||'').slice(0,200),type=['movie','tv'].includes(initial.get('type'))?initial.get('type'):'all',generation=0,timer;
function element(tag,text,className) { const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node; }
function resultCard(item,discovery) {
	const name=discovery?item.title:item.Name,link=element('a',undefined,'discover-card');
	link.href=discovery?'/discover?type='+item.type+'&title='+encodeURIComponent(item.id):'/?item='+encodeURIComponent(item.Id);
	const poster=element('span',undefined,'discover-poster'),image=element('img');image.alt='';image.loading='lazy';
	const source=discovery?(item.poster?'https://image.tmdb.org/t/p/w342'+item.poster:''):(item.Artwork||'/images/'+encodeURIComponent(item.Id)+'/Primary?width=342');
	const fallback = discovery ? (item.type==='tv'?'TV':'FILM') : item.Type==='Movie'?'FILM':'TV';
	if(source){image.src=source;image.onerror=()=>poster.replaceChildren(element('span',fallback));poster.append(image);}else poster.append(element('span',fallback));
	const kind=discovery?(item.type==='tv'?'TV show':'Film'):item.Type==='TvChannel'?(item.Nonstop?'24/7 channel':'Live TV'):item.Type==='Episode'?'Episode':item.Type==='Series'?'TV show':'Film',year=discovery?(item.date||'').slice(0,4):item.ProductionYear;
	const action=discovery?(item.watchId?'Watch now · local':item.vodAvailable?'Stream now · Dispatcharr':item.statusLabel==='Not requested'&&item.requestable?'Add to local library':item.statusLabel):(item.Type==='TvChannel'?'Watch live':item.Source==='streamed'?'Stream now · Dispatcharr':'Watch now · local');
	link.append(poster,element('strong',item.SeriesName?item.SeriesName+' · '+name:name),element('span',kind+(year?' · '+year:''),'discover-meta'),element('span',action,'search-action'));
	return link;
}
async function section(scope,offset=0,token=generation) {
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
	for(const scope of ['available','channels','episodes','more']){const host=$('#'+(scope+'Section'));host.hidden=!query||(scope==='channels'&&type!=='all')||(scope==='episodes'&&type==='movie');host.querySelector('.discover-grid').replaceChildren();if(!host.hidden)void section(scope,0,token);}
}
$('#query').value=query;
$('#globalSearch').onsubmit=event=>{event.preventDefault();clearTimeout(timer);search();};
$('#query').oninput=()=>{clearTimeout(timer);++generation;timer=setTimeout(search,450);};
for(const button of document.querySelectorAll('#searchTypes button'))button.onclick=()=>{type=button.dataset.type;clearTimeout(timer);search();};
search();
