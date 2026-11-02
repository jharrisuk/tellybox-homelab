"""Pure parser and URL tests. They do not need a running Home Assistant."""

from __future__ import annotations

import pathlib
import sys
import types
import unittest

# Load the pure modules without executing the Home Assistant-dependent package
# __init__, so these parser tests need no Home Assistant installation.
COMPONENT = pathlib.Path(__file__).resolve().parents[1] / "custom_components" / "tellybox"
PACKAGE = types.ModuleType("tellybox_pure")
PACKAGE.__path__ = [str(COMPONENT)]
sys.modules[PACKAGE.__name__] = PACKAGE

from tellybox_pure.stats import (  # noqa: E402
	StatsFormatError,
	normalize_server_url,
	normalize_token,
	parse_stats,
)

VALID = {
	"schema": "tellybox.home-assistant.stats",
	"schemaVersion": 1,
	"generatedAt": 1760000000000,
	"installationId": "00000000-0000-0000-0000-000000000000",
	"server": {
		"version": "0.26.5",
		"hostStatus": "ok",
		"sampledAt": 1760000000000,
		"uptimeSeconds": 3600,
		"hostUptimeSeconds": 86400,
		"cpuPercent": 12.5,
		"memoryPercent": 42.1,
		"memoryTotalBytes": 17179869184,
		"memoryAvailableBytes": 9946625843,
		"disks": [
			{"id": "0123456789abcdef", "name": "Media", "availableBytes": 500, "totalBytes": 1000, "usedBytes": 500},
			{"id": "bad id with spaces", "name": "Ignored?", "availableBytes": 1},
		],
		"email": "do-not-expose@example.test",
	},
	"streams": {"active": 1, "connected": 2, "paused": 1, "local": 1, "remote": 1},
	"downloads": {"active": 0},
	"upload": {"configuredMbps": 50, "unlimited": False, "measuredMbps": 3.25, "measurementSeconds": 10},
	"title": "do-not-expose",
}


class UrlTests(unittest.TestCase):
	def test_accepts_http_and_https_and_removes_a_trailing_slash(self) -> None:
		self.assertEqual(normalize_server_url("http://192.168.1.50:8082/"), "http://192.168.1.50:8082")
		self.assertEqual(normalize_server_url("https://watch.example.test/tellybox/"), "https://watch.example.test/tellybox")

	def test_rejects_unsafe_or_incomplete_addresses(self) -> None:
		for value in ["", "192.168.1.50:8082", "file:///etc/passwd", "ftp://example.test", "http://user:secret@example.test", "http://example.test/?token=x", "http://example.test/#fragment", "http://example.test:99999", "http://exa mple.test", "http://example.test/\n"]:
			with self.subTest(value=value):
				with self.assertRaises(ValueError):
					normalize_server_url(value)

	def test_token_shape(self) -> None:
		self.assertEqual(normalize_token("a" * 64), "a" * 64)
		self.assertEqual(normalize_token("  " + "a" * 64 + "\n"), "a" * 64)
		for value in ["", "short", "a" * 31, "a" * 257, "a b" * 32, None]:
			with self.subTest(value=value):
				with self.assertRaises(ValueError):
					normalize_token(value)


class ParserTests(unittest.TestCase):
	def test_returns_only_allowlisted_fields(self) -> None:
		data = parse_stats(VALID)
		self.assertEqual(data["installation_id"], VALID["installationId"])
		self.assertEqual(data["server"]["cpu_percent"], 12.5)
		self.assertEqual(data["server"]["memory_percent"], 42.1)
		self.assertEqual(len(data["server"]["disks"]), 1)
		self.assertEqual(data["server"]["disks"][0]["available_bytes"], 500)
		self.assertEqual(data["streams"], {"active": 1, "connected": 2, "paused": 1, "local": 1, "remote": 1})
		self.assertEqual(data["downloads"], {"active": 0})
		self.assertEqual(data["upload"]["configured_mbps"], 50)
		text = repr(data)
		for value in ["do-not-expose", "email", "title"]:
			self.assertNotIn(value, text)

	def test_missing_or_stale_metrics_stay_none(self) -> None:
		payload = {**VALID, "server": {**VALID["server"], "hostStatus": "stale", "cpuPercent": 5, "memoryPercent": 50, "hostUptimeSeconds": 10, "disks": [{"id": "d1", "name": "Media", "availableBytes": 100, "totalBytes": 200, "usedBytes": 100}]}}
		data = parse_stats(payload)
		self.assertEqual(data["server"]["host_status"], "stale")
		self.assertIsNone(data["server"]["cpu_percent"])
		self.assertIsNone(data["server"]["memory_percent"])
		self.assertIsNone(data["server"]["host_uptime_seconds"])
		self.assertIsNone(data["server"]["disks"][0]["available_bytes"])
		self.assertIsNone(data["server"]["disks"][0]["total_bytes"])
		self.assertEqual(data["streams"]["active"], 1)

	def test_never_turns_invalid_or_negative_numbers_into_zero(self) -> None:
		payload = {**VALID, "streams": {**VALID["streams"], "active": -1, "remote": None}, "upload": {"configuredMbps": 0, "measuredMbps": "bad", "measurementSeconds": True}}
		data = parse_stats(payload)
		self.assertIsNone(data["streams"]["active"])
		self.assertIsNone(data["streams"]["remote"])
		self.assertEqual(data["streams"]["local"], 1)
		self.assertEqual(data["upload"]["configured_mbps"], 0)
		self.assertIsNone(data["upload"]["measured_mbps"])
		self.assertIsNone(data["upload"]["measurement_seconds"])

	def test_unsafe_disk_names_are_replaced_without_dropping_the_stable_id(self) -> None:
		payload = {**VALID, "server": {**VALID["server"], "disks": [{"id": "d1", "name": "/private/path", "availableBytes": 1}]}}
		data = parse_stats(payload)
		self.assertEqual(data["server"]["disks"][0]["id"], "d1")
		self.assertEqual(data["server"]["disks"][0]["name"], "Disk")

	def test_rejects_unknown_schema_and_missing_identity(self) -> None:
		for payload in [{**VALID, "schemaVersion": 2}, {**VALID, "schema": "other"}, {**VALID, "installationId": ""}, {**VALID, "server": None}, "not an object"]:
			with self.subTest(payload=payload):
				with self.assertRaises(StatsFormatError):
					parse_stats(payload)


if __name__ == "__main__":
	unittest.main()
