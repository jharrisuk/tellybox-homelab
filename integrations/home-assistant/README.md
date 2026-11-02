# Tellybox for Home Assistant

This is a small, read-only Home Assistant custom integration for Tellybox. It polls one versioned statistics endpoint every 30 seconds and exposes aggregate stream, download, upload and server health values.

It is not an official Home Assistant integration. It is not listed in HACS. Nothing in this folder has been installed on a real Home Assistant instance by the repository work that added it. Treat it as staged source until you install and test it yourself.

## Scope

Included:

- Active, connected, local and remote stream counts. Local/remote describe the actual media route; sessions with an unknown route are not guessed from viewer location.
- Active download count.
- Measured remote upload rate and the configured upload cap.
- Tellybox service uptime.
- Host CPU and memory percentages from the existing host-health collector.
- Available bytes for each host disk, keyed by a stable sanitised disk ID.
- An optional connectivity binary sensor.

Not included:

- Playback, pause, stop or remote-control switches.
- Account, person, email or device details.
- Viewing titles, history, IP addresses, file paths or provider URLs.
- Any write action, arbitrary proxy or account sign-in.

The integration never reads the normal viewer API. It only reads the separate Home Assistant statistics route.

## Requirements

- Home Assistant Core 2026.9 or newer (the configuration flow uses its current schema library).

- A Tellybox server that provides `GET /api/integrations/home-assistant/stats` with schema version 1.
- A dedicated Home Assistant token created in Tellybox installation settings.
- A recent 2026 Home Assistant release with the `probatio` schema library used by current config flows. Older releases may fail to load the config flow.
- Home Assistant able to reach the Tellybox server address. Use `http://` on a trusted LAN or `https://` when crossing an untrusted network.

The token is read-only, revocable and separate from viewer cookies, app access tokens and the installation administrator password. There is no local-network bypass: a request without the bearer token receives `401`, even from the server itself.

## Install manually

1. In Tellybox, open installation settings at `http://SERVER_IP:8990` and sign in as the installation administrator. Local viewing on port 8082 does not grant this access.
2. Find the **Home Assistant** section and choose **Create token**. Copy the token immediately. It is shown only once. If you lose it, rotate the token and update Home Assistant.
3. Copy the `custom_components/tellybox` folder into your Home Assistant configuration directory:

   ```text
   <home-assistant-config>/custom_components/tellybox/
   ```

   The result should contain files such as `manifest.json`, `__init__.py` and `sensor.py`. Do not copy the parent `integrations` folder into `custom_components`.
4. Restart Home Assistant.
5. Open **Settings > Devices and services > Add integration**, search for **Tellybox**, then enter:
   - **Server address:** for example `http://192.168.1.50:8082`
   - **Home Assistant token:** the token from step 2
6. The integration validates the address and token before creating the config entry. It uses the server's stable installation ID as the Home Assistant unique ID, not the URL or IP address, so changing the address does not create a duplicate entry.

If the token is rotated or revoked, Home Assistant reports a reauthentication prompt. Enter the current token there. If the token belongs to another installation, the flow aborts instead of overwriting the existing entry.

## Entities

Entity IDs depend on the config entry title, which includes the server address. Use the entity IDs shown in Home Assistant.

| Translation key | Typical entity | Meaning |
| --- | --- | --- |
| `active_streams` | `sensor...active_streams` | Playback sessions currently in the playing state. |
| `connected_streams` | `sensor...connected_streams` | Sessions still active within the server's recent 120 second window, including paused sessions. |
| `local_streams` | `sensor...local_streams` | Connected playback sessions whose media route is direct from the home server. |
| `remote_streams` | `sensor...remote_streams` | Connected playback sessions whose media route is through the remote relay path. |
| `active_downloads` | `sensor...active_downloads` | Current downloads. |
| `measured_remote_upload` | `sensor...measured_remote_upload` | Measured remote upload over the server's 10 second window, in Mbit/s. |
| `configured_upload_limit` | `sensor...configured_upload_limit` | Effective configured upload cap in Mbit/s. `0` means unlimited. |
| `uptime` | `sensor...uptime` | Tellybox service uptime. |
| `cpu_usage` | `sensor...cpu_usage` | Host CPU percentage. |
| `memory_usage` | `sensor...memory_usage` | Host memory percentage. |
| Disk sensor | `sensor...available_space` | Free bytes for one disk, created per stable disk ID. |
| `online` | `binary_sensor...online` | Whether the last statistics poll succeeded. |

A value is `unavailable` when the server reports it as missing or stale. The integration does not turn missing CPU, memory, uptime or disk readings into zero. A real zero, such as no active streams, remains `0`.

## Dashboard example

See `dashboard-example.yaml`. Replace the example entity IDs with the ones Home Assistant created for your installation. A minimal card:

```yaml
type: entities
title: Tellybox
entities:
  - entity: binary_sensor.tellybox_server_online
    name: Online
  - entity: sensor.tellybox_server_active_streams
    name: Active streams
  - entity: sensor.tellybox_server_remote_streams
    name: Remote streams
  - entity: sensor.tellybox_server_measured_remote_upload
    name: Remote upload
  - entity: sensor.tellybox_server_configured_upload_limit
    name: Upload cap
```

The binary sensor is `binary_sensor...online`, not `sensor...online`.

## Statistics schema

The server returns an explicit versioned JSON object. Only these aggregate fields are exposed:

```json
{
  "schema": "tellybox.home-assistant.stats",
  "schemaVersion": 1,
  "generatedAt": 1760000000000,
  "installationId": "00000000-0000-0000-0000-000000000000",
  "server": {
    "version": "0.0.0",
    "hostStatus": "ok",
    "sampledAt": 1760000000000,
    "uptimeSeconds": 3600,
    "hostUptimeSeconds": 86400,
    "cpuPercent": 12.5,
    "memoryPercent": 42.1,
    "memoryTotalBytes": 17179869184,
    "memoryAvailableBytes": 9946625843,
    "disks": [
      {
        "id": "0123456789abcdef",
        "name": "Media",
        "availableBytes": 500000000000,
        "totalBytes": 1000000000000,
        "usedBytes": 500000000000
      }
    ]
  },
  "streams": {
    "active": 1,
    "connected": 2,
    "paused": 1,
    "local": 1,
    "remote": 1
  },
  "downloads": { "active": 0 },
  "upload": {
    "configuredMbps": 50,
    "unlimited": false,
    "measuredMbps": 3.25,
    "measurementSeconds": 10
  }
}
```

`hostStatus` is `ok`, `stale` or `missing`. When it is not `ok`, host CPU, memory, uptime and disk byte values are `null`. The integration leaves those sensors unavailable rather than reporting `0`.

`streams.local` and `streams.remote` follow the media route on the server: direct from the home server or through the remote relay path. They are not a guess based on the viewer's network address. If an active entry has no route yet, it counts as connected but not in either route count.

## Troubleshooting

- **`invalid_auth`:** the token was revoked, rotated or copied incorrectly. Create or rotate a token in Tellybox installation settings.
- **`cannot_connect`:** check the address, port, Docker port publishing and Home Assistant network access. Home Assistant must be able to reach the 8082 viewing entry.
- **`invalid_response`:** the server is older than the stats schema, or a proxy returned HTML. Check that the address points at Tellybox directly.
- **CPU, memory or disk sensors unavailable:** the host-health collector has not written a fresh sample. Check the existing server health panel and the collector. Tellybox service uptime can remain available while host readings are missing.
- **Disk sensor disappears:** Home Assistant keeps the entity but marks it unavailable. A disk is matched by the stable ID supplied by the host-health collector. If the collector supplies only a label, that label is the fallback identity, so renaming the disk can create a new entity.

## Security notes

- The token is generated with 256 bits of randomness. Only a SHA-256 hash is stored in the private access directory. The raw token is returned once and is not logged.
- Rotating a token invalidates the previous token immediately. Revoking removes the stored token. Both survive restarts.
- The endpoint accepts only `Authorization: Bearer <token>`. Cookies, app access tokens, Basic authentication, query-string tokens and local source addresses never substitute for the token. Forwarded headers are ignored and grant nothing.
- The endpoint is read-only and allows `GET` only. It sends `Cache-Control: no-store`.
- Use HTTPS if the address crosses an untrusted network. A bearer token is still a secret.

## Development checks

The server test suite covers token generation, hashing, rotation, revocation, restart persistence, local and remote rejection, method handling, missing and stale metrics, and sanitised output. The Python files include pure parser and URL tests under `integrations/home-assistant/tests`.

No real Home Assistant installation is available in this workspace, so the integration has not been loaded by Home Assistant itself. Run it on a non-production Home Assistant instance before relying on it.
