"""Single coordinator poll for all Tellybox entities."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import TellyboxApi, TellyboxApiError, TellyboxAuthError, TellyboxConnectionError
from .const import DEFAULT_SCAN_INTERVAL, DOMAIN

import logging

_LOGGER = logging.getLogger(__name__)


class TellyboxCoordinator(DataUpdateCoordinator[dict[str, Any]]):
	"""Poll one read-only statistics endpoint for every entity."""

	def __init__(self, hass: HomeAssistant, config_entry: ConfigEntry, api: TellyboxApi) -> None:
		super().__init__(
			hass,
			_LOGGER,
			config_entry=config_entry,
			name=DOMAIN,
			update_interval=timedelta(seconds=DEFAULT_SCAN_INTERVAL),
		)
		self.api = api

	async def _async_update_data(self) -> dict[str, Any]:
		try:
			return await self.api.async_get_stats()
		except TellyboxAuthError as error:
			raise ConfigEntryAuthFailed from error
		except TellyboxConnectionError as error:
			raise UpdateFailed(str(error)) from error
		except TellyboxApiError as error:
			raise UpdateFailed(str(error)) from error
