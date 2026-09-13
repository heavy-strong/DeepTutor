"""A partner's stored model ids must not strand it when the catalog changes."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from deeptutor.services.partners import model_runtime

CATALOG = {
    "services": {
        "llm": {
            "active_profile_id": "llm-profile-default",
            "active_model_id": "m-live",
            "profiles": [
                {
                    "id": "llm-profile-default",
                    "binding": "openai",
                    "models": [
                        {"id": "m-live", "model": "gpt-x"},
                        {"id": "m-backup", "model": "gpt-y"},
                    ],
                }
            ],
        }
    }
}

LIVE = {"profile_id": "llm-profile-default", "model_id": "m-live"}
BACKUP = {"profile_id": "llm-profile-default", "model_id": "m-backup"}
STALE = {"profile_id": "llm-profile-default", "model_id": "m-gone"}


@pytest.fixture(autouse=True)
def _catalog(monkeypatch):
    from deeptutor.multi_user import personal_models
    from deeptutor.services import config as config_module

    monkeypatch.setattr(
        config_module,
        "get_model_catalog_service",
        lambda: SimpleNamespace(load=lambda: CATALOG),
    )
    monkeypatch.setattr(personal_models, "merge_personal_llm_profiles", lambda catalog: catalog)


def _config(primary=None, backup=None):
    return SimpleNamespace(name="ada", llm_selection=primary, backup_llm_selection=backup)


def test_valid_selections_pass_through():
    assert model_runtime.effective_partner_llm_selections(_config(LIVE, BACKUP)) == (LIVE, BACKUP)
    assert model_runtime.effective_partner_llm_selections(_config()) == (None, None)


def test_stale_primary_without_backup_falls_back_to_system_default(caplog):
    with caplog.at_level("WARNING"):
        assert model_runtime.effective_partner_llm_selections(_config(STALE)) == (None, None)
    assert "no longer in the catalog" in caplog.text


def test_stale_primary_promotes_valid_backup():
    assert model_runtime.effective_partner_llm_selections(_config(STALE, BACKUP)) == (BACKUP, None)


def test_stale_backup_is_dropped():
    assert model_runtime.effective_partner_llm_selections(_config(LIVE, STALE)) == (LIVE, None)
