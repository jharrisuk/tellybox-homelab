# Changelog

User-facing changes in Tellybox releases. Server and Android versions are independent.

## Server 0.26.10 - 5 November 2026

Android apps are unchanged at 0.26.13 (build 67).

### Web fullscreen

- The browser player now fills the screen when fullscreen is requested instead of leaving a small picture at the top.
- The video uses the whole viewport with `object-fit: contain`, preserving the picture aspect ratio and centring the letterbox.
- Custom live controls respect device safe areas.
- Samsung Internet and other prefixed fullscreen implementations are supported.
- iPhone and iPad Safari fall back to the native video fullscreen player.
- The shared viewer uses the same fullscreen contract.

## Android 0.26.13 (build 67) and Server 0.26.9 - 5 November 2026

### Optional relay media

- Installation settings now offer exactly three Dispatcharr choices: On this server, On relay, or Another server. On this server and On relay use the configured connection without asking for a manual address. Another server asks for one address.
- On relay lets a separately approved media worker serve live, 24/7, VOD, catch-up and recording playback through the same HTTPS site. Main keeps control, authentication, progress and the shared catalogue. If the worker is unavailable, playback fails closed instead of silently using home media.
- A worker is enrolled with a one-time token and must be approved. Its private control channel is signed, replay-protected and pinned to the approved worker. Forwarded client headers are never trusted as identity.
- Downloads from the Dispatcharr catalogue remain unsupported.
- Existing Jellyfin, shares, casts, local playback and non-Dispatcharr services are unchanged. The new integration is optional and off on a fresh install.

### Media delivery

- Relay playback keeps the position, audio, subtitle and quality choices used by the existing players. Embedded and downloaded subtitles, seek and recording byte ranges use the same session contract.
- Relay accounting is separate from the home upload limit.

## Android 0.26.12 (build 66) - 5 November 2026

Server 0.26.8 is unchanged by this release.

### TV navigation and live TV

- The details synopsis is a quiet reading panel with a subtle border, not a white highlight over the words. Up and Down scroll a long synopsis only until its own edge, then move focus to the chosen season or episode.
- Season focus previews the episode list that Down will enter. Left from a card row stays in the row until its edge, then enters the active sidebar. Repeated Left in the sidebar never wraps into the content.
- Returning from live TV shows the channel that was actually watched, at the current time. A channel changed inside the player is followed. If a favourites or category filter hides that channel, the filter is cleared so it is visible. A deliberate forward browse in the guide is preserved.
- The TV guide keeps the exact focused programme across an in-place refresh. Focus in the sidebar, toolbar or an open channel menu is never pulled into the rebuilt guide.

### Channel zapping

- Channel up, channel down, number entry, previous channel and the mini-guide now apply only to ordinary live channels.
- 24/7 loop channels, films, recordings and catch-up keep their existing playback behaviour but no longer open a channel browse or mini-guide.

### Title actions and watched state

- A subtle watched badge appears on TV and phone cards, Continue cards, episode cards and shared favourites. It is hidden until the item is watched.
- Hold OK on a TV title, episode, Continue card or shared favourite for one action sheet: add to or remove from favourites, mark as watched or unwatched, remove from Continue watching when that action applies, and cancel. Phone Continue cards keep their existing long-press behaviour.
- Marking an episode watched clears its stored resume position and updates its badge, progress text and the series button immediately. A watched Continue card leaves the shelf without adding a false dismissal.

### Series buttons

- The series and season button now says Start watching, Resume, Watch next or Watch again for the episode it will actually play.
- A fully watched series says Watch again instead of Watch next, including on the TV hero after its episode list loads.
- A newer remembered but unstarted episode can no longer hide an earlier watched or partial episode and strand the viewer on Start watching.

### Subtitles

- The CC control is hidden on live TV and other playback with no usable subtitle track or lookup result. It returns when a real text track or on-demand subtitle is available.
- Stray ASS/SSA override commands no longer appear in captions. Recognized override blocks and their hard line breaks are cleaned, while ordinary dialogue braces, paths and unknown backslash text are retained. Cue timing, placement and styling are preserved.

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
