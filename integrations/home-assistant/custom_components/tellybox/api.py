"""Small read-only HTTP client for the Tellybox stats endpoint."""

from __future__ import annotations

from typing import Any

import aiohttp

from .const import DEFAULT_SCAN_INTERVAL, REQUEST_TIMEOUT, STATS_PATH
from .stats import StatsFormatError, normalize_server_url, normalize_token, parse_stats


class TellyboxError(Exception):
	"""Base error for Tellybox requests."""


class TellyboxAuthError(TellyboxError):
	"""The dedicated token was rejected."""


class TellyboxConnectionError(TellyboxError):
	"""The server could not be reached."""


class TellyboxApiError(TellyboxError):
	"""The server returned an unusable response."""


class TellyboxApi:
	"""Read aggregate statistics from one Tellybox installation."""

	def __init__(self, session: aiohttp.ClientSession, base_url: str, token: str, timeout: float = REQUEST_TIMEOUT) -> None:
		self._session = session
		self._base_url = normalize_server_url(base_url)
		self._token = normalize_token(token)
		self._timeout = timeout

	async def async_get_stats(self) -> dict[str, Any]:
		"""Fetch and parse the versioned read-only statistics payload."""
		url = self._base_url + STATS_PATH
		headers = {"Authorization": "Bearer " + self._token, "Accept": "application/json"}
		timeout = aiohttp.ClientTimeout(total=self._timeout)
		try:
			async with self._session.get(url, headers=headers, timeout=timeout, allow_redirects=False) as response:
				if response.status in (401, 403):
					raise TellyboxAuthError("Tellybox rejected the Home Assistant token.")
				if response.status != 200:
					raise TellyboxApiError("Tellybox did not return statistics.")
				content_type = response.headers.get("Content-Type", "")
				if "application/json" not in content_type.lower():
					raise TellyboxApiError("Tellybox returned an unexpected response type.")
				length = response.headers.get("Content-Length")
				if length and length.isdigit() and int(length) > 512 * 1024:
					raise TellyboxApiError("Tellybox returned an oversized statistics response.")
				payload = await response.json(content_type=None)
		except TellyboxError:
			raise
		except TimeoutError as error:
			raise TellyboxConnectionError("Tellybox did not answer in time.") from error
		except aiohttp.ClientError as error:
			raise TellyboxConnectionError("Tellybox could not be reached.") from error
		except ValueError as error:
			raise TellyboxApiError("Tellybox returned invalid JSON.") from error
		try:
			return parse_stats(payload)
		except StatsFormatError as error:
			raise TellyboxApiError(str(error)) from error


def scan_interval() -> int:
	"""Expose the documented polling interval for tests and diagnostics."""
	return DEFAULT_SCAN_INTERVAL
