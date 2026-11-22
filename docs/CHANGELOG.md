# Changelog

User-facing changes in Tellybox releases. Server and Android versions are independent.

## Android 0.26.38 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Phone

- Home has a Sport on TV rail with the next fixtures, the channels in your
  lineup that show them, and tap-for-details including fighters and notes.

## Server 0.26.74 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Coming soon

- Each channel in a fixture's details is now a link: choose one to open Live TV
  tuned to that channel.
- An available film or series says "Available now · in your collection" and
  offers Watch now. A released title that is not in the collection says so
  plainly instead of implying it can be played.

## Server 0.26.73 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Settings

- Settings > Server > Sport on TV lists every sport the listing source provides,
  with a checkbox for each, the football scope and an on/off switch. The current
  next-three-days count appears beside each sport. Only a local administrator
  can save; viewers see the resulting board read-only.

## Server 0.26.72 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Coming soon

- The calendar day marker now shows an icon and count for each sport on that
  day (up to three, then a +N), instead of one dot and a total. A day with
  football, cricket and boxing shows all three at a glance.

## Server 0.26.71 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Coming soon

- Each fixture card shows a pictogram for its sport next to the name, such as a
  ball, boxing glove, race helmet or skier, so a mixed sport list scans faster.

## Android 0.26.41 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Sport

- Sport cards on the TV can be reached with the remote and open a details
  dialog with the competition, time, your channels and the fighters or notes.
- The UK football filter recognises sponsored and round-suffixed competition
  names such as Premier Sports Cup Final, FA Cup Second Round and Sky Bet
  Championship, so valid fixtures are not hidden.

## Android 0.26.40 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Sport

- The TV sport board and the phone Sport on TV rail now have a day strip: All,
  Today, Tomorrow and the following days, each showing the busiest sports with
  their counts. Tapping a day filters the fixtures; tapping All restores them.

## Android 0.26.39 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Sport

- The TV sport board and the phone Sport on TV rail show the same sport
  pictograms as the web page.

## Server 0.26.70 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Coming soon

- The fixture panel is labelled Sport on TV, not Football on TV, now that it
  carries MotoGP, skiing and every other televised sport alongside football.
- A day with nothing scheduled no longer draws an empty square in the
  recently released and next seven days calendar; the weekday columns keep
  their alignment.
- The calendar's fixture marker uses a neutral dot and counts every sport,
  rather than implying a football match.

## Android 0.26.37 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### TV

- Coming Soon has a Football on TV board below the calendar, showing only
  channels in your lineup. The UK-only filter matches the web panel, including
  sponsored competition names, and turning it off shows every competition.
- Opening the guide from the menu starts at the top of the guide rather than
  the last channel. Coming back from playback still returns to the channel you
  were watching, including a channel changed inside the player.
- The guide header and unused 24/7 and Record actions are gone, giving the
  listings more room.

### Playback

- The player keeps a larger buffer and ignores a brief backward timestamp jump
  when the new stream still covers the viewer's place, matching the server fix.

### Library

- An episode offers All episodes, which opens its series, and failed episode
  artwork falls back to the series poster instead of an empty card.
- The TV logo has a transparent background.

## Server 0.26.69 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Coming soon

- The sport board now covers boxing, MMA/UFC, rugby, cricket and the other
  sports carried by livesportontv.co.uk, merged and de-duplicated with the
  existing football fixtures. Each card still names only channels in your
  lineup, and combat-sport cards show the fighters in their details.
- The UK-only filter now applies to football only; turning it on no longer hides
  boxing or other sports.
- A local administrator can switch the board off, choose which sports appear,
  and scope football to UK competitions or all football. Viewers can read the
  settings but cannot change them.
- Each fixture's details name its source, and the sport label matches the
  fixture instead of always saying football.

## Server 0.26.68 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Playback

- Live and 24/7 playback keeps a 30-second back buffer and a narrow live-sync
  speed range, so a brief source reconnect is ridden out rather than jumping the
  timeline. A backward timestamp jump still keeps the viewer's place when the
  new stream covers it, otherwise it returns to the live edge.
- The Android apps get the same discontinuity guard and a larger player buffer
  in the next app release.

## Server 0.26.67 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Coming soon

- The Football on TV panel now sits below the recently released and next seven
  days calendar, matching the page order the owner requested.

## Server 0.26.66 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Coming soon

- Football fixtures are a first-class panel above the calendar, showing only
  channels in your lineup and a UK-only filter (remembered in the browser).
- Fixture days carry a small marker in the calendar so sport is visible without
  hunting for a tab.
- The collapsed "Browse all upcoming" control is replaced by a compact, always
  visible browse section with an Episodes | Films switch.
- The layout uses auto-fill and auto-fit columns, so wide screens do not leave
  fixed empty columns.

## Server 0.26.65 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Home and Activity

- A browser recognised as being at home through the public address now shows the
  home connection icon before playback, and the read-only Activity view is
  available there, matching the local entry. Remote viewers still need an
  administrator. The torrent queue and media deletion remain administrator-only.

### Playback

- A live or 24/7 source that reconnects and restarts its timestamps earlier no
  longer drags playback backwards. The player keeps the viewer's place when the
  new stream still covers it, otherwise it returns to the live edge.

### Media deletion

- A local administrator can permanently delete a local film, episode, season or
  series from Jellyfin, including its files, from **Settings -> Delete media**.
  The screen searches the local library, previews the exact file count and size,
  requires the title to be typed, refuses streamed titles and anything currently
  playing, and records the deletion in Activity. A Jellyfin administrator API
  key is required. There is no recycle bin.

## Server 0.26.64 - 22 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Coming soon

- The window is seven days back and seven days forward.
- The calendar is one Monday-first grid, so a Monday always sits above a Monday;
  past days keep their column and render quietly when nothing landed.

### Sport on TV

- A Sport section lists the next three days of UK televised football from
  live-footballontv.com, cached for six hours. Only channels in the lineup are
  named, and a UK-only filter is on by default. It is a fixture board, not a
  launcher.

### Household devices

- Link a phone or TV with a short code from a signed-in account. Phone and TV
  allowances are separate (default one each; 0 means unlimited), and a device can
  be removed to free a slot. Manual approval and linking remain available.
- Hardening: re-linking a device as another platform cannot bypass the new
  allowance, unknown device polls cannot exhaust the linking throttle, and the
  status route requires the same local-or-HTTPS transport as start.

### Catch-up

- A rolling eight-day guide archive keeps catch-up history independent of
  Dispatcharr's own retention window.

### Copy and layout

- 25 measured copy fixes, orphan control (text-wrap), named Refresh buttons and
  distinct guide links.

## Server 0.26.63 - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Maintenance

- Turning maintenance on no longer risks taking the server down when stopping a
  session fails - for example when a relay worker is already unreachable, which
  is exactly the situation maintenance is for. The failed stop is ignored and the
  viewer is still refused by the maintenance gate.

### Coming soon

- Only the episode a card actually represents keeps its library link. Earlier
  episodes in the same card no longer open the chosen one.
- `?title=` deep links now match numeric ids, so a shared link opens the right
  title instead of silently doing nothing.
## Server 0.26.62 - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Coming soon

- A TV card now links to the library only when that exact episode is present.
  If it is not, the card opens the details panel instead of starting episode one
  of the series, which was a different episode from the one on the card.
## Server 0.26.61 - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Coming soon

- Clicking a TV title now opens the episode shown on the card. Previously the
  card carried only the series, so a recent S28E12 opened the show at episode 1.
- The exact episode is resolved through the existing episode lookup and linked
  by its own id. If it cannot be resolved, the link falls back to the series, so
  it is never worse than before.
- No extra provider requests; the lookup shares the existing episode cache.
## Server 0.26.60 - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Coming soon

- The calendar now covers the last 14 days as well as the 90 ahead, so recent
  releases no longer disappear the day after they land.
- Recently released titles are labelled as released instead of looking like a
  scheduling mistake.
- A title that is already in your library now opens there when clicked. Titles
  you do not have keep the existing details panel.
- Ownership is matched by TMDB id against the catalogue already in memory; no
  extra provider request is made, and a catalogue lookup failure simply leaves
  the titles without library links.
## Server 0.26.59 - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Refresh notifications

- A separate, revocable credential lets the nightly refresh report its result to
  the server, which delivers it through the admin push that already reaches the
  phone apps.
- The ingest endpoint is POST-only, body-capped, field-checked, rate-limited and
  never accepts the Home Assistant token or an app/session credential.
- The admin surface mirrors the Home Assistant token flow: create, rotate,
  revoke.

## Server 0.26.58 - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Home Assistant compatibility

- The statistics schema stays at version 1. The new fields are additive, and an
  older integration rejects any version it does not know; bumping it took a
  working dashboard offline.
- Only raise the schema version when clients can negotiate, and keep the
  previous version accepted for at least one release.
## Server 0.26.57 - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

### Home Assistant

- Seven more sensors: viewers now, paused streams, plays, failed plays, host
  uptime, memory total and memory available.
- A maintenance binary sensor, on while maintenance mode is active.
- The statistics payload is now version 2. Older v1 payloads still parse, and a
  field the server does not send reads as unavailable rather than zero.
- All additions are aggregate counters; no titles, account identities, addresses
  or provider URLs are exposed.

## Server 0.26.56 - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Web only.

### Accounts

- The Email accounts list now shows watch time per account on the row itself:
  total watched, and today's time against any daily limit.
- A Sort control offers Status, Most watched, Recently seen and Name, so a
  household with several accounts can find the heavy viewer or the quiet one
  without opening Activity.
- Rows keep their existing height; the usage is one line, not another panel.

## Server 0.26.55 - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Web only.

### Episodes

- Episodes with no still of their own now show the series poster instead of a
  blank square. This applies to the episode list inside a series on both the
  phone and the TV app.
- An episode that does have its own still keeps it. A series with no image at
  all still shows nothing rather than an invented image.
- The recently released TV rail keeps its existing parent-artwork behaviour.
- Recently released TV now lists your own library shows before streamed ones, then newest first. This is the rail the TV app's Home screen uses.

## Server 0.26.54 - 20 November 2026
**Not a public source release.** This entry documents the reviewed private home
installation.

Web only.

### Live TV

- The timetable now fits the screen: about three hours on a phone, six on a
  tablet and the previous span on desktop, instead of a fixed 950px grid you
  had to drag sideways. The channel column stays put while the hours scroll.
- "Swipe across to look ahead" only appears when there is actually more to see.

### Coming soon

- The seven-day calendar stays the primary view. The duplicate full grid now
  sits behind "Browse all upcoming" instead of filling the page.

### Maintenance

- A viewer who is still allowed during maintenance (for example local access
  while only remote is blocked) now sees a banner saying maintenance is on.
- Turning maintenance on now ends only the sessions the chosen scope covers:
  a remote-only activation no longer interrupts local playback.

## Android 0.26.36 (build 90) - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Apps only.

### Notifications

- The gateway push device key and any pending removal tokens are now encrypted
  with the device Keystore, matching how the sign-in token is already stored.
  Existing values are migrated once, in place.
- If that key can no longer be decrypted, the app treats the device as no longer
  registered, clears the unusable secret and allows re-registration, rather than
  failing silently.

## Android 0.26.35 (build 89) - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Apps only.

### Downloads

- The download index is no longer read on the main thread. Resuming the app,
  the acknowledgement checks, the three-second downloads refresh and the
  "remove watched downloads" action now read it on one background thread and
  post the result back.
- The boot receiver does the same, using a background broadcast slot and always
  finishing, so a large download list no longer risks a startup ANR on slower TV
  hardware.
- What is acknowledged, deleted or resumed is unchanged; the exact-once
  ownership rules and the visible wording are untouched.

## Android 0.26.34 (build 88) - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Apps only.

### Updates

- The update check now understands signing-key rotation. An app signed with a
  newer key in the same lineage is accepted, and an unrelated key is still
  refused before the installer opens. Previously a future rotation would have
  refused every update.

### Sign-in

- If this device's stored sign-in can no longer be decrypted (for example after
  an OEM lockscreen reset or a restore onto new hardware), the app now says
  "Sign-in expired on this device. Connect again to restore access." instead of
  silently enrolling as a brand-new device.

### Viewing history

- Resume points and history are now kept apart by a SHA-256 account fingerprint
  rather than a 32-bit hash that two different accounts could collide on.
  Existing progress is adopted once, and ambiguous legacy data is left alone
  rather than guessed at.

## Android 0.26.33 (build 87) - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Apps only.

### TV player

- A viewing-allowance notice now appears in the player and can be dismissed,
  instead of the limit only showing up as an error later.
- When playback struggles, the trouble panel offers a direct "Lower quality"
  action rather than making you leave and start again.
- A timeout or policy stop now explains itself in a dialog and waits for you to
  close it. Previously the still-watching monitor finished the player underneath
  the dialog, which is why this batch was held back until the cause was found.
- Larger status text and a clearer end-of-episode "Next episode" block at
  ten-foot size; guide tabs are sized so their labels are not clipped.

### Fix

- Abandoning the still-watching monitor now marks it ended, so its own shutdown
  no longer closes the player while a dialog is open.

## Android 0.26.32 (build 86) - 21 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Apps only.

### Maintenance screen

- The TV app now takes over the whole screen during planned maintenance instead
  of dropping a small box into the page: animated Tellybox wordmark, a friendly
  "Back in a tick", and one line explaining that it will recover by itself.
- It retries automatically every 30 seconds, so a TV left on recovers without
  anyone touching the remote. "Try now" is there if you are impatient.
- The phone app uses the same wording instead of the formal maintenance line.

## Android 0.26.31 (build 85) - 20 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Apps only.

### Fixes

- Casting no longer stops working after the first playback session. The Cast
  SDK was being given the player's own executor, which is shut down when that
  player closes; it now uses the process-wide main executor.
- A backgrounded player stops reporting progress and running its episode timer
  instead of posting every ten seconds indefinitely. It resumes reporting when
  brought back to the foreground.
- Rotating the phone no longer cancels an in-progress app update or TV
  installation download.
- The boot receiver for resuming downloads is no longer exported to other apps.
- A response larger than 16 MB is refused instead of being read into memory
  without limit.
- The configured server origin and capability flags are now published safely
  across threads.

## Android 0.26.30 (build 84) - 20 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Apps only.

### Maintenance

- When the server is deliberately taken offline for maintenance, the apps now
  say so plainly: "Tellybox is down for maintenance" with the server's message
  and a Try again action. Previously this appeared as a generic connection
  failure, which made a planned outage look like a fault.
- The phone and TV error screens keep the normal connection guidance for any
  other failure.

## Server 0.26.53 - 20 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Server and web.

### Maintenance mode

- Tellybox can now be taken offline deliberately, for everyone, for remote
  viewers only, or for the home network only.
- Enabling it disconnects anyone currently watching; it does not merely refuse
  new starts.
- While it is on, the site shows a branded maintenance page and API calls return
  a clear maintenance response with a retry interval, instead of a generic
  failure. Apps will show the same screen in their next build.
- Administrators are never locked out: the local settings page, an approved
  admin app and the owner session can always get in and switch it off.
- A command-line switch can change the state even when the server itself is
  unhealthy.

## Server 0.26.52 - 20 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Web only.

### Fixes

- A brand-new installation no longer shows an empty Home with no explanation.
  The setup message and an installation-settings link now appear on the page
  itself instead of inside a hidden section.
- A failed playback start offers **Try again** as well as compatibility mode,
  instead of forcing the compatibility path for a transient error.
- A failed collection or Discover load offers a real retry. It no longer
  reuses "Show more" as a retry button or leaves a stale count behind.
- Recordings filtered to **Ready to watch** now exclude items whose file is
  unavailable. The empty message matches the active filter or search.
- Activity tabs wrap on small phones instead of clipping the last tab.
- Filter and segment chips meet a 40px touch target on phones, and the Home
  "More info" control is a full-size target with readable text.
- The Activity link labelled "Password settings" is now "Activity settings",
  which is where it actually goes.
- The Settings overview's Watching card switches to the in-page Watching panel
  instead of leaving for a duplicate page.
- If the server playback defaults cannot be loaded, the preferences panel says
  so rather than claiming a server default it does not know.

## Server 0.26.51 - 20 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Server and web only.

### Home

- The first load of a session now shows a single branded loading state — the
  Tellybox mark pulsing — instead of per-row skeletons. It lasts only until the
  first Home payload is ready, and it is replaced by an honest message and a
  retry if the load fails. It never pulses forever.
- A new tab or a reopened browser paints Home immediately from a 15-minute
  per-account snapshot, then reconciles in the background. The snapshot is
  cleared on sign-out and is scoped to the signed-in account, so one person's
  Continue rail cannot appear for another on a shared browser.
- Home is materially faster. The feed memo was almost never written: its gate
  counted unproven candidates from before the final filter, so every warm
  request re-ran the whole pipeline. It now counts what the served feed
  actually contains, which is zero by construction, so repeat requests reuse
  the verified feed.
- The first Home load after a restart no longer wastes a rebuild while the saved
  catalogue is still being restored: the memo key is computed only after that
  one-time restore completes.
- Local artwork no longer waits on a provider logo lookup before returning the
  same-origin image route.

### Downloads

- The Everything filter no longer repeats the torrent total that the badge
  already shows.
- Unknown speeds are omitted rather than rendered as "Not reported".

## Server 0.26.50 - 20 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Server and web only.

### Activity

- Activity is now for administrators only. Being on the home network is no
  longer enough: the page and its live-stream, download and qBittorrent summary
  data require an admin app, the local settings page, or an account linked to an
  approved admin app. The Activity entry is hidden from everyone else.
- The Activity page no longer flashes unstyled on a remote connection. The
  server used to point the stylesheet at a content-hashed CDN URL before
  checking that the file existed there; when it did not, the page waited for a
  failed request and a fallback. Styles and branding now stay on the server
  until the CDN copy has been confirmed.

### Downloads

- Each download is one compact row instead of a tall card: title, state, a
  progress bar with the percentage, and size, speeds, ETA and ratio on one
  line. Eight downloads now fit where two did.
- The long "Read-only monitoring" explanation is gone. The counts line no
  longer repeats the filter count already shown in the badge.
- Stalled and failed rows are marked, and unknown values are omitted instead of
  repeating "Not reported".

### Streams

- The upstream-stream card is now a compact summary: one line for source,
  profile, app and viewer, one line for the picked stream, a row of media chips
  (resolution, frame rate, codec, audio, container, average bitrate), and a
  metrics line for data, duration and connections.
- A single badge replaces the duplicated "Live" and "active" pills.
- The connection table no longer repeats App, Source, Profile or Format when
  every row matches the card above it.

### Recordings

- Recordings show their channel artwork again. Dispatcharr refused the logo
  URL for the new Horse & Country channel, so the cached image 404'd; the logo
  is now stored by Dispatcharr itself.
- Deleting a recording works again for an administrator away from home. The
  delete route used to accept only the home network or an admin app, so a
  signed-in owner elsewhere saw no delete control.

## Server 0.26.49 - 20 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Server-only.

### Artwork

- Remote channel and VOD artwork no longer disappears after a catalogue import.
  A private artwork link that is still valid and still points at a channel that
  exists now serves that channel's current logo instead of returning 404 when
  the underlying logo id has changed. Local artwork was unaffected.

## Server 0.26.48 - 20 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Server-only.

### Local playback

- A local file is no longer refused with Jellyfin's "bitrate exceeds limit". The
  server was sending its own 20 Mbps ceiling for local playback, so anything above
  that failed instead of direct-playing. Local viewers now get a ceiling above the
  source bitrate; remote playback keeps the chosen limit. A retry covers unusual
  profiles, and the error message is now readable if it still fails.

### Downloads

- Counts are no longer taken from a truncated sample. Every count is queried per
  filter, so a torrent outside the first page is still counted and listed, and a
  value that cannot be counted exactly is marked with a plus as a lower bound.
- Switching the filter while the visibility probe is in flight can no longer show
  one filter's rows under another.
- A failed probe no longer leaves an empty panel with no retry.
- An unknown qBittorrent version is treated as legacy rather than sending filters
  the server does not understand.

### Streams

- The Refresh button works inside the cache window.
- The unused catalogue provider join was removed; a source is shown only when the
  upstream data or the account lookup actually supplies one.

### Update chain

- A personal update feed served from a different origin than the app expects can
  no longer silently disable updates: the app records the reason and shows it on
  the Update screen.
- Both feed routes share one strict manifest validator, and an HTTPS origin is
  always preferred over HTTP.

### Warm-up

- Channel warm-up no longer leaves a second upstream connection alongside
  playback. A mismatched warm ticket is released only after the old session stops,
  and warm-up can be disabled by configuration.

### Identity (staged, not deployed)

- The identity bundle refuses to start when its coverage is less than the
  catalogue unless a reviewed coverage count is supplied, logs unmapped titles,
  collapses duplicate movie rows instead of aborting, and rejects an invalid year
  at load.

## Server 0.26.47 - 19 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Server-only.

### Activity and downloads

- Activity opens on the Activity tab again. Downloads stays one click away, and
  the tab is hidden entirely for a viewer who is not allowed to see it, using a
  single visibility probe rather than loading the list.
- Downloads filtering now happens in qBittorrent, not in the browser, so a
  torrent outside an arbitrary first page is still listed and counted when it is
  downloading. Counts are no longer capped at the sample size; where a bucket
  cannot be counted exactly the number is shown with a `+` and labelled a lower
  bound.
- Real qBittorrent states no longer collapse to "Unknown", and completed or
  stalled torrents no longer show a meaningless ETA.

### Streams

- Source and profile resolve from Dispatcharr's account list, which can exceed
  half a megabyte; the read limit was raised so names such as "Maxiums" and
  "Maxiums Default" appear instead of ids. A failed lookup is now reported as a
  bounded diagnostic instead of failing silently.

## Server 0.26.46 - 19 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Server-only. Android is 0.26.28 (build 82).

### Release guards

- The public source export now refuses any text file that starts with a UTF-8
  BOM, contains C1 control characters, contains double-encoded (mojibake)
  signatures or is not strict UTF-8. The release-135 encoding corruption was
  previously only caught by tests; a corrupt file now fails the export itself
  and names the offending path.
- The container check now inspects the bytes and `charset=utf-8` of the five
  setup assets and of one page from each public root. A missing or corrupted
  setup bundle, or a page re-encoded by an editing tool, fails packaging instead
  of reaching a home server. `node packaging/check-container.mjs --self-test`
  provides the same negative control where no container is available.
- A pre-export version assertion now requires `server/package.json`,
  `server/package-lock.json` and the top entry of this changelog to agree, and
  requires the guide's Android version text and links to match
  `app/build.gradle`. It fails closed before any output is written.
- The frozen release-135/136 `package-server.ps1` now refuses to run and points
  at `packaging/export-public.mjs`. Its allowlist omitted
  `server/homelab/public`, which caused the release-135 setup 404.

### Internal

- 0.26.45 was an internal packaging and release-guard revision, superseded by
  0.26.46 before publication. It has no separate user-facing notes.

## Server 0.26.44 - 19 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation.

Server-only. Android remains 0.26.27 (build 81) until the app build below.

### Streams

- Each upstream channel now names its real source and profile, for example
  "Maxiums" and "Maxiums Default", instead of the provider label and a profile
  id. The page never prints "Dispatcharr" as a source.
- The viewing app and person are attributed from Tellybox's own playback
  sessions: "Android TV - BRAVIA 4K VH21", "Android phone", "Browser", or
  "Tellybox server" when no local session matches. Two possible matches show
  "Multiple viewers" rather than guessing.

### App identity

- A native app is now recognised by the markers it sends (`x-jserver-app` plus
  `x-tellybox-client`) when the request is authenticated and same-origin, even
  when it signs in with a session cookie rather than a bearer token. Previously
  such a request was classified as a browser.
- Activity entries record whether those markers were present, so a client that
  fails to declare itself can be identified without guessing.
- Expect native clients to stop receiving browser-shaped capability limits once
  they declare themselves; a client that still sends web capability data will
  keep its browser limits by design.

## Server 0.26.43 - 19 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation. The publicly published GitHub source release remains **v0.26.10**
until this release's export is published.

Server-only. Android remains 0.26.27 (build 81).

### Playback

- Live TV and every Dispatcharr-sourced stream no longer show the quality,
  audio, subtitle and compatibility controls, or the next-episode and English
  subtitle preferences. Provider playback uses the server defaults, which keeps
  direct copy likely and avoids work that only causes more transcoding.
- Local films, episodes and recordings keep the full set of controls.
  Switching between a local item and a provider item restores or hides them
  without reloading.

### Installation settings

- qBittorrent and Home Assistant are now collapsed rows with an Enabled,
  Disabled or Not configured badge, matching every other integration. Expanding
  a row reveals its settings.
- The page uses one heading per section. The repeated section eyebrows, the
  duplicate Discovery label and the explanatory paragraph above the optional
  add-ons are removed.

## Server 0.26.42 - 19 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation. The publicly published GitHub source release remains **v0.26.10**.

Server-only. Android remains 0.26.27 (build 81).

### Downloads

- Activity opens on Downloads for local viewers and administrators, rather than
  behind an extra click. The tab bar and every deep link still work.
- Downloads default to what is currently downloading, with a count. When
  nothing is downloading, the panel says so and points at the queue and seeding
  totals instead of showing an empty list.

### Installation settings

- The settings page groups optional add-ons together: Discovery & requests,
  qBittorrent and Home Assistant now sit under the integrations section rather
  than above the core services.
- The relay media worker is part of Remote viewing rather than a separate
  top-level section. Relay information is unchanged.

## Server 0.26.41 - 19 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation. The publicly published GitHub source release remains **v0.26.10**.

Server-only. Android remains 0.26.27 (build 81).

### Downloads

- Downloads are visible to local viewers and administrators without an
  administrator sign-in, matching the Streams view. The list shows name, state,
  progress, size, speeds, ETA and ratio.
- Removing or deleting a torrent remains administrator-only. Viewers who are
  neither local nor an administrator do not see the section at all.

## Server 0.26.40 - 19 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation. The publicly published GitHub source release remains **v0.26.10**.

Server-only. Android remains 0.26.27 (build 81).

### Streams

- Each upstream channel now names the stream that was actually picked, for
  example "BBC One HD (stream 4281)", alongside the provider.
- When Dispatcharr records a source switch, the card shows when it happened and
  why (health check, buffering timeout, retries exhausted, and similar).

### Home

- The home page no longer waits for Continue Watching before drawing the rest
  of the page. Rows appear first and the Continue rail fills in when its lookup
  finishes, so a slow provider read no longer holds up everything.

### qBittorrent

- Sign-in now works with qBittorrent 5, which answers a successful login with
  204 and a session cookie rather than the older "Ok." text. Valid credentials
  were previously reported as rejected.

## Server 0.26.39 - 19 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation. The currently published GitHub source release remains **v0.26.10**;
do not treat 0.26.39 as a public installer until a reviewed export and release are
published here.

This is a server-only update. Android remains 0.26.27 (build 81); no app rebuild or
feed publication is included.

### Artwork

- 24/7 channel artwork is back. Where Dispatcharr cannot fetch a provider logo,
  Tellybox now fetches the provider's own logo itself, through a restricted
  proxy. The browser still sees only a local image address.
- Channel cards no longer request artwork that cannot load, so a grid of
  channels does not spend its time on failed image requests.

### Viewing activity

- The upstream Streams view now shows the provider when Dispatcharr knows it,
  and only says "Not reported" when the value is genuinely absent.
- Connections from the phone and TV apps are labelled "Android phone" and
  "Android TV" instead of "Other app".
- Local viewers and administrators can open Streams and the read-only
  statistics without an administrator sign-in. Remote viewers who are neither
  see no streams panel at all.
- The page is tidier: a single summary line, one card per upstream channel, and
  columns that are omitted when every value is unknown.

### Settings

- The Settings landing page uses an even grid: equal-height cards, aligned
  actions, and no orphaned card on a second row.
- qBittorrent is now configured in the installation settings on port 8990,
  behind the existing administrator sign-in. Save, test connection and remove
  are available there, and a connection can be saved while the WebUI is offline.
- The Integrations tab has been removed. The read-only qBittorrent summary now
  sits in Settings > Server > Downloads.

### Recordings

- Recording cards no longer collapse their text into a narrow column when a
  recording has no artwork.

### Performance

- The home page no longer requests its feed twice.
- Static assets are revalidated instead of being re-downloaded on every visit.
- The player library is loaded when playback starts rather than on the home
  page.
- The home feed response is cached per viewer briefly and no longer blocks other
  requests while it is built.

## Server 0.26.38 - 19 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation. The currently published GitHub source release remains **v0.26.10**;
do not treat 0.26.38 as a public installer until a reviewed export and release are
published here.

This is a server-only update. Android remains 0.26.27 (build 81); no app rebuild or
feed publication is included.

### Setup and installation

- The setup page on port 8990 returns its page and assets again. Release 0.26.37 shipped an image without the five setup UI files, so the setup API answered while the page and assets returned 404. The image now includes them. The server refuses to start without them, and the public exporter refuses to write an export that omits them.
- The container check requests the real setup page and asset routes instead of treating a healthy setup API as proof that the page works.
- The installation settings link uses the server-provided setup origin instead of rewriting the playback address to port 8990.

### Read-only statistics

- Viewers on the trusted local network or a recognised home connection can see an aggregate activity summary and, when qBittorrent monitoring is configured, an aggregate qBittorrent summary without an installation-administrator session.
- The summaries are read-only and are not stored by the browser. They contain aggregate counts, bandwidth and a limited view of active plays. They carry no IP addresses, internal account IDs or raw user agents. Configuration, logs, per-torrent details and every change remain administrator-only.

### Encoding and web interface

- Settings, Discover, Search, Preferences and Coming soon no longer show double-encoded text. They now use plain ASCII or HTML entities, with no byte-order mark. A permanent check scans the served pages, scripts, styles and data files for the same fault.
- A corrupted separator in the relay worker's external-subtitle label is repaired.
- On a narrow screen, the selected Settings tab now scrolls fully into view and exactly one tab stays selected.

### Packaging

- Removed a stale source manifest that could seed a release without the setup assets. The public release workflow now uses the exporter's `packaging/public-manifest.json` and has an explicit fallback.
- A clean export now includes the five setup assets and the public manifest at server 0.26.38.

## Home build 0.26.37 and Android 0.26.27 (build 81) - 19 November 2026

**Not a public source release.** This entry documents the reviewed private home
installation. The currently published GitHub source release remains **v0.26.10**;
do not treat 0.26.37 as a public installer until a reviewed export and release are
published here.

### TV and phone

- Continue watching uses one landscape shelf for films and episodes, with backdrop artwork and a centre-cropped poster fallback. Long-press removal still hides only that viewer's entry, with Undo and a new playback able to resurface it.
- The synopsis is compact non-focusable reading text under the title; the duplicate mid-page block is gone.
- TV and phone Home show a verified `Newly available` row for local, already-aired files. The upcoming calendar remains separate; unavailable releases are never labelled watch-now.
- Removed the redundant Home Coming-soon/Next-7-days shortcut and the dedicated Live TV text search. Categories, favourites, the EPG and global Search remain.
- Phone Home no longer repeats a page heading above the chips and shelves.
- The existing animated brand ident is used on Home loading, with reduced-motion support; the duplicate first-launch Home fetch was removed.
- Channel logos use cached-first, bounded visible/near-viewport loading with stable placeholders and a bounded retry window. Missing provider logos remain honest text placeholders.

### Live playback

- A proven-compatible HEVC live source with an unknown source bitrate can copy video instead of encoding. Known oversize, missing profile/level/pixel/geometry, 4:2:2/4:4:4, Main10 and transport mismatches still fail closed. This can reduce CPU, but it cannot guarantee the selected bitrate ceiling.
- The app keeps its one-shot compatibility fallback when a decoder genuinely rejects a stream.

### Server and administration

- Shared cache preload and owner refresh for Discover, trending and the catalogue.
- Activity includes an owner-only Streams view.
- Optional owner-only qBittorrent monitoring and confirmed single-torrent removal. It is disabled by default, makes no request when disabled, keeps downloaded files by default, and requires a separate explicit destructive confirmation to delete files.
- Artwork and channel-logo caching remain bounded and account-scoped.

### Not in this build

- No complete TorrentDay single-account/merger adapter. Stale old-source numeric catalogue IDs fail closed and must be re-added from current Browse; no numeric fallback or reindex is included.
- No physical BRAVIA hardware decode, HDR, HDCP, HDMI or audio-passthrough proof.

## Server 0.26.30, relay worker 0.26.13 and Android 0.26.24 (build 78) - 13 November 2026

### VOD and catch-up playback

- Streamed VOD now produces a bounded window ahead of the viewer instead of reading the provider at exactly realtime. Completed-segment progress drives restarts, so a slow encoder no longer makes the client look like it seeked ahead. Seek, resume, end, admission and the 45 s segment deadline are preserved.
- Native WebVTT captions are limited to the video window and retained per window, so a later window cannot overwrite earlier cues and a forward or backward seek keeps the right captions.
- The VOD cache enforces a bounded byte budget even when an earlier seek left a distant future window on disk. The requested segment is never evicted.
- Catch-up start and seek share one 45 s deadline across the provider session, archive open and first segment. Stop settles a pending read promptly, late provider sessions are released exactly once, and a provider that ignores cancellation cannot leave the player hanging.
- Catch-up quality now reaches the encoder as a bounded 2, 4, 8, 20 or 80 Mbps rung instead of always using 8 Mbps. Unknown values keep the 8 Mbps default.

### Quality controls

- Auto quality resolves against the effective negotiated playback ceiling, falls back to 8 Mbps when no ceiling is known, and never assumes 80 Mbps. The trouble-panel lower action offers a strictly lower rung, including 2 Mbps where supported, and never increases the bitrate.
- The server returns the effective quality with VOD and catch-up play responses so web and Android clients can resolve Auto consistently.

### Android

- Android 0.26.24 build 78 keeps the 115 decoder capability metadata and the 119 download acknowledgement fixes. The physical-device download symptom remains unverified until a real device test.

## Server 0.26.29, relay worker 0.26.12 and Android 0.26.23 (build 77) - 12 November 2026

### Playback performance and decoder-aware live playback

- Live and relay transcodes now default to the `ultrafast` x264 preset while keeping 1080p25, CRF 23 and two threads. `TELLYBOX_LIVE_PRESET=veryfast` is the rollback. VOD and catch-up keep their existing encoder settings.
- The Android app sends bounded decoder metadata on player requests; the server uses it only for live playback. The server may copy HEVC or H.264 video when the source codec, profile, resolution, bitrate, audio and HLS/MPEG-TS combination are all supported. Invalid or missing metadata falls back to the existing transcode path.
- Browser clients remain conservative and do not advertise live decoder capabilities.
- A live decode failure gets one compatibility retry, then stops. The retry flag prevents loops.
- The relay media player now stops a producer that makes no playlist progress, instead of letting repeated unchanged playlist reads keep a stalled session alive. It records bounded, URL-stripped ffmpeg diagnostics for future diagnosis.
- The app version is 0.26.23 build 77. APKs remain unsigned until the normal signing process.

### Playable-only normal watch surfaces

- Normal Series, Home and recommendation rails now show only series with at least one currently playable episode. A season container or a streamed entry with no released episodes is no longer presented as watchable.
- Availability is checked against a bounded, cached episode index. Local series use Jellyfin episodes only; streamed series use the saved Dispatcharr episode lists. Provider failures are treated as unknown, never as empty, and are retried with backoff.
- Empty or unverified titles are removed before pagination, replacement candidates are checked instead of trusted blindly, and totals are an honest verified lower bound. The client shows a short "Checking availability..." state while more titles are pending.
- Discover and the Search "More" results keep unavailable metadata so a title can still be requested; they do not offer a play action for an empty title. Coming Soon remains a separate future-release calendar, not a watch-now list.
- A known-empty local series no longer receives a local Watch button in Discover or Search.

### Web player return state

- Closing the player or using browser Back from Search or Discover returns to the originating page with its query, filters, loaded pages, scroll position and Discover detail restored, even though production sends `Referrer-Policy: no-referrer`.

### Android downloads

- The Downloads page now survives an uninitialised media cache instead of rendering empty. Starting a download waits for the real offline index to accept the request; if it does not, the page shows an actionable error and retry rather than a silent empty screen. Existing downloads and cache are preserved.

## Server 0.26.28 and relay worker 0.26.11 - 12 November 2026

### Faster, calmer live playback

- The relay worker checks Dispatcharr readiness with a one-row authenticated catalogue request instead of downloading the full 1,067-channel M3U playlist every 30 seconds.
- The hourly episode index now refreshes only a small stale slice, at low concurrency, and defers while live playback is active. It no longer forces every recently browsed series through the provider at once.
- Catalogue refresh errors and failed episode lists continue to preserve the last saved data.
- No Android app or feed publication is part of this server-only update.

## Server 0.26.27 and Android 0.26.22 (build 76) - 11 November 2026

### Source labels and Activity identity

- Film, series and episode details now show the actual upstream provider. A known provider appears as `Streamed · <provider>`; when Dispatcharr exposes no provider the exact fallback is `Streamed · Dispatcharr`. Local titles still say `On your server`.
- Provider choice follows Dispatcharr's own VOD order: active accounts by descending priority, then relation id. Provider lookup is bounded and cached, and list pages never request a provider for every card.
- Activity now separates the Android TV app, the Android app and an Android browser. The TV app is labelled `Android TV` with the TV icon instead of being treated as a phone or tablet.
- The Android apps send an explicit client kind. A bearer token alone is not treated as an app, and a friendly device name is never used to guess the device.
- A web page cannot claim an Android label; client identity is display metadata and never grants access or changes account, local, role or route attribution.

## Server 0.26.25 - 9 November 2026

### Playable Home recommendations

- Home no longer offers a series that is confirmed to have no available episodes. The check is limited to the series already selected for a rail, cached, and bounded; a provider failure is never treated as an unavailable title.
- A series card now opens its episode browser and resume choice instead of trying to play an empty series. An empty series shows an honest "No episodes are available for this series yet" message.
- A failed poster request now falls back to the existing text placeholder instead of leaving a broken image icon.
- Titles with missing artwork remain listed when they are otherwise available.

## Server 0.26.24 and Android 0.26.20 (build 74) - 9 November 2026

### More varied recommendations

- `Picked for you` now rotates to a different relevant selection every six hours instead of repeating the same top titles. The selection stays stable while you browse and avoids repeats across the personalised rows where possible.
- The app now ranks a broad, genre-balanced recommendation pool instead of only the newest 120 films. Saved interests count as viewing signals, so an interests-only viewer can receive picks.
- The Home page shows all available recommendation rows and explains that picks rotate every six hours. The Refresh control remains a retry action.
- A viewer with many favourites or watched titles can submit the full home context without hitting the small JSON limit.
- The app recommendation request is bounded to a five-second timeout so a slow pool cannot hold up the rest of Home.

## Server 0.26.18 - 7 November 2026

### Optional public asset CDN

- Installation settings can now set an optional HTTPS origin for public static CSS and branding. It is disabled by default and blank means the local server is used.
- Only public stylesheets and static branding are eligible in this first phase. JavaScript, channel logos, private artwork, APIs, sessions, subtitles, media and app feeds remain on the normal server route.
- CDN URLs use content-versioned paths and local fallback. A failed CDN stylesheet or branding image restores the local file.
- This does not change video start time and does not move any authenticated or private response.

## Server 0.26.17 - 7 November 2026

### USB export memory safety

- USB export now flushes written data in bounded intervals instead of leaving many gigabytes of dirty page cache inside the container. Memory use stays stable even for very large files and a low memory limit.
- Only one export runs at a time. A second drive waits in a visible queued state, and cancelling a queued or running export removes only its own partial file.
- If the media process exits unexpectedly, it is restarted with a short bounded backoff. Repeated failures pause automatic recovery instead of restarting forever, and only a child that stays healthy resets the retry budget. Deliberate setup changes or shutdown never trigger a restart.
- Includes the relay viewing allowance correction below.

## Server 0.26.16 - 7 November 2026

### Relay viewing allowance

- Relay playback now compares each enabled allowance with its own usage. A manual total and a daily limit no longer consume each other, so an account with both enabled keeps the correct smaller remaining window.
- Reservations, renewals, reconciliation, midnight and manual resets remain conservative and cannot overgrant or charge twice.

## Android 0.26.17 (build 71) and Server 0.26.15 - 7 November 2026

### Web navigation

- One consistent topbar on every web page, with a compact Coming soon link and a menu on smaller screens.
- Watching settings and viewing activity now live inside Settings. Viewer preferences stay separate from administrator settings, and remote viewers are not shown administrator controls.

### TV guide layout

- Channel cells stay logo-only once a logo loads. The channel number and name return only when there is no usable logo, including after a guide refresh or returning from playback.
- Start from beginning is a small corner badge on the programme tile. The programme title keeps the same height and baseline whether or not restart is available, and short cells still read cleanly.
- The restart action remains available through the existing hold-OK channel actions; the badge is not a separate focus stop.

## Android 0.26.16 (build 70) and Server 0.26.14 - 7 November 2026

### Channel logos

- Channel identities show the logo alone after it loads, with the channel number and name kept as the accessible fallback.
- Logos keep their natural aspect ratio in a consistent tile. Recycled views no longer inherit another channel's image, and a refresh failure keeps the last good logo.

### Home and Coming soon

- Home now features a playable title with clear Play/Resume and More info, plus varied rows grounded in the viewer's own history, favourites and taste. The featured rotation is manual and accessible.
- Coming soon is a separate page with a seven-day calendar, TV/film filters, deep links and the existing request/availability links.
- Home picks refresh on a sensible cache and on relevant feedback changes without disrupting active playback or focus.
- Continue watching and Resume are per viewer: a partially watched film or the latest episode of a series resumes at its own saved position, finished titles leave Continue watching, and another person's or device's progress is never used.

### Pause timeout input

- The Pause timeout minutes field is readable on desktop and mobile, with an explicit minutes label. `0` disables it, the default is 10 and the valid range is 0-1440.

## Android 0.26.15 (build 69) and Server 0.26.13 - 6 November 2026

### Loading ident

- Web, phone and TV players show the Tellybox mark only while a stream is preparing, buffering or seeking. It hides on playback, normal pause, ended, error and close.
- Reduced-motion settings on web and Android disable or stop the animation. A loading state never shows a blank box.

### Paused-stream timeout

- Administrators can set **Server > Server playback defaults > Pause timeout**. The default is 10 minutes; 0 disables the automatic close.
- VOD, local, recording and catch-up sessions close after a long pause and keep the resume position. Live TV and 24/7 are excluded.
- Buffering and seeking do not count as a user pause. A timeout returns an explicit reason to web, phone, TV and shared links instead of a silent stop.

### USB export

- Optional, administrator-only and off on a fresh install. Copy original local films, episodes, completed recordings and adjacent subtitles to a USB drive attached to the media host.
- Review the exact file plan, watch progress, cancel safely and eject when finished. Originals and existing destination files are never overwritten, changed or deleted.
- Remote Dispatcharr items and streamed VOD are not offered. The container stays read-only with all capabilities dropped; only reviewed narrow mounts and the export helper group are added.

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
