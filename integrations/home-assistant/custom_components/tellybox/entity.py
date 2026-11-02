"""Shared device information for Tellybox entities."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CONF_URL, DOMAIN, MANUFACTURER, MODEL
from .coordinator import TellyboxCoordinator


class TellyboxEntity(CoordinatorEntity[TellyboxCoordinator]):
	"""Base entity tied to one stable Tellybox installation."""

	_attr_has_entity_name = True

	def __init__(self, coordinator: TellyboxCoordinator, entry: ConfigEntry) -> None:
		super().__init__(coordinator)
		version = (coordinator.data or {}).get("server", {}).get("version")
		info = DeviceInfo(
			identifiers={(DOMAIN, entry.unique_id or entry.entry_id)},
			manufacturer=MANUFACTURER,
			model=MODEL,
			name=entry.title,
			configuration_url=entry.data[CONF_URL],
		)
		if version:
			info["sw_version"] = version
		self._attr_device_info = info
