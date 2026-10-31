import { BlockList, isIP } from 'node:net';

const excluded = new BlockList();
for (const [network, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]]) excluded.addSubnet(network, bits, 'ipv4');

export function createHomeNetwork(endpoint, { fetcher = fetch, now = Date.now, onChange = () => {} } = {}) {
	let address = '';
	let expires = 0;
	let refreshing = false;
	const enabled = Boolean(endpoint);
	if (enabled && new URL(endpoint).protocol !== 'https:') throw new Error('Home IP discovery requires HTTPS');
	function replace(value) {
		const previous = address;
		address = value;
		expires = value ? now() + 120000 : 0;
		if (previous && previous !== value) onChange(previous);
	}
	return {
		enabled,
		matches(value) { return Boolean(address && expires > now() && value === address); },
		status() { return { enabled, active: Boolean(address && expires > now()) }; },
		async refresh() {
			if (!enabled || refreshing) return;
			refreshing = true;
			try {
				const response = await fetcher(endpoint, { signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store' });
				if (!response.ok) throw new Error('Home address check failed');
				const value = (await response.text()).trim();
				// This relay has an IPv4 A record. Reject LAN, carrier-private and malformed replies.
				if (isIP(value) !== 4 || excluded.check(value, 'ipv4')) throw new Error('Invalid public address');
				replace(value);
			} catch { replace(''); }
			finally { refreshing = false; }
		}
	};
}
