// HLS text captions share the video demuxer. No extra provider connection or burn-in.
export function captionMaster(tracks,bandwidth=8000000,selected=-1){
	return ['#EXTM3U','#EXT-X-VERSION:3',...tracks.map(track=>`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="captions",NAME="tellybox-subtitle-${track.index}",LANGUAGE="${/^[a-z]{2,3}$/i.test(track.tags?.language||'')?track.tags.language:'und'}",AUTOSELECT=${track.index===selected?'YES':'NO'},DEFAULT=${track.index===selected?'YES':'NO'},URI="captions-${track.index}.m3u8"`),
		`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth+160000},SUBTITLES="captions"`,'video.m3u8',''].join('\n');
}
export function captionManifest(duration,index){
	const lines=['#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:4','#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-PLAYLIST-TYPE:VOD'];
	for(let n=0;n<Math.ceil(duration/4);n++)lines.push('#EXTINF:'+Math.min(4,duration-n*4).toFixed(3)+',',`caption-${index}-${n}.vtt`);
	return lines.concat('#EXT-X-ENDLIST','').join('\n');
}
function seconds(value){const parts=value.split(':').map(Number);return parts.reduce((total,n)=>total*60+n,0);}
export function captionSlice(text,n){
	const cues=text.replace(/\r/g,'').split(/\n\s*\n/).filter(block=>{
		const time=block.match(/(\d+:\d+(?::\d+)?\.\d+)\s+-->\s+(\d+:\d+(?::\d+)?\.\d+)/);
		return time&&seconds(time[1])<(n+1)*4&&seconds(time[2])>n*4;
	});
	return 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000\n\n'+cues.join('\n\n')+'\n\n';
}
