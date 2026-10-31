import path from 'node:path';
import {jsonStore} from './json-store.mjs';

export function createRemoteControls(directory) {
	const defaults={enabled:true,vod:true,nonstop:true};
	const store=jsonStore(path.join(directory,'remote-controls.json'),defaults);
	const status=()=>({...defaults,...store.get()});
	function set(body) {
		if(!body||Object.keys(defaults).some(key=>typeof body[key]!=='boolean'))throw Object.assign(Error('Choose whether to allow remote viewing, IPTV on demand and 24/7.'),{status:400});
		Object.assign(store.get(),Object.fromEntries(Object.keys(defaults).map(key=>[key,body[key]])));
		store.save();return status();
	}
	function reason(viewer,media={}) {
		if(viewer?.local||viewer?.home)return '';
		const policy=status();
		if(!policy.enabled)return 'Remote viewing is temporarily paused by the owner. Please try again later.';
		if(!policy.vod&&/^dispatch-(movie-\d+|episode-\d+-\d+)$/.test(media.itemId||''))return 'IPTV films and series are currently available only at home.';
		if(!policy.nonstop&&media.nonstop)return '24/7 channels are currently available only at home.';
		return '';
	}
	function guard(viewer,media) {const message=reason(viewer,media);if(message)throw Object.assign(Error(message),{status:403});}
	return {status,set,reason,guard,allowed:(viewer,media)=>!reason(viewer,media)};
}
