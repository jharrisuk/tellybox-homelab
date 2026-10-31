/** An explicit address shortcut, never a service detector or an enable switch. */
export function locationChoice(current, defaultUrl, onThisServer) {
	if(onThisServer)return {onThisServer:true,url:defaultUrl,manualUrl:current.onThisServer?current.manualUrl||'':current.url||''};
	return {onThisServer:false,url:current.manualUrl||'',manualUrl:current.manualUrl||''};
}

// Import metadata only: do not rewrite a working address or treat the whole LAN as one host.
export function isSameServerAddress(address, localOrigin) {
	try {
		const target = new URL(address), home = new URL(localOrigin);
		return ['http:', 'https:'].includes(target.protocol) && ['http:', 'https:'].includes(home.protocol)
			&& (target.hostname === 'host.docker.internal' || target.hostname === home.hostname)
			&& !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
	} catch { return false; }
}
