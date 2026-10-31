# Licensing boundaries

The unmodified PolyForm Noncommercial License 1.0.0 in `LICENSE` applies to the Tellybox-authored server, web interface, relay setup helper, tests, installation documentation and deployment files published in the `jharrisuk/tellybox-homelab` repository. Keep `NOTICE` with redistributed copies. Commercial use requires separate permission from the relevant rightsholders; the licence's own permitted-purpose definitions govern.

Third-party components are excluded from this licence grant and remain under their original terms. See `THIRD-PARTY-NOTICES.txt`. The Tellybox licence does not prohibit exercising the rights granted by those separate licences. Merely building a container does not relicense its operating system, Node.js, FFmpeg, fonts or other packages.

The Android phone, Android TV and iOS companion application source, build machinery and signing material are not part of the public server release and are not licensed under PolyForm. Official app binaries are governed by `APP-TERMS.md`; their dependencies retain their own licences. In the maintainer's private combined workspace, `app/`, `adbbridge/`, Android build files and the private notification-gateway implementation are expressly excluded from the server licence grant.

The Tellybox name and logos are subject to `BRANDING.md`. Movie/series posters, channel logos, subtitles, programme-guide data, provider catalogues and other externally sourced material are not licensed by this repository. Connecting a service or downloading metadata does not confer rights to redistribute its content.

This release distributes server source and a Docker build recipe. It does not distribute a prebuilt server container. The recipe obtains dependencies from their upstream distributors. If you redistribute a resulting container, you are responsible for the notices and corresponding-source obligations of the exact binaries you distribute, including FFmpeg and its dependencies. See the third-party notices before publishing container images.
