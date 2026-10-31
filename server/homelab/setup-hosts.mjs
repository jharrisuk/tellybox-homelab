import { BlockList, isIP } from 'node:net';

const privateAddresses=new BlockList();
for(const [address,bits] of [['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16],['100.64.0.0',10],['127.0.0.0',8]])privateAddresses.addSubnet(address,bits,'ipv4');
privateAddresses.addSubnet('fc00::',7,'ipv6');privateAddresses.addAddress('::1','ipv6');
const canonical=host=>isIP(host)===6?new URL('http://['+host+']').hostname.slice(1,-1):host.toLowerCase();

export function localConnectionSuggestion(peer='') {
	const address=peer.replace(/^::ffff:/i,'');const type=isIP(address);
	if(!type||address==='::1'||address.startsWith('127.')||!privateAddresses.check(address,type===6?'ipv6':'ipv4'))return null;
	return {address:canonical(address),cidr:canonical(address)+(type===6?'/128':'/32')};
}

// Binding is configured separately by Docker/native launch. This only validates Host;
// it never grants a session or treats forwarded headers as a local identity.
export function setupHosts(configured='') {
	if(typeof configured!=='string')throw Error('Configure setup with a private IP address.');
	const hosts=new Set(['localhost','127.0.0.1','::1']);
	for(const value of configured.split(',').map(value=>value.trim()).filter(Boolean)) {
		const type=isIP(value);
		if(!type||!privateAddresses.check(value,type===6?'ipv6':'ipv4'))throw Error('Setup hosts must be explicit private or loopback IP addresses.');
		hosts.add(canonical(value));
	}
	return header=>{
		const match=/^(\[[0-9a-f:]+\]|[a-z0-9.]+)(?::([0-9]{1,5}))?$/i.exec(header||'');
		if(!match||(match[2]&&(Number(match[2])<1||Number(match[2])>65535)))return false;
		const host=match[1].startsWith('[')?match[1].slice(1,-1):match[1];
		return hosts.has(canonical(host));
	};
}
