export const downloadQualities = [
	{ id:'small', label:'Small', bitrate:2000000, width:1280 },
	{ id:'balanced', label:'Balanced', bitrate:4000000, width:1920 },
	{ id:'high', label:'High', bitrate:8000000, width:1920 }
];
export function downloadOptions(item, source) {
	const duration = (source.RunTimeTicks || item.RunTimeTicks || 0) / 1e7;
	return [...downloadQualities.map(q => ({ ...q, container:'mp4', estimated:true,
		bytes:duration > 0 ? Math.round(duration * q.bitrate / 8 * 1.08) : null })),
		{ id:'original', label:'Original', bitrate:0, container:source.Container, estimated:false, bytes:source.Size }];
}
export function downloadQuality(value = 'original') {
	if (value === 'original') return null;
	const quality = downloadQualities.find(q => q.id === value);
	if (!quality) throw Object.assign(new Error('Choose a valid download quality.'), { status:400 });
	return quality;
}
