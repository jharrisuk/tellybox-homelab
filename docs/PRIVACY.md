# Privacy and data flow

This describes Tellybox HomeLab server 0.26.0 and the official HomeLab Android apps. A self-hosted installation is operated by its owner. The owner decides who can use it and which optional services are connected.

## Your own server

Tellybox stores installation settings, service credentials, account and device approvals, favourites, viewing progress, activity records, viewing allowances and caches on the server's configuration volume. Depending on the features used, these records can include email addresses, device names, IP addresses, the titles watched, playback positions and time watched. Administrators can see activity and manage access.

Browsers and apps keep local information needed to use the selected server, such as session credentials, preferences and downloaded media. A local browser can be recognised and linked to a person without requiring a viewing login. Local access does not mean viewing activity is anonymous to the installation's administrators.

Your media stays in the source services unless you choose a download or another feature that creates a local copy or temporary playback file. Tellybox does not supply media or include content subscriptions.

The installation owner controls the configuration volume and its backups. Backups can contain credentials and personal data: encrypt them and do not upload them to public issues or repositories. Exact retention depends on the installation, its features and the owner's backups; this document does not promise an automatic deletion period for all server data.

## Optional standard administrator notifications

Notifications start disabled. Enabling **Standard Tellybox HomeLab** in installation settings, then opting in to administrator alerts in the official phone app, uses the shared gateway at `https://homelab.tellyboxapp.com/push/v1` and Google Firebase Cloud Messaging (FCM).

The registration flow gives the gateway:

- A randomly generated installation identifier and authentication material. The gateway stores a hash of the installation secret.
- A hashed device identifier, opaque registration handles and proof-of-device registration data.
- The device's FCM push token, which lets the gateway address that app installation.
- Registration/activity timestamps and opaque event IDs used for delivery and duplicate prevention.
- Normal network request information, including the source IP address; IP-derived rate-limit identifiers are used to limit abuse.

The server sends an **event ID**, not the human-readable alert, when asking the gateway to wake an administrator's device. The gateway forwards that ID and an opaque handle through FCM. The app then authenticates directly to your Tellybox server to retrieve details such as the requesting email address, device name or programme title. The gateway API does not accept those names, email addresses, titles, media URLs or service credentials as notification text.

Registration metadata and tokens are stored by the gateway to provide delivery. Disabling administrator alerts in the app attempts to unregister that device and remove its push token; it needs network access to complete. Switching off notifications on the server stops sending further wake requests, but is not a guarantee that existing gateway records, infrastructure logs or backups are immediately erased. We do not claim a fixed retention period for hosting logs or backups here.

FCM processes notification delivery under [Google Firebase's privacy information](https://firebase.google.com/support/privacy). Delivery may be delayed or unavailable. Alerts can also appear on the phone's lock screen according to Android notification settings.

## Custom notifications

An installation configured for **Custom Firebase** uses its own Firebase project rather than the standard gateway. The server holds the service-account credential and sends opaque event IDs to FCM. The receiving app retrieves notification details from the server after authentication. The Firebase project and client configuration must match the app being used.

## App downloads and updates

The official HomeLab apps check the publisher's update feed and download signed packages from `homelab.tellyboxapp.com`. Changing your media server does not change this update source. The publisher's website receives normal HTTP request information, such as the source IP, requested file and request headers. The update feed does not need your media-service credentials, viewing history or account password.

The **Install on a TV** helper downloads the TV APK from that same source, verifies it and connects from your phone to the TV over your local network. It does not route the ADB installation through the Tellybox server. You choose whether to enable debugging and authorise the connection on your TV.

## Connected services and external data

Each integration is optional and starts disabled. When enabled, requests go to the service addresses and providers configured by the installation owner. For example:

- Jellyfin and Dispatcharr provide library/channel information and playback. Requesting or watching content sends the necessary requests to those services and, where applicable, their upstream providers.
- Seerr, Sonarr and Radarr receive discovery or local-copy requests and provide monitored-release information.
- Metadata, poster, streaming-availability and chart features contact their data providers, directly or through your configured services. Image requests can expose the viewer's IP address to the image host.
- OpenSubtitles receives subtitle searches and download requests. IntroDB receives supported title identifiers to look up playback markers.
- Resend receives recipient email addresses and the contents of login or approval emails when email access is enabled.
- An optional relay and Tailscale participate in remote routing and have their own service and logging arrangements.

Those services have their own privacy policies, terms and retention rules. Tellybox's software licence does not replace them. An installation's service credentials are kept on that server; the standard notification gateway does not require them.

## Questions and removal requests

For viewing history, accounts, device links or downloads on a particular installation, contact that installation's administrator. Turning off a feature does not necessarily delete its historical data or backups.

For a problem with the official apps or shared gateway, use the project's [GitHub issues](https://github.com/jharrisuk/tellybox-homelab/issues) to ask for a private contact route. Do not post push tokens, installation secrets, email addresses, private URLs or logs containing personal information in a public issue.
