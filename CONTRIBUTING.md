# Contributing

Bug reports, documentation improvements and non-commercial server contributions are welcome. Include the server version shown in Settings, the client/browser version, steps to reproduce and a redacted error message. Never attach credentials, setup codes, private configuration backups or viewing histories.

By submitting a contribution for inclusion, you confirm you have the right to submit it under this repository's PolyForm Noncommercial License 1.0.0 and any applicable existing third-party terms. This is not a copyright assignment or permission to relicense your contribution under unrelated terms. Identify any copied code and its original licence; do not add incompatible dependencies.

Use tabs for code indentation. Keep integrations optional and off by default. Test with an isolated configuration and synthetic media data. Run `cd server && npm ci && npm test` with Node 24 and FFmpeg installed. Do not test migrations against your only copy of live settings.

The official mobile/TV apps are maintained privately. Public changes must not include app source, signing material or publisher-service credentials. Report app bugs here with the app version, but use the official signed downloads rather than untrusted replacement packages.
