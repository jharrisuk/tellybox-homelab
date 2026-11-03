# Changelog

User-facing changes in Tellybox releases. Server and Android versions are independent.

## Server 0.26.8 and Android 0.26.11 (build 65) - 3 November 2026

### Continue watching

- Home **Continue watching** now shows on-demand films, episodes, local video and recordings only. Live channels, 24/7 and catch-up or restart programmes no longer appear there, even when older metadata points at a local or streamed copy.
- On TV, hold OK on a Continue watching card and choose **Remove from Continue watching**. On a phone, use the card's overflow action or long press. Removal hides that title from this installation and linked profile only. Resume position, watch history and favourites stay intact.
- A removed title returns only after playback starts successfully again. A progress heartbeat does not bring it back. An **Undo remove from Continue watching** action is available after removal.
- Directly opening a catch-up programme still resumes at its saved position, and its history entry is kept.

### Title details

- Film and series details on TV now show the complete synopsis in a readable, scrollable section instead of cutting it to two lines. Real genre metadata appears as chips alongside the existing year, rating and runtime.
- A **Watch trailer** action appears only when existing Jellyfin or TMDB metadata supplies a validated YouTube trailer. It opens the trailer externally and never autoplays. If no trailer or no YouTube/browser app is available, the action is omitted or explained with a short message.
- Phone details gain the same real genre chips and trailer action. Browser details gain genre chips, a clearer synopsis style and the same validated trailer link.
- Cached streamed-title metadata is refreshed once after this update, so trailer, genre and description data appear immediately instead of waiting for the old seven-day cache to expire. A title with no valid trailer still shows no trailer action.

## Server 0.26.7 and Android 0.26.10 (build 64) - 2 November 2026

### Playback defaults

- Administrators can set server-wide defaults for **English subtitles**, **Play the next episode** and **Always skip intros** in the local **Settings → Server** panel.
- A saved on or off choice on a phone, TV or browser overrides the server default. A device or browser with no explicit choice follows the server, and **Use server defaults** in **Watching settings** clears an override so it follows the server again.
- Fresh installations start with all three defaults off. Existing installations keep their current behaviour until an administrator enables a default.

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
