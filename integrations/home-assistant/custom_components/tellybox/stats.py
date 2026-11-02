"""Pure parsing and validation for the Tellybox statistics payload."""

from __future__ import annotations

import math
import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .const import STATS_SCHEMA, STATS_VERSION

TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,256}$")
DISK_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
DISK_NAME_PATTERN = re.compile(r"^[\w ()\u00b7.\-]{1,120}$", re.UNICODE)


class StatsFormatError(ValueError):
	"""Raised when the server response is not the documented stats schema."""


def normalize_server_url(value: Any) -> str:
	"""Return a safe base URL without credentials, query or fragment."""
	if not isinstance(value, str):
		raise ValueError("The server address must be text.")
	if any(ord(character) < 32 for character in value):
		raise ValueError("The server address contains unsupported characters.")
	value = value.strip()
	if not value or len(value) > 500:
		raise ValueError("Enter a server address under 500 characters.")
	if any(character.isspace() for character in value):
		raise ValueError("The server address contains unsupported characters.")
	try:
		parts = urlsplit(value)
	except ValueError as error:
		raise ValueError("Enter a complete HTTP or HTTPS server address.") from error
	if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
		raise ValueError("Enter a complete HTTP or HTTPS server address.")
	if parts.username is not None or parts.password is not None:
		raise ValueError("Do not include a username or password in the server address.")
	if parts.query or parts.fragment:
		raise ValueError("Remove the query string or fragment from the server address.")
	try:
		parts.port
	except ValueError as error:
		raise ValueError("The server port is invalid.") from error
	path = parts.path.rstrip("/")
	return urlunsplit((parts.scheme.lower(), parts.netloc, path, "", ""))


def normalize_token(value: Any) -> str:
	"""Validate the shape of a token without logging or altering its value."""
	if not isinstance(value, str):
		raise ValueError("The Home Assistant token must be text.")
	token = value.strip()
	if not TOKEN_PATTERN.fullmatch(token):
		raise ValueError("Enter the token shown in Tellybox installation settings.")
	return token


def _optional_number(value: Any) -> float | int | None:
	if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
		return None
	if not math.isfinite(value) or value < 0:
		return None
	return value


def _optional_count(value: Any) -> int | None:
	if value is None or isinstance(value, bool) or not isinstance(value, int):
		return None
	return value if value >= 0 else None


def _mapping(value: Any, label: str) -> dict[str, Any]:
	if not isinstance(value, dict):
		raise StatsFormatError(f"The {label} section is missing.")
	return value


def _text(value: Any, limit: int = 128) -> str | None:
	if not isinstance(value, str):
		return None
	value = value.strip()
	return value[:limit] if value else None


def parse_stats(payload: Any) -> dict[str, Any]:
	"""Return only the documented allowlisted aggregate fields."""
	if not isinstance(payload, dict):
		raise StatsFormatError("The server did not return a stats object.")
	if payload.get("schema") != STATS_SCHEMA or payload.get("schemaVersion") != STATS_VERSION:
		raise StatsFormatError("This server uses an unsupported Tellybox stats schema.")
	raw_installation_id = payload.get("installationId")
	if not isinstance(raw_installation_id, str) or not raw_installation_id.strip() or len(raw_installation_id.strip()) > 128:
		raise StatsFormatError("The server did not return a stable installation ID.")
	installation_id = raw_installation_id.strip()
	server = _mapping(payload.get("server"), "server")
	streams = _mapping(payload.get("streams"), "streams")
	downloads = _mapping(payload.get("downloads"), "downloads")
	upload = _mapping(payload.get("upload"), "upload")
	host_status = server.get("hostStatus")
	if host_status not in ("ok", "stale", "missing"):
		host_status = "missing"
	host_ok = host_status == "ok"
	disks: list[dict[str, Any]] = []
	raw_disks = server.get("disks")
	if isinstance(raw_disks, list):
		for disk in raw_disks[:64]:
			if not isinstance(disk, dict):
				continue
			disk_id = _text(disk.get("id"), 64)
			disk_name = _text(disk.get("name"), 120)
			if not disk_id or not DISK_ID_PATTERN.fullmatch(disk_id):
				continue
			if not disk_name or not DISK_NAME_PATTERN.fullmatch(disk_name):
				disk_name = "Disk"
			disks.append({
				"id": disk_id,
				"name": disk_name,
				"available_bytes": _optional_number(disk.get("availableBytes")) if host_ok else None,
				"total_bytes": _optional_number(disk.get("totalBytes")) if host_ok else None,
				"used_bytes": _optional_number(disk.get("usedBytes")) if host_ok else None,
			})
	unlimited = upload.get("unlimited")
	return {
		"installation_id": installation_id,
		"generated_at": _optional_number(payload.get("generatedAt")),
		"server": {
			"version": _text(server.get("version"), 64),
			"host_status": host_status,
			"cpu_percent": _optional_number(server.get("cpuPercent")) if host_ok else None,
			"memory_percent": _optional_number(server.get("memoryPercent")) if host_ok else None,
			"uptime_seconds": _optional_number(server.get("uptimeSeconds")),
			"host_uptime_seconds": _optional_number(server.get("hostUptimeSeconds")) if host_ok else None,
			"memory_total_bytes": _optional_number(server.get("memoryTotalBytes")) if host_ok else None,
			"memory_available_bytes": _optional_number(server.get("memoryAvailableBytes")) if host_ok else None,
			"disks": disks,
		},
		"streams": {
			"active": _optional_count(streams.get("active")),
			"connected": _optional_count(streams.get("connected")),
			"paused": _optional_count(streams.get("paused")),
			"local": _optional_count(streams.get("local")),
			"remote": _optional_count(streams.get("remote")),
		},
		"downloads": {"active": _optional_count(downloads.get("active"))},
		"upload": {
			"configured_mbps": _optional_number(upload.get("configuredMbps")),
			"unlimited": unlimited if isinstance(unlimited, bool) else None,
			"measured_mbps": _optional_number(upload.get("measuredMbps")),
			"measurement_seconds": _optional_number(upload.get("measurementSeconds")),
		},
	}
