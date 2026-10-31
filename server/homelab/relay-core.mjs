import path from 'node:path';

export function validateRelay(input) {
	const c = { ...input };
	if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(c.hostname || '')) throw Error('Use a public DNS hostname.');
	if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(c.sshHost || '')) throw Error('Use an SSH hostname or IPv4 address.');
	if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(c.sshUser || '')) throw Error('Use a valid SSH user.');
	c.sshPort = Number(c.sshPort || 22); if (!Number.isInteger(c.sshPort) || c.sshPort < 1 || c.sshPort > 65535) throw Error('Invalid SSH port.');
	const ip = String(c.homeTailscaleIp || '').split('.').map(Number);
	if (!/^100\.\d+\.\d+\.\d+$/.test(c.homeTailscaleIp || '') || ip[1] < 64 || ip[1] > 127 || ip.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw Error('Use the home server’s Tailscale IPv4 address.');
	for (const name of ['keyFile', 'knownHostsFile']) if (typeof c[name] !== 'string' || !path.isAbsolute(c[name]) || /[\r\n]/.test(c[name])) throw Error(name + ' must be an absolute local file path.');
	return c;
}
export function caddySite(input) {
	const c = validateRelay(input);
	return `${c.hostname} {
	header {
		-Server
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
	}
	@private path /homelab* /internal/* /homelab-ready
	respond @private 404
	reverse_proxy ${c.homeTailscaleIp}:8083 {
		header_up X-Forwarded-For {http.request.remote.host}
		header_up X-Forwarded-Proto https
		header_up -Forwarded
		flush_interval -1
	}
}
`;
}
export function installScript(input) {
	const c = validateRelay(input);
	return `#!/bin/sh
set -eu
test "$(id -u)" = 0 || { echo "Run through passwordless sudo on the new relay."; exit 1; }
. /etc/os-release
test "$ID" = ubuntu && test "$VERSION_ID" = 24.04 || { echo "This helper currently supports Ubuntu 24.04 only."; exit 1; }
marker=/var/lib/tellybox-homelab-relay
if test -e /etc/caddy/Caddyfile && ! test -e "$marker/managed"; then
	echo "Existing Caddy installation detected. Refusing to replace it. Use the generated site block for a reviewed manual integration."
	exit 1
fi
install -d -m 700 "$marker"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl caddy
if ! command -v tailscale >/dev/null 2>&1; then
	curl --fail --silent --show-error --proto '=https' https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
	curl --fail --silent --show-error --proto '=https' https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
	apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y tailscale
fi
# Mark only after the preflight accepted a fresh server. Preserve the package's initial config.
if ! test -e "$marker/managed"; then
	cp /etc/caddy/Caddyfile "$marker/Caddyfile.before"
	touch "$marker/managed"
fi
systemctl enable --now tailscaled
tailscale up --timeout=10s --hostname=tellybox-homelab-relay --accept-routes=false --advertise-exit-node=false --exit-node= --ssh=false || {
	echo "Approve the Tailscale sign-in URL above, then run the helper again. No relay route has been published."
	exit 2
}
curl --fail --silent --show-error --max-time 8 http://${c.homeTailscaleIp}:8083/health >/dev/null || {
	echo "The home remote-viewing port is unreachable. Bind port 8083 to the home Tailscale address and allow it in your tailnet policy, then retry."
	exit 3
}
cat > "$marker/Caddyfile.next" <<'TELLYBOX_CADDY'
${caddySite(c)}TELLYBOX_CADDY
caddy validate --config "$marker/Caddyfile.next" --adapter caddyfile
cp /etc/caddy/Caddyfile "$marker/Caddyfile.previous"
install -m 644 "$marker/Caddyfile.next" /etc/caddy/Caddyfile
if ! systemctl reload caddy; then
	cp "$marker/Caddyfile.previous" /etc/caddy/Caddyfile
	systemctl reload caddy
	exit 4
fi
echo "Relay configured. Add the relay Tailscale IP below to Tellybox trusted proxies before testing remote viewing:"
tailscale ip -4
echo "Point ${c.hostname} to this relay's public IP. Allow ports 80/443 in the host and cloud firewalls. SSH was not disabled or changed."
`;
}
export function sshArgs(c) {
	return ['-F', 'none', '-p', String(c.sshPort), '-i', c.keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + c.knownHostsFile, '-o', 'ConnectTimeout=10', c.sshUser + '@' + c.sshHost];
}
