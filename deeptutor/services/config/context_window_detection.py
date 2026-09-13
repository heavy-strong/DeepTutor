"""Detect or suggest a model context window during settings diagnostics."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
import logging
from typing import Any

import aiohttp

from deeptutor.services.keypool import primary_api_key
from deeptutor.services.llm.config import LLMConfig
from deeptutor.services.llm.context_window import (
    coerce_positive_int,
    default_context_window_for_model,
)
from deeptutor.services.llm.local_model_info import fetch_local_model_info
from deeptutor.services.llm.openai_http_client import disable_ssl_verify_enabled
from deeptutor.services.llm.utils import build_auth_headers, is_local_llm_server

logger = logging.getLogger(__name__)

_CONTEXT_WINDOW_KEYS = (
    "context_window",
    "context_window_tokens",
    "context_length",
    "context_size",
    "max_context_tokens",
    "max_input_tokens",
    "input_token_limit",
    "max_prompt_tokens",
    "max_model_len",
    "max_sequence_length",
    "n_ctx",
)

_KNOWN_CONTEXT_WINDOWS: tuple[tuple[str, int], ...] = (
    ("deepseek-v4", 1_000_000),
    ("minimax-m3", 1_000_000),
    ("minimax-m2.7", 204_800),
)


# Below this, DeepTutor's system prompt plus a few tool results already fill
# the window; local servers (Ollama defaults to 4096) commonly sit here.
SMALL_LOCAL_CONTEXT_THRESHOLD = 16_384


@dataclass(frozen=True)
class ContextWindowDetectionResult:
    """Structured context-window detection output."""

    context_window: int
    source: str
    detail: str
    detected_at: str
    #: Human-readable warning when the effective window is smaller than the
    #: model could handle or too small for agentic use, with how to fix it.
    advisory: str | None = None


def _local_server_advisory(
    *,
    binding: str | None,
    model: str,
    model_window: int | None,
    loaded_window: int | None,
) -> str | None:
    """Explain a too-small local context window and how to raise it."""
    effective = loaded_window or model_window
    if effective is None or effective >= SMALL_LOCAL_CONTEXT_THRESHOLD:
        if loaded_window and model_window and loaded_window < model_window:
            return (
                f"The server runs `{model}` with a {loaded_window:,}-token context although the "
                f"model supports {model_window:,}. Raise it if longer documents get truncated."
            )
        return None
    if (binding or "").lower() == "ollama":
        how = (
            "Raise it by starting Ollama with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`, "
            "or by creating a variant: `FROM {model}` + `PARAMETER num_ctx 32768` in a "
            "Modelfile, then `ollama create {model}-32k -f Modelfile`. The OpenAI-compatible "
            "endpoint DeepTutor uses cannot set it per request."
        ).format(model=model)
    else:
        how = "Raise the context length in the server's model settings and reload the model."
    return (
        f"The effective context window for `{model}` is only {effective:,} tokens. DeepTutor's "
        f"system prompt and tool results need more; answers will degrade or truncate. {how}"
    )


async def _detect_from_local_server(
    llm_config: LLMConfig,
    *,
    on_log: Callable[[str], None] | None = None,
) -> ContextWindowDetectionResult | None:
    """Ask Ollama / LM Studio directly; their ``/v1/models`` carries no metadata."""
    base_url = str(llm_config.base_url or llm_config.effective_url or "").strip()
    if not base_url or not is_local_llm_server(base_url):
        return None
    info = await fetch_local_model_info(
        base_url,
        llm_config.model,
        primary_api_key(llm_config.api_key),
        binding=llm_config.binding,
    )
    if info is None:
        if on_log is not None:
            on_log("Local server exposed no model metadata; falling back to `/models`.")
        return None
    window = info.loaded_context_window or info.context_window
    if not window:
        return None
    if on_log is not None and info.capabilities:
        reported = ", ".join(
            f"{key}={'yes' if value else 'no'}" for key, value in info.capabilities.items()
        )
        on_log(f"Server-reported capabilities for `{llm_config.model}`: {reported}.")
    detected_at = datetime.now(timezone.utc).isoformat()
    if info.loaded_context_window:
        detail = f"Effective context length reported by the {info.source} server."
    else:
        detail = f"Model context length reported by the {info.source} server."
    return ContextWindowDetectionResult(
        context_window=window,
        source="metadata",
        detail=detail,
        detected_at=detected_at,
        advisory=_local_server_advisory(
            binding=llm_config.binding,
            model=llm_config.model,
            model_window=info.context_window,
            loaded_window=info.loaded_context_window,
        ),
    )


def _model_aliases(model: str) -> set[str]:
    value = (model or "").strip().lower()
    if not value:
        return set()
    aliases = {value}
    if "/" in value:
        aliases.add(value.split("/", 1)[1])
    if ":" in value:
        aliases.add(value.split(":", 1)[1])
    return {item for item in aliases if item}


def _record_identities(item: Mapping[str, Any]) -> set[str]:
    aliases: set[str] = set()
    for key in ("id", "model", "name"):
        aliases.update(_model_aliases(str(item.get(key, "") or "")))
    return aliases


def _known_context_window(model: str) -> int | None:
    normalized = (model or "").strip().lower()
    if not normalized:
        return None
    for pattern, context_window in _KNOWN_CONTEXT_WINDOWS:
        if pattern in normalized:
            return context_window
    return None


def _recursive_context_window(value: Any) -> int | None:
    if isinstance(value, Mapping):
        for key in _CONTEXT_WINDOW_KEYS:
            parsed = coerce_positive_int(value.get(key))
            if parsed is not None:
                return parsed
        for nested in value.values():
            parsed = _recursive_context_window(nested)
            if parsed is not None:
                return parsed
    elif isinstance(value, list):
        for nested in value:
            parsed = _recursive_context_window(nested)
            if parsed is not None:
                return parsed
    return None


def _iter_model_records(payload: Any) -> Iterable[Mapping[str, Any]]:
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, Mapping):
                yield item
        return
    if not isinstance(payload, Mapping):
        return
    for key in ("data", "models", "result", "items"):
        items = payload.get(key)
        if isinstance(items, list):
            for item in items:
                if isinstance(item, Mapping):
                    yield item


def _extract_context_window_from_payload(payload: Any, model: str) -> int | None:
    target_aliases = _model_aliases(model)
    if not target_aliases:
        return None

    exact_matches: list[Mapping[str, Any]] = []
    partial_matches: list[Mapping[str, Any]] = []
    for item in _iter_model_records(payload):
        identities = _record_identities(item)
        if not identities:
            continue
        if identities & target_aliases:
            exact_matches.append(item)
            continue
        if any(
            item_identity.endswith(f"/{alias}") or alias.endswith(f"/{item_identity}")
            for item_identity in identities
            for alias in target_aliases
        ):
            partial_matches.append(item)

    for item in [*exact_matches, *partial_matches]:
        parsed = _recursive_context_window(item)
        if parsed is not None:
            return parsed
    return None


async def _detect_from_models_endpoint(
    llm_config: LLMConfig,
    *,
    on_log: Callable[[str], None] | None = None,
) -> int | None:
    base_url = str(llm_config.base_url or llm_config.effective_url or "").strip()
    if not base_url:
        return None

    url = f"{base_url.rstrip('/')}/models"
    headers = build_auth_headers(primary_api_key(llm_config.api_key), llm_config.binding)
    headers.pop("Content-Type", None)

    timeout = aiohttp.ClientTimeout(total=12)
    connector = aiohttp.TCPConnector(ssl=False) if disable_ssl_verify_enabled() else None
    try:
        async with aiohttp.ClientSession(
            timeout=timeout,
            connector=connector,
            trust_env=True,
        ) as session:
            async with session.get(url, headers=headers) as response:
                if response.status != 200:
                    if on_log is not None:
                        on_log(
                            f"`GET {url}` returned HTTP {response.status}; skipping metadata detection."
                        )
                    return None
                payload = await response.json()
    except Exception as exc:
        logger.debug("Context-window metadata request failed for %s: %s", url, exc)
        if on_log is not None:
            on_log(f"Could not read `{url}` for context-window metadata: {exc}")
        return None

    return _extract_context_window_from_payload(payload, llm_config.model)


async def detect_context_window(
    llm_config: LLMConfig,
    *,
    on_log: Callable[[str], None] | None = None,
) -> ContextWindowDetectionResult:
    """Detect the current model's context window or fall back to the runtime default."""
    detected_at = datetime.now(timezone.utc).isoformat()
    local_result = await _detect_from_local_server(llm_config, on_log=on_log)
    if local_result is not None:
        return local_result
    metadata_window = await _detect_from_models_endpoint(llm_config, on_log=on_log)
    if metadata_window is not None:
        return ContextWindowDetectionResult(
            context_window=metadata_window,
            source="metadata",
            detail="Detected from provider `/models` metadata.",
            detected_at=detected_at,
        )

    known_window = _known_context_window(llm_config.model)
    if known_window is not None:
        return ContextWindowDetectionResult(
            context_window=known_window,
            source="known_model",
            detail="Matched built-in context-window metadata for this model family.",
            detected_at=detected_at,
        )

    fallback = default_context_window_for_model(
        model=llm_config.model,
        max_tokens=llm_config.max_tokens,
    )
    return ContextWindowDetectionResult(
        context_window=fallback,
        source="default",
        detail="Provider metadata did not expose a window; using the runtime fallback.",
        detected_at=detected_at,
    )


__all__ = [
    "SMALL_LOCAL_CONTEXT_THRESHOLD",
    "ContextWindowDetectionResult",
    "detect_context_window",
]
