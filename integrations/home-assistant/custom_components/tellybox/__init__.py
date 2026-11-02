"""Read-only Tellybox statistics for Home Assistant."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import TellyboxApi
from .const import CONF_TOKEN, CONF_URL
from .coordinator import TellyboxCoordinator

PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.BINARY_SENSOR]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
	"""Set up one Tellybox installation and do the first shared poll."""
	api = TellyboxApi(
		async_get_clientsession(hass),
		entry.data[CONF_URL],
		entry.data[CONF_TOKEN],
	)
	coordinator = TellyboxCoordinator(hass, entry, api)
	await coordinator.async_config_entry_first_refresh()
	entry.runtime_data = coordinator
	await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
	return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
	"""Unload every platform and release the coordinator."""
	return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
