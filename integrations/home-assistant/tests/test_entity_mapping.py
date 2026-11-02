"""Static checks that entity translation keys are documented and read-only."""

from __future__ import annotations

import ast
import json
import pathlib
import unittest

COMPONENT = pathlib.Path(__file__).resolve().parents[1] / "custom_components" / "tellybox"


def translation_keys(path: pathlib.Path) -> set[str]:
	tree = ast.parse(path.read_text(encoding="utf-8"))
	keys: set[str] = set()
	for node in ast.walk(tree):
		if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name) or node.func.id != "TellyboxSensorEntityDescription":
			continue
		for keyword in node.keywords:
			if keyword.arg == "translation_key" and isinstance(keyword.value, ast.Constant):
				keys.add(keyword.value.value)
	return keys


class EntityMappingTests(unittest.TestCase):
	def test_every_sensor_and_binary_sensor_translation_key_has_a_name(self) -> None:
		strings = json.loads((COMPONENT / "strings.json").read_text(encoding="utf-8"))
		sensor_keys = translation_keys(COMPONENT / "sensor.py")
		self.assertEqual(sensor_keys, {
			"active_streams", "connected_streams", "local_streams", "remote_streams",
			"active_downloads", "measured_remote_upload", "configured_upload_limit",
			"uptime", "cpu_usage", "memory_usage",
		})
		for key in sensor_keys:
			self.assertIn("name", strings["entity"]["sensor"][key], key)
		binary = (COMPONENT / "binary_sensor.py").read_text(encoding="utf-8")
		self.assertIn('_attr_translation_key = "online"', binary)
		self.assertIn("name", strings["entity"]["binary_sensor"]["online"])

	def test_first_version_has_no_media_player_switch_or_button_platform(self) -> None:
		for path in COMPONENT.glob("*.py"):
			source = path.read_text(encoding="utf-8")
			for forbidden in ("media_player", "switch", "button", "remote"):
				self.assertNotIn(f"components.{forbidden}", source, f"{path.name}: {forbidden}")

	def test_integration_never_calls_a_viewer_or_admin_activity_route(self) -> None:
		for path in COMPONENT.glob("*.py"):
			source = path.read_text(encoding="utf-8")
			for forbidden in ("/api/activity", "/api/apps", "/api/auth", "/stream/"):
				self.assertNotIn(forbidden, source, f"{path.name}: {forbidden}")


if __name__ == "__main__":
	unittest.main()
