import path from 'node:path';

const fail = message => Object.assign(Error(message), { status: 400 });
const port = (value, label) => {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1024 || number > 65535) throw fail(label + ' must be an unused port from 1024 to 65535.');
	return number;
};
const text = (value, label, max = 300) => {
	if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\x00]/.test(value)) throw fail(label + ' is invalid.');
	return value.trim();
};

/** Host-only values. Never commit real endpoints or credentials. */
export function validateWorker(input = {}) {
	const worker = {
		workerId: text(input.workerId || 'relay-worker', 'Worker ID', 80),
		image: text(input.image || 'localhost/tellybox-relay-worker:0.26.9', 'Worker image', 300),
		dataDirectory: text(input.dataDirectory || '/var/lib/tellybox-relay-worker', 'Worker data directory', 300),
		mediaPort: port(input.mediaPort || 18086, 'Media port'),
		controlPort: port(input.controlPort || 18087, 'Control port'),
		tailscaleIp: text(input.tailscaleIp || '', 'Relay Tailscale address', 64),
		upstreamUrl: text(input.upstreamUrl || 'http://host.containers.internal:9191', 'Worker Dispatcharr address', 500),
		mainHeartbeatUrl: text(input.mainHeartbeatUrl || '', 'Main heartbeat address', 500),
		mainControlKeyFile: text(input.mainControlKeyFile || '', 'Main control key file', 500)
	};
	if (!/^100\.\d+\.\d+\.\d+$/.test(worker.tailscaleIp)) throw fail('Use the relay Tailscale IPv4 address.');
	if (!/^[A-Za-z0-9._/:@-]+$/.test(worker.image)) throw fail('Use a simple image reference.');
	if (!/^\/[A-Za-z0-9._/-]+$/.test(worker.dataDirectory)) throw fail('Use an absolute worker data directory without shell characters.');
	if (worker.mediaPort === worker.controlPort) throw fail('Media and control ports must differ.');
	for (const [value, label] of [[worker.upstreamUrl, 'Worker Dispatcharr address'], [worker.mainHeartbeatUrl, 'Main heartbeat address']]) {
		let url; try { url = new URL(value); } catch { throw fail(label + ' is invalid.'); }
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail(label + ' must be an HTTP(S) origin without credentials.');
		if (!/^https?:\/\/[A-Za-z0-9.:[\]_/-]+$/.test(value)) throw fail(label + ' contains unsupported characters.');
	}
	if (!worker.mainControlKeyFile || !path.isAbsolute(worker.mainControlKeyFile)) throw fail('Use an absolute pinned main-key file path.');
	return worker;
}

export function relayMediaCaddyBlock({ mediaPort = 18086, localOrigin = '', localOrigins = [] } = {}) {
	port(mediaPort, 'Media port');
	const origins = [];
	for (const value of [localOrigin, ...localOrigins].filter(Boolean)) {
		let url; try { url = new URL(value); } catch { throw fail('Local origin is invalid.'); }
		if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw fail('Local origin must be an HTTP(S) origin.');
		if (!origins.includes(url.origin)) origins.push(url.origin);
	}
	const cors = origins.map((origin, index) => `\t\t@relayCors${index + 1} header Origin ${origin}\n\t\theader @relayCors${index + 1} Access-Control-Allow-Origin "${origin}"\n\t\theader @relayCors${index + 1} Vary Origin\n`).join('');
	return `\t# Tellybox relay media worker. Scoped block; other sites stay unchanged.
\thandle /internal/* {
\t\trespond 404
\t}
\thandle /relay-media/* {
${cors}\t\treverse_proxy 127.0.0.1:${port(mediaPort, 'Media port')} {
\t\t\theader_up -Cookie
\t\t\theader_up -Authorization
\t\t\theader_up -X-JServer-App
\t\t\theader_up -X-Tellybox-Device-Id
\t\t\theader_up -X-Forwarded-For
\t\t\theader_up -X-Real-IP
\t\t\theader_up -Forwarded
\t\t\theader_up -X-Forwarded-Proto
\t\t\theader_up -X-Forwarded-Host
\t\t}
\t}
`;
}

export function relayMediaCaddySite(input, worker = {}) {
	const c = input;
	const block = relayMediaCaddyBlock(worker);
	return `${c.hostname} {
\theader {
\t\t-Server
\t\tStrict-Transport-Security "max-age=31536000"
\t\tX-Content-Type-Options nosniff
\t}
\t@private path /homelab* /internal/* /homelab-ready
\trespond @private 404
${block}\treverse_proxy ${c.homeTailscaleIp}:8083 {
\t\theader_up X-Forwarded-For {http.request.remote.host}
\t\theader_up X-Forwarded-Proto https
\t\theader_up -Forwarded
\t\tflush_interval -1
\t}
}
`;
}

/** Insert only the media handler into an existing Caddyfile, with backup and rollback. */
export function scopedCaddyScript({ mediaPort = 18086, block = relayMediaCaddyBlock({ mediaPort }), upstream = '', caddyFile = '/etc/caddy/Caddyfile', site = '' } = {}) {
	const marker = 'Tellybox relay media worker';
	const escaped = block.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
	return `#!/bin/sh
set -eu
test "$(id -u)" = 0 || { echo "Run through passwordless sudo."; exit 1; }
target="\${1:-${caddyFile}}"
site="\${2:-${site}}"
test -f "$target" || { echo "No existing Caddyfile fragment at $target."; exit 1; }
grep -q '${marker}' "$target" && { echo "Relay media block is already present. Nothing changed."; exit 0; }
backup=/var/lib/tellybox-relay-worker/Caddyfile.$(date +%Y%m%d%H%M%S)
install -d -m 700 "$(dirname "$backup")"
cp "$target" "$backup"
next=$(mktemp)
awk -v block="$(cat <<'TELLYBOX_MEDIA_BLOCK'
${escaped}TELLYBOX_MEDIA_BLOCK
)" -v site="$site" 'BEGIN { inserted=0; in_site=0 }
/^[^[:space:]#].*\\{[[:space:]]*$/ { in_site=(site=="" || index($0,site)>0) }
in_site && /^[[:space:]]*handle[[:space:]]*\\{/ && inserted==0 { printf "%s\\n", block; inserted=1 }
{ print }
END { if (inserted==0) exit 9 }
' "$target" > "$next" || { echo "Could not find the target site's handle block. No change."; rm -f "$next"; exit 9; }
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || { echo "Caddy validation failed. No change."; rm -f "$next"; exit 10; }
install -m 644 "$next" "$target"
rm -f "$next"
if ! systemctl reload caddy; then
  cp "$backup" "$target"
  systemctl reload caddy || true
  echo "Caddy reload failed. Previous Caddyfile fragment restored."
  exit 11
fi
echo "Relay media prefix added to $target. Backup: $backup"
`;
}

/** Read-only, idempotent tailnet preflight. It opens nothing and changes no ACL. */
export function workerPreflightScript({ homeTailscaleIp, mediaPort = 18086, controlPort = 18087 } = {}) {
	if (!/^100\.\d+\.\d+\.\d+$/.test(String(homeTailscaleIp || ''))) throw fail('Use the home Tailscale IPv4 address.');
	port(mediaPort, 'Media port'); port(controlPort, 'Control port');
	return `set -eu
. /etc/os-release
printf 'TELLYBOX_OS=%s %s\\n' "$ID" "$VERSION_ID"
printf 'TELLYBOX_IP=%s\\n' "$(tailscale ip -4 | head -1)"
printf 'TELLYBOX_TS_VERSION=%s\\n' "$(tailscale version | head -1)"
printf 'TELLYBOX_PODMAN=%s\\n' "$(command -v podman || true)"
if tailscale ping --c 1 --timeout 3s ${homeTailscaleIp} >/dev/null 2>&1; then printf 'TELLYBOX_PING_OK=1\\n'; else printf 'TELLYBOX_PING_OK=0\\n'; fi
printf 'TELLYBOX_SERVE_BEGIN\\n'
tailscale serve status 2>&1 || true
printf 'TELLYBOX_SERVE_END\\n'
`;
}
/** Parse only flags and safe addresses. Raw serve output is never persisted. */
export function parseWorkerPreflight(output, { mediaPort = 18086, controlPort = 18087 } = {}) {
	const line = name => new RegExp('^' + name + '=(.*)$', 'm').exec(String(output || ''))?.[1]?.trim() || '';
	const serve = /TELLYBOX_SERVE_BEGIN\n([\s\S]*?)\nTELLYBOX_SERVE_END/.exec(String(output || ''))?.[1] || '';
	const media = port(mediaPort, 'Media port'), control = port(controlPort, 'Control port');
	const hasPort = value => new RegExp('(?:^|[^0-9])' + value + '(?:[^0-9]|$)', 'm').test(serve);
	const ip = line('TELLYBOX_IP');
	const version = line('TELLYBOX_TS_VERSION');
	const podman = Boolean(line('TELLYBOX_PODMAN'));
	const pingOk = line('TELLYBOX_PING_OK') === '1';
	const os = line('TELLYBOX_OS');
	const controlOpen = hasPort(control), mediaOpen = hasPort(media);
	const checks = {
		ubuntu2404: /^ubuntu 24\.04$/.test(os),
		tailscaleIp: /^100\.\d+\.\d+\.\d+$/.test(ip),
		tailscaleVersion: Boolean(version),
		podman: podman,
		mainReachable: pingOk,
		controlPortFree: !controlOpen,
		mediaPortFree: !mediaOpen
	};
	return { ready: Object.values(checks).every(Boolean), checks, ip, version, podman, pingOk, os,
		conflicts: [...(controlOpen ? ['control port ' + control + ' already has a tailscale serve mapping'] : []), ...(mediaOpen ? ['media port ' + media + ' already has a tailscale serve mapping'] : [])] };
}
/** Activate only the private control mapping after the owner enables the worker. */
export function workerActivationScript({ controlPort = 18087 } = {}) {
	port(controlPort, 'Control port');
	return `#!/bin/sh
set -eu
status=$(tailscale serve status 2>/dev/null || true)
if printf '%s\\n' "$status" | grep -Eq '(^|[^0-9])${controlPort}([^0-9]|$)'; then
	echo "A Tailscale serve mapping for ${controlPort} already exists. Nothing changed."
	exit 0
fi
install -d -m 700 /var/lib/tellybox-relay-worker
tailscale serve status --json > /var/lib/tellybox-relay-worker/serve-before.json
chmod 600 /var/lib/tellybox-relay-worker/serve-before.json
tailscale serve --yes --bg --tcp ${controlPort} tcp://127.0.0.1:${controlPort}
echo "Private worker control mapping ${controlPort} added. Existing serve mappings were preserved."
`;
}
/** Main-side private control endpoint for worker heartbeat/enrolment. */
export function mainWorkerControlScript({ mainPort = 8083 } = {}) {
	port(mainPort, 'Main remote port');
	return `#!/bin/sh
set -eu
status=$(tailscale serve status 2>/dev/null || true)
if printf '%s\\n' "$status" | grep -Eq '(^|[^0-9])${mainPort}([^0-9]|$)'; then
	echo "A Tailscale serve mapping for ${mainPort} already exists. Nothing changed."
	exit 0
fi
install -d -m 700 /var/lib/tellybox-relay-worker
tailscale serve status --json > /var/lib/tellybox-relay-worker/serve-before-main.json
chmod 600 /var/lib/tellybox-relay-worker/serve-before-main.json
tailscale serve --yes --bg --tcp ${mainPort} tcp://127.0.0.1:${mainPort}
echo "Private main control mapping ${mainPort} added for the approved relay worker. No public route was added."
`;
}

export function workerDeployment({ worker, mainMediaPublicKeyFile, mainControlPublicKey = '', mainMediaPublicKey = '', workerVersion = '0.26.9' } = {}) {
	const w = validateWorker({ ...worker, mainControlKeyFile: worker?.mainControlKeyFile || '/data/main-control-public.pem' });
	const writePem = (name, pem) => pem ? `cat > ${w.dataDirectory}/${name} <<'TELLYBOX_PUBLIC_KEY'\n${pem}TELLYBOX_PUBLIC_KEY\nchmod 600 ${w.dataDirectory}/${name}\n` : '';
	const keySetup = writePem('main-media-public.pem', mainMediaPublicKey) + writePem('main-control-public.pem', mainControlPublicKey)
		|| `install -m 600 ${mainMediaPublicKeyFile || '/dev/null'} ${w.dataDirectory}/main-media-public.pem\ninstall -m 600 ${w.mainControlKeyFile} ${w.dataDirectory}/main-control-public.pem\n`;
	const unit = `[Unit]
Description=Tellybox relay media worker
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Restart=on-failure
RestartSec=5s
ExecStartPre=-/usr/bin/podman rm -f tellybox-relay-worker
ExecStart=/usr/bin/podman run --rm --name tellybox-relay-worker \\
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \\
  --pids-limit=256 --memory=8g --cpus=3 \\
  --network=slirp4netns:allow_host_loopback=true --add-host=host.containers.internal:10.0.2.2 \\
  -p 127.0.0.1:${w.mediaPort}:${w.mediaPort} \\
  -p 127.0.0.1:${w.controlPort}:${w.controlPort} \\
  -v ${w.dataDirectory}:/data:Z \\
  --tmpfs /tmp:rw,size=512m,mode=1777 \\
  -e RELAY_WORKER_ID=${w.workerId} \\
  -e RELAY_WORKER_VERSION=${workerVersion} \\
  -e RELAY_DATA_DIR=/data \\
  -e RELAY_MEDIA_PORT=${w.mediaPort} -e RELAY_MEDIA_BIND=0.0.0.0 \\
  -e RELAY_CONTROL_PORT=${w.controlPort} -e RELAY_CONTROL_BIND=0.0.0.0 \\
  -e RELAY_MAIN_CONTROL_KEY_FILE=/data/main-control-public.pem \\
  -e RELAY_MAIN_MEDIA_KEY_FILE=/data/main-media-public.pem \\
  -e RELAY_MAIN_HEARTBEAT_URL=${w.mainHeartbeatUrl} \\
  -e DISPATCHARR_URL=${w.upstreamUrl} \\
  -e DISPATCHARR_KEY_FILE=/data/dispatcharr-key \\
  -e MAX_RELAY_SESSIONS=3 -e MAX_FFMPEG_JOBS=3 \\
  ${w.image}
ExecStop=/usr/bin/podman stop -t 10 tellybox-relay-worker

[Install]
WantedBy=multi-user.target
`;
	const serve = workerActivationScript({ controlPort: w.controlPort });
	const setup = `#!/bin/sh
set -eu
# Isolated worker setup. Existing standalone services are not changed.
install -d -m 700 -o root -g root ${w.dataDirectory}
${keySetup}test -s ${w.dataDirectory}/dispatcharr-key || { echo "Write the worker Dispatcharr key to ${w.dataDirectory}/dispatcharr-key (mode 0600) before starting."; exit 1; }
chmod 600 ${w.dataDirectory}/dispatcharr-key
chown -R 1000:1000 ${w.dataDirectory}
install -m 644 /dev/stdin /etc/systemd/system/tellybox-relay-worker.service <<'TELLYBOX_SERVICE'
${unit}TELLYBOX_SERVICE
systemctl daemon-reload
systemctl enable --now tellybox-relay-worker
${serve}
`;
	return { unit, serve, setup };
}
