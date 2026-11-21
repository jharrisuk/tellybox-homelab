// HLS text captions share the video demuxer. No extra provider connection or burn-in.
export function captionMaster(tracks,bandwidth=8000000,selected=-1){
	return ['#EXTM3U','#EXT-X-VERSION:3',...tracks.map(track=>`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="captions",NAME="tellybox-subtitle-${track.index}",LANGUAGE="${/^[a-z]{2,3}$/i.test(track.tags?.language||'')?track.tags.language:'und'}",AUTOSELECT=${track.index===selected?'YES':'NO'},DEFAULT=${track.index===selected?'YES':'NO'},URI="captions-${track.index}.m3u8"`),
		`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth+160000},SUBTITLES="captions"`,'video.m3u8',''].join('\n');
}
export function captionManifest(duration,index,segmentSeconds=4,durations){
	const step=Number(segmentSeconds)>0?Number(segmentSeconds):4;
	// Copy mode passes the same authoritative per-segment durations as the
	// video playlist, so captions never advertise a segment the video does not
	// produce (and never truncate a genuine short tail).
	const list=Array.isArray(durations)&&durations.length&&durations.every(value=>Number.isFinite(value)&&value>0)?durations:null;
	const count=list?list.length:Math.ceil(duration/step);
	const target=Math.max(1,Math.ceil(list?Math.max(...list):step));
	const lines=['#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:'+target,'#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-PLAYLIST-TYPE:VOD'];
	for(let n=0;n<count;n++)lines.push('#EXTINF:'+(list?Number(list[n]):Math.min(step,duration-n*step)).toFixed(3)+',',`caption-${index}-${n}.vtt`);
	return lines.concat('#EXT-X-ENDLIST','').join('\n');
}
function seconds(value){const parts=value.split(':').map(Number);return parts.reduce((total,n)=>total*60+n,0);}
// Slice WebVTT cues for segment n. The default keeps the fixed 4 s grid used
// by the transcode path; the copy path passes real accumulated segment
// durations so caption timing matches copy-mode segment boundaries.
export function captionSlice(text,n,durations){
	let start=n*4,end=(n+1)*4;
	if(Array.isArray(durations)) {
		start=0;end=0;
		for(let i=0;i<n;i++)start+=durations[i]||0;
		for(let i=0;i<=n;i++)end+=durations[i]||0;
	}
	const cues=text.replace(/\r/g,'').split(/\n\s*\n/).filter(block=>{
		const time=block.match(/(\d+:\d+(?::\d+)?\.\d+)\s+-->\s+(\d+:\d+(?::\d+)?\.\d+)/);
		return time&&seconds(time[1])<end&&seconds(time[2])>start;
	});
	return 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000\n\n'+cues.join('\n\n')+'\n\n';
}
