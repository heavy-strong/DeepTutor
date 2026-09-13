"""Helpers for resolving per-partner LLM model selection."""

from __future__ import annotations

import logging
from typing import Any

from deeptutor.services.llm.config import LLMConfig
from deeptutor.services.model_selection import LLMSelection, apply_llm_selection_to_catalog
from deeptutor.services.model_selection.runtime import resolve_llm_config_for_selection

logger = logging.getLogger(__name__)


def normalize_partner_llm_selection(value: Any) -> dict[str, str] | None:
    """Return a validated selection dict, or ``None`` for system default."""
    selection = LLMSelection.from_payload(value)
    return selection.to_dict() if selection else None


def resolve_partner_llm_config(partner_config: Any) -> LLMConfig:
    """Resolve the effective LLM config for a partner config object.

    Configs store ``llm_selection`` as a stable catalog reference. Configs
    migrated from TutorBot may still carry a raw ``model`` string, which is
    applied as a model-only override on top of the system default provider.
    """
    selection = normalize_partner_llm_selection(getattr(partner_config, "llm_selection", None))
    if selection:
        return resolve_llm_config_for_selection(selection)

    base = resolve_llm_config_for_selection(None)
    legacy_model = str(getattr(partner_config, "model", "") or "").strip()
    if legacy_model:
        return base.model_copy(update={"model": legacy_model})
    return base


def partner_llm_selection_available(selection: dict[str, str] | None) -> bool:
    """Whether *selection* still names a model in the current catalog.

    A partner stores its selection as catalog ids, and a model re-saved in
    Settings gets a fresh id — so the stored reference can go stale while the
    partner keeps its old one. ``None`` (system default) is always available.
    """
    if not selection:
        return True
    from deeptutor.multi_user.personal_models import merge_personal_llm_profiles
    from deeptutor.services.config import get_model_catalog_service

    try:
        apply_llm_selection_to_catalog(
            merge_personal_llm_profiles(get_model_catalog_service().load()),
            selection,
        )
    except ValueError:
        return False
    return True


def effective_partner_llm_selections(
    partner_config: Any,
) -> tuple[dict[str, str] | None, dict[str, str] | None]:
    """``(primary, backup)`` to actually run with, skipping stale references.

    A stale primary falls through to the backup, and a stale backup to the
    system default (``None``), so a catalog edit degrades the partner to the
    default model with a warning instead of failing every turn with
    "selected profile/model was not found".
    """
    name = str(getattr(partner_config, "name", "") or "partner")
    primary = getattr(partner_config, "llm_selection", None) or None
    backup = getattr(partner_config, "backup_llm_selection", None) or None

    primary_stale = bool(primary) and not partner_llm_selection_available(primary)
    if primary_stale:
        logger.warning(
            "Partner %s: configured model %s/%s is no longer in the catalog; "
            "falling back to %s",
            name,
            primary.get("profile_id"),
            primary.get("model_id"),
            "the backup model" if backup else "the system default",
        )
        primary = None
    if backup and not partner_llm_selection_available(backup):
        logger.warning(
            "Partner %s: backup model %s/%s is no longer in the catalog; ignoring it",
            name,
            backup.get("profile_id"),
            backup.get("model_id"),
        )
        backup = None
    if primary_stale and backup is not None:
        # The backup is the only valid pin left: promote it so the turn starts
        # on a model the owner chose, with the system default as its safety
        # net. An intentionally unset primary keeps the default-first order.
        primary, backup = backup, None
    return primary, backup


__all__ = [
    "effective_partner_llm_selections",
    "normalize_partner_llm_selection",
    "partner_llm_selection_available",
    "resolve_partner_llm_config",
]
