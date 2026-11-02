"""Config and reauthentication flow for the read-only Tellybox integration."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

import probatio

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import TextSelector, TextSelectorConfig, TextSelectorType

from .api import TellyboxApi, TellyboxApiError, TellyboxAuthError, TellyboxConnectionError
from .const import CONF_TOKEN, CONF_URL, DOMAIN
from .stats import normalize_server_url, normalize_token

STEP_USER_SCHEMA = probatio.Schema({
	probatio.Required(CONF_URL): TextSelector(TextSelectorConfig(type=TextSelectorType.URL)),
	probatio.Required(CONF_TOKEN): TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD)),
})


def _title(url: str) -> str:
	host = urlsplit(url).netloc or "server"
	return f"Tellybox ({host})"


class TellyboxConfigFlow(ConfigFlow, domain=DOMAIN):
	"""Ask for the server address and a dedicated read-only token."""

	VERSION = 1

	async def _async_validate(self, user_input: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, str]]:
		errors: dict[str, str] = {}
		try:
			url = normalize_server_url(user_input.get(CONF_URL))
		except ValueError:
			errors["base"] = "invalid_url"
		try:
			token = normalize_token(user_input.get(CONF_TOKEN))
		except ValueError:
			errors["base"] = "invalid_token"
		if errors:
			return None, errors
		api = TellyboxApi(async_get_clientsession(self.hass), url, token)
		try:
			stats = await api.async_get_stats()
		except TellyboxAuthError:
			return None, {"base": "invalid_auth"}
		except TellyboxConnectionError:
			return None, {"base": "cannot_connect"}
		except TellyboxApiError:
			return None, {"base": "invalid_response"}
		return {CONF_URL: url, CONF_TOKEN: token, "_installation_id": stats["installation_id"]}, {}

	async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
		"""Add a Tellybox installation."""
		errors: dict[str, str] = {}
		if user_input is not None:
			data, errors = await self._async_validate(user_input)
			if data is not None:
				installation_id = data.pop("_installation_id")
				await self.async_set_unique_id(f"tellybox_{installation_id}")
				self._abort_if_unique_id_configured()
				return self.async_create_entry(title=_title(data[CONF_URL]), data=data)
		return self.async_show_form(step_id="user", data_schema=STEP_USER_SCHEMA, errors=errors)

	async def async_step_reauth(self, entry_data: dict[str, Any]) -> ConfigFlowResult:
		"""Start reauthentication after the token is revoked or rotated."""
		return await self.async_step_reauth_confirm()

	async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
		"""Validate a replacement token and keep the same installation identity."""
		errors: dict[str, str] = {}
		if user_input is not None:
			data, errors = await self._async_validate(user_input)
			if data is not None:
				installation_id = data.pop("_installation_id")
				await self.async_set_unique_id(f"tellybox_{installation_id}")
				self._abort_if_unique_id_mismatch(reason="wrong_installation")
				return self.async_update_reload_and_abort(self._get_reauth_entry(), data_updates=data)
		return self.async_show_form(step_id="reauth_confirm", data_schema=STEP_USER_SCHEMA, errors=errors)
