# Security

This is an early-access homelab project. Keep setup port 8990 and local-viewing port 8082 on a trusted home network. Local viewing intentionally does not require a login. Use the separate remote port 8083 through an HTTPS reverse proxy with carefully configured trusted peers; do not expose local-viewing or setup ports to the internet.

Back up configuration before updating. It contains credentials and personal data, so encrypt backups and keep them out of Git. Restrict access to your Docker host and configure only services you trust.

Please do not publish exploitable vulnerabilities, credentials or private configuration in public issues. Use GitHub's private vulnerability reporting if enabled. If it is unavailable, open an issue requesting a private contact method without including vulnerability details. The maintainer cannot promise a response time or security-service level.
