"""Optional connectivity sensor for Tellybox."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import TellyboxCoordinator
from .entity import TellyboxEntity

PARALLEL_UPDATES = 0


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
	"""Add the optional online binary sensor."""
	coordinator: TellyboxCoordinator = entry.runtime_data
	async_add_entities([TellyboxOnlineSensor(coordinator, entry)])


class TellyboxOnlineSensor(TellyboxEntity, BinarySensorEntity):
	"""Whether the last single statistics poll succeeded."""

	_attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
	_attr_entity_category = EntityCategory.DIAGNOSTIC
	_attr_translation_key = "online"

	def __init__(self, coordinator: TellyboxCoordinator, entry: ConfigEntry) -> None:
		super().__init__(coordinator, entry)
		self._attr_unique_id = f"{entry.entry_id}_online"

	@property
	def is_on(self) -> bool:
		return self.coordinator.last_update_success
