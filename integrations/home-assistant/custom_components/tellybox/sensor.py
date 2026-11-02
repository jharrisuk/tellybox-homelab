"""Read-only sensors for Tellybox."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import (
	SensorDeviceClass,
	SensorEntity,
	SensorEntityDescription,
	SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
	PERCENTAGE,
	EntityCategory,
	UnitOfDataRate,
	UnitOfInformation,
	UnitOfTime,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import TellyboxCoordinator
from .entity import TellyboxEntity

PARALLEL_UPDATES = 0


@dataclass(frozen=True, kw_only=True)
class TellyboxSensorEntityDescription(SensorEntityDescription):
	"""A sensor value selected from the coordinator's allowlisted payload."""

	value_fn: Callable[[dict[str, Any]], float | int | None]


def _section(name: str, key: str) -> Callable[[dict[str, Any]], float | int | None]:
	return lambda data: (data.get(name) or {}).get(key)


SENSORS: tuple[TellyboxSensorEntityDescription, ...] = (
	TellyboxSensorEntityDescription(
		key="active_streams",
		translation_key="active_streams",
		value_fn=_section("streams", "active"),
		state_class=SensorStateClass.MEASUREMENT,
	),
	TellyboxSensorEntityDescription(
		key="connected_streams",
		translation_key="connected_streams",
		value_fn=_section("streams", "connected"),
		state_class=SensorStateClass.MEASUREMENT,
	),
	TellyboxSensorEntityDescription(
		key="local_streams",
		translation_key="local_streams",
		value_fn=_section("streams", "local"),
		state_class=SensorStateClass.MEASUREMENT,
	),
	TellyboxSensorEntityDescription(
		key="remote_streams",
		translation_key="remote_streams",
		value_fn=_section("streams", "remote"),
		state_class=SensorStateClass.MEASUREMENT,
	),
	TellyboxSensorEntityDescription(
		key="active_downloads",
		translation_key="active_downloads",
		value_fn=_section("downloads", "active"),
		state_class=SensorStateClass.MEASUREMENT,
	),
	TellyboxSensorEntityDescription(
		key="measured_remote_upload",
		translation_key="measured_remote_upload",
		value_fn=_section("upload", "measured_mbps"),
		device_class=SensorDeviceClass.DATA_RATE,
		native_unit_of_measurement=UnitOfDataRate.MEGABITS_PER_SECOND,
		state_class=SensorStateClass.MEASUREMENT,
		suggested_display_precision=2,
	),
	TellyboxSensorEntityDescription(
		key="configured_upload_limit",
		translation_key="configured_upload_limit",
		value_fn=_section("upload", "configured_mbps"),
		device_class=SensorDeviceClass.DATA_RATE,
		native_unit_of_measurement=UnitOfDataRate.MEGABITS_PER_SECOND,
		state_class=SensorStateClass.MEASUREMENT,
	),
	TellyboxSensorEntityDescription(
		key="uptime",
		translation_key="uptime",
		value_fn=_section("server", "uptime_seconds"),
		device_class=SensorDeviceClass.DURATION,
		native_unit_of_measurement=UnitOfTime.SECONDS,
		state_class=SensorStateClass.MEASUREMENT,
		suggested_display_precision=0,
		entity_category=EntityCategory.DIAGNOSTIC,
	),
	TellyboxSensorEntityDescription(
		key="cpu_usage",
		translation_key="cpu_usage",
		value_fn=_section("server", "cpu_percent"),
		native_unit_of_measurement=PERCENTAGE,
		state_class=SensorStateClass.MEASUREMENT,
		suggested_display_precision=1,
		entity_category=EntityCategory.DIAGNOSTIC,
	),
	TellyboxSensorEntityDescription(
		key="memory_usage",
		translation_key="memory_usage",
		value_fn=_section("server", "memory_percent"),
		native_unit_of_measurement=PERCENTAGE,
		state_class=SensorStateClass.MEASUREMENT,
		suggested_display_precision=1,
		entity_category=EntityCategory.DIAGNOSTIC,
	),
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
	"""Add the fixed sensors and one sensor per stable disk ID."""
	coordinator: TellyboxCoordinator = entry.runtime_data
	known_disks: set[str] = set()

	def add_disks() -> None:
		entities: list[TellyboxDiskSensor] = []
		for disk in (coordinator.data or {}).get("server", {}).get("disks", []):
			disk_id = disk.get("id")
			if not isinstance(disk_id, str) or not disk_id or disk_id in known_disks:
				continue
			known_disks.add(disk_id)
			entities.append(TellyboxDiskSensor(coordinator, entry, disk_id, disk.get("name") or "Disk"))
		if entities:
			async_add_entities(entities)

	add_disks()
	entry.async_on_unload(coordinator.async_add_listener(add_disks))
	async_add_entities([TellyboxSensor(coordinator, entry, description) for description in SENSORS])


class TellyboxSensor(TellyboxEntity, SensorEntity):
	"""One fixed aggregate sensor."""

	entity_description: TellyboxSensorEntityDescription

	def __init__(self, coordinator: TellyboxCoordinator, entry: ConfigEntry, description: TellyboxSensorEntityDescription) -> None:
		super().__init__(coordinator, entry)
		self.entity_description = description
		self._attr_unique_id = f"{entry.entry_id}_{description.key}"

	@property
	def native_value(self) -> float | int | None:
		return self.entity_description.value_fn(self.coordinator.data or {})

	@property
	def available(self) -> bool:
		return super().available and self.native_value is not None


class TellyboxDiskSensor(TellyboxEntity, SensorEntity):
	"""Available bytes for one disk, keyed by the server's stable disk ID."""

	_attr_device_class = SensorDeviceClass.DATA_SIZE
	_attr_native_unit_of_measurement = UnitOfInformation.BYTES
	_attr_state_class = SensorStateClass.MEASUREMENT
	_attr_suggested_display_precision = 1

	def __init__(self, coordinator: TellyboxCoordinator, entry: ConfigEntry, disk_id: str, name: str) -> None:
		super().__init__(coordinator, entry)
		self._disk_id = disk_id
		self._attr_name = f"{name} available space"
		self._attr_unique_id = f"{entry.entry_id}_disk_{disk_id}_available_bytes"

	def _disk(self) -> dict[str, Any] | None:
		for disk in (self.coordinator.data or {}).get("server", {}).get("disks", []):
			if disk.get("id") == self._disk_id:
				return disk
		return None

	@property
	def native_value(self) -> float | int | None:
		disk = self._disk()
		return None if disk is None else disk.get("available_bytes")

	@property
	def available(self) -> bool:
		return super().available and self.native_value is not None
