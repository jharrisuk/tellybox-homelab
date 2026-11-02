# Changelog

User-facing changes in Tellybox releases. Server and Android versions are independent.

## Server 0.26.6 and Android 0.26.9 (build 63) - 2 November 2026

### Playback

- Seeking and resume work again for local files, VOD, recordings and catch-up, including direct-play files that need the HLS seek fallback. Live TV and 24/7 remain live-only.

### Episodes and intros

- **Always skip intros** is optional, off by default and stored per device or browser. It skips only confirmed Intro markers in episodes, once per playback. Recaps, credits and the manual Skip button are unchanged.
- The next-episode card appears earlier. A cancelable 10-second countdown runs during confirmed credits. Without a reliable Outro marker it starts in the final 15 seconds, subject to the short-episode guard. Autoplay must already be enabled in **Play the next episode**, and **Keep watching** dismisses the card for that episode.

### Home Assistant

- A small read-only Home Assistant custom integration exposes aggregate stream, download, upload and server health values. It uses a separate token created in installation settings and cannot control playback or read titles, accounts or addresses.
- This is not an official Home Assistant integration and is not in HACS. It has not been accepted in a real Home Assistant installation by this project. Install the staged custom component and test it on a non-production instance before relying on it. See [the integration notes](../integrations/home-assistant/README.md).

### Server

- Server 0.26.6 adds the optional Home Assistant statistics endpoint and token management. The endpoint accepts only its own bearer token, not viewer cookies, app tokens, local addresses or forwarded headers.
