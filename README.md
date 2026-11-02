# Tellybox HomeLab

Your collection, live TV, 24/7 channels and streamed titles in one place, with a web player and companion apps for Android phone and TV.

**Server 0.26.6 - early access.** Built for people who enjoy running their own media services. Start with a separate installation, connect the services you use, and try it on your devices before relying on it.

**[Installation walkthrough](https://homelab.tellyboxapp.com/#start)** · **[Android apps](https://homelab.tellyboxapp.com/#apps)** · **[Report a problem](https://github.com/jharrisuk/tellybox-homelab/issues)**

## What it connects to

- **Jellyfin:** your local films, series and recordings.
- **Dispatcharr:** live TV, a programme guide, 24/7 channels, on-demand titles and supported recording/catch-up features.
- **Seerr:** discovery and requests for local copies.
- **Sonarr and Radarr:** upcoming releases from your monitored collection.
- **OpenSubtitles and IntroDB:** optional English subtitle lookup and supported intro markers.
- **Resend and notifications:** optional remote email access and administrator alerts.

Every integration starts switched off. Use Jellyfin, Dispatcharr, both, or add more later. Tellybox does not install these services, supply media or include an IPTV subscription. Connect only sources you are entitled to use.

## Get started

Linux is the recommended server host. Use Windows PowerShell or macOS Terminal to SSH into that Linux server and run the commands there. Windows and Mac can be your management computers; they do not need Docker for this approach. Hosting with Docker Desktop is possible, but the walkthrough uses Linux.

Install Docker Engine with the Compose plugin and Git on the Linux server, then:

```sh
cd ~
git clone https://github.com/jharrisuk/tellybox-homelab.git
cd ~/tellybox-homelab
cp .env.example .env
nano .env
```

In `.env`, set these two values to **your Linux server's private LAN IP**. This example uses `192.168.1.50`; replace it with your own address:

```ini
TELLYBOX_BIND=192.168.1.50
TELLYBOX_SETUP_BIND=192.168.1.50
```

Leave the relay setting unchanged for a home-only setup. Start the server and retrieve the first-setup code:

```sh
docker compose up -d --build --wait
docker compose exec tellybox node -p "require('/config/bootstrap.json').token"
```

From any computer on the same home network, open **`http://SERVER_IP:8990`**. Enter the setup code, choose an installation-administrator password of at least 12 characters, and enable the services you want. Save, test each connection, then apply the settings.

Use **`http://SERVER_IP:8082`** to watch. Setup and local viewing are separate: local viewing does not grant installation-administrator access. Keep ports 8082 and 8990 off the public internet. See the [walkthrough](https://homelab.tellyboxapp.com/#start) for the full network settings, same-server connections and troubleshooting.

## Phone and TV apps

Download the latest official **Tellybox HomeLab** apps from the [guide](https://homelab.tellyboxapp.com/#apps) and enter your own server address. App and server version numbers are independent.

The apps are proprietary and their source is not in this repository. Their signed updates come from the Tellybox publisher, regardless of which media server you connect to. You do not need to build apps or host APK files. The phone app can also guide you through installing the TV app over your local network on compatible devices.

## Home Assistant

An optional read-only Home Assistant custom integration is in `integrations/home-assistant`. It exposes aggregate stream, download, upload and server health sensors. Copy `custom_components/tellybox` into your Home Assistant configuration and follow the [integration README](integrations/home-assistant/README.md). It is not an official Home Assistant integration and is not listed in HACS. The Tellybox server side stays disabled until you create a dedicated token in installation settings.

## Remote viewing and notifications

Home-only use needs no public hostname. For remote viewing, follow the [optional HTTPS relay guide](https://homelab.tellyboxapp.com/#remote). A relay connects to the server's authenticated **8083** entry; do not expose the login-free local viewing port instead.

Administrator notifications are optional. The **Standard Tellybox HomeLab** setting uses the shared notification gateway and Google Firebase Cloud Messaging to wake an opted-in administrator's app. Notification details are fetched from your own server after authentication. See [Privacy and data flow](docs/PRIVACY.md).

## Updates and backups

Back up the configuration volume, `.env` and source revision first. The configuration contains credentials, so encrypt backups and keep them private. Choose a time when a brief playback interruption is acceptable, then run in the original project folder:

```sh
git status --short
git pull --ff-only
docker compose up -d --build --wait
```

Stop if Git reports conflicts or unexpected local changes. Keep your existing `.env` and configuration volume; do not replace them with a fresh example. Never use `docker compose down -v` to update: it removes the configuration volume. Media remains in its source services, which need their own backups.

## Licence

The Tellybox server and web interface are **source-available under [PolyForm Noncommercial 1.0.0](LICENSE)**. Personal and other permitted non-commercial use, modification and sharing are allowed. Commercial use needs separate permission. This is not an open-source licence.

Official companion apps are covered separately by [App terms](APP-TERMS.md). Third-party components retain their own licences, and metadata, artwork and connected services have their own terms.

## Feedback

This is an early-access hobby project. Device compatibility, playback and third-party features depend on your setup. [Open an issue](https://github.com/jharrisuk/tellybox-homelab/issues) with your server version, app version, device and a short description of what happened. Remove passwords, setup codes, API keys, email addresses, private media URLs and other personal details from screenshots or logs before posting.
