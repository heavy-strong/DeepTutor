"""Capability and context-window discovery for local LLM servers.

:mod:`local_provider` only lists model ids. Local servers usually know a lot
more about what they serve — Ollama's ``/api/show`` reports a ``capabilities``
list (``tools``, ``vision``, ``thinking``) plus the model's trained context
length, and LM Studio's ``/api/v0/models`` reports the model type (``vlm`` for
vision) and ``max_context_length``. Reading that lets Settings pre-fill the
per-model capability overrides instead of leaving every local model in the
"tools off, vision off" default that turns the agent loop into prose mode.

When the server exposes nothing, a conservative model-family heuristic fills
in ``tools`` / ``vision`` for the well-known open-weight families; anything
unknown stays unset so the built-in tables keep deciding.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import logging
import re
from typing import Any

import aiohttp

from .utils import build_auth_headers, collect_model_names, is_local_llm_server

logger = logging.getLogger(__name__)

# Ollama detail fetches run in parallel but bounded; a machine with dozens of
# pulled models should not hammer a server that is also serving inference.
_SHOW_CONCURRENCY = 4
_SHOW_LIMIT = 64

# Model families that ship a tool-calling chat template and behave well with
# OpenAI-style ``tools`` on Ollama / LM Studio / vLLM / llama.cpp. Matched as a
# substring of the lower-cased model id (``qwen3:8b``, ``hf.co/.../Qwen3-8B``).
_TOOL_CAPABLE_FAMILIES: tuple[str, ...] = (
    "qwen3",
    "qwen2.5",
    "qwq",
    "llama3.1",
    "llama3.2",
    "llama3.3",
    "llama-3.1",
    "llama-3.2",
    "llama-3.3",
    "llama4",
    "llama-4",
    "mistral",
    "mixtral",
    "magistral",
    "devstral",
    "hermes",
    "gpt-oss",
    "gemma3",
    "gemma-3",
    "phi-4",
    "phi4",
    "command-r",
    "command-a",
    "granite3",
    "granite-3",
    "granite4",
    "granite-4",
    "glm-4",
    "glm4",
    "deepseek-v3",
    "deepseek-r1",
    "kimi",
    "nemotron",
    "smollm3",
    "functionary",
    "firefunction",
)

# Families whose only tool story is prompt emulation; some of these appear as
# a prefix of a tool-capable family above (``llama3`` vs ``llama3.1``), so the
# exclusions are checked first.
_TOOL_INCAPABLE_FAMILIES: tuple[str, ...] = (
    "llama3:",
    "llama3-",
    "llama-3-",
    "llama2",
    "llama-2",
    "gemma2",
    "gemma-2",
    "gemma:",
    "phi3",
    "phi-3",
    "tinyllama",
    "codellama",
    "dolphin-llama3:",
    "vicuna",
    "orca",
)

# Multimodal families. ``gemma3`` is vision-capable except the 1B text model,
# handled below.
_VISION_FAMILIES: tuple[str, ...] = (
    "llava",
    "bakllava",
    "moondream",
    "minicpm-v",
    "llama3.2-vision",
    "llama-3.2-vision",
    "llama4",
    "llama-4",
    "qwen2.5vl",
    "qwen2.5-vl",
    "qwen3-vl",
    "qwen3vl",
    "qwen-vl",
    "gemma3",
    "gemma-3",
    "mistral-small3.1",
    "mistral-small3.2",
    "mistral-small-3.1",
    "mistral-small-3.2",
    "pixtral",
    "granite3.2-vision",
    "granite-vision",
    "internvl",
    "phi-4-multimodal",
    "phi4-multimodal",
)
_VISION_EXCLUSIONS: tuple[str, ...] = ("gemma3:1b", "gemma-3-1b", "gemma3n")

# Ollama ``/api/show`` puts the trained context length under
# ``model_info["<architecture>.context_length"]``.
_CONTEXT_LENGTH_KEY = re.compile(r"(^|\.)context_length$")
_NUM_CTX_LINE = re.compile(r"^\s*num_ctx\s+(\d+)\s*$", re.MULTILINE)


@dataclass(frozen=True)
class LocalModelInfo:
    """What a local server told us about one model it serves."""

    id: str
    #: ``tools`` / ``vision`` / ``thinking`` → bool. Missing keys mean unknown.
    capabilities: dict[str, bool] = field(default_factory=dict)
    #: Trained / maximum context length the model supports, when known.
    context_window: int | None = None
    #: Context length actually configured for inference (Ollama ``num_ctx``,
    #: LM Studio ``loaded_context_length``), when the server exposes it.
    loaded_context_window: int | None = None
    #: ``ollama`` / ``lm_studio`` / ``openai_compat`` — where the answer came from.
    source: str = "openai_compat"

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"id": self.id, "name": self.id, "source": self.source}
        if self.capabilities:
            payload["capabilities"] = dict(self.capabilities)
        if self.context_window:
            payload["context_window"] = self.context_window
        if self.loaded_context_window:
            payload["loaded_context_window"] = self.loaded_context_window
        return payload


# ---------------------------------------------------------------------------
# Server-kind detection
# ---------------------------------------------------------------------------


def local_server_kind(base_url: str, binding: str | None = None) -> str:
    """Return ``ollama`` / ``lm_studio`` / ``openai_compat`` for a local base URL."""
    binding_lower = (binding or "").strip().lower()
    if binding_lower == "ollama":
        return "ollama"
    if binding_lower in {"lm_studio", "lmstudio"}:
        return "lm_studio"
    url_lower = (base_url or "").lower()
    if ":11434" in url_lower or "ollama" in url_lower:
        return "ollama"
    if ":1234" in url_lower or "lmstudio" in url_lower or "lm-studio" in url_lower:
        return "lm_studio"
    return "openai_compat"


def _server_root(base_url: str) -> str:
    """Strip a trailing ``/v1`` so native endpoints can be addressed."""
    root = (base_url or "").strip().rstrip("/")
    if root.endswith("/v1"):
        root = root[: -len("/v1")]
    return root


# ---------------------------------------------------------------------------
# Name heuristics
# ---------------------------------------------------------------------------


def _bare_model_name(model: str) -> str:
    """``hf.co/org/Qwen3-8B-GGUF:Q4_K_M`` → ``qwen3-8b-gguf:q4_k_m``."""
    name = (model or "").strip().lower()
    if "/" in name:
        name = name.rsplit("/", 1)[-1]
    return name


def infer_capabilities_from_name(model: str) -> dict[str, bool]:
    """Best-effort ``tools`` / ``vision`` guess from a model id.

    Only families with a known answer are returned; an unknown family yields
    an empty dict so the caller can leave the capability undeclared.
    """
    name = _bare_model_name(model)
    if not name:
        return {}
    caps: dict[str, bool] = {}

    if any(marker in name for marker in _TOOL_INCAPABLE_FAMILIES):
        caps["tools"] = False
    elif any(marker in name for marker in _TOOL_CAPABLE_FAMILIES):
        caps["tools"] = True

    if any(marker in name for marker in _VISION_EXCLUSIONS):
        caps["vision"] = False
    elif any(marker in name for marker in _VISION_FAMILIES):
        caps["vision"] = True
    elif any(marker in name for marker in ("vision", "-vl", "vl:", "multimodal")):
        caps["vision"] = True
    return caps


def is_known_tool_capable_local_model(model: str | None) -> bool:
    """True when the model id names a family known to handle native tools."""
    return infer_capabilities_from_name(model or "").get("tools") is True


# ---------------------------------------------------------------------------
# Payload parsing (pure, unit-testable)
# ---------------------------------------------------------------------------


def _coerce_int(value: Any) -> int | None:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def parse_ollama_show(model: str, payload: Any) -> LocalModelInfo:
    """Turn an Ollama ``/api/show`` response into :class:`LocalModelInfo`."""
    caps: dict[str, bool] = {}
    context_window: int | None = None
    loaded: int | None = None
    if isinstance(payload, dict):
        listed = payload.get("capabilities")
        if isinstance(listed, list):
            names = {str(item).strip().lower() for item in listed}
            # Ollama only lists what the model has; absence is a definite "no"
            # once the server reports the list at all.
            caps["tools"] = "tools" in names
            caps["vision"] = "vision" in names
            caps["thinking"] = "thinking" in names
        info = payload.get("model_info")
        if isinstance(info, dict):
            for key, value in info.items():
                if _CONTEXT_LENGTH_KEY.search(str(key)):
                    context_window = _coerce_int(value)
                    if context_window:
                        break
        parameters = payload.get("parameters")
        if isinstance(parameters, str):
            match = _NUM_CTX_LINE.search(parameters)
            if match:
                loaded = _coerce_int(match.group(1))
    if not caps:
        caps = infer_capabilities_from_name(model)
    return LocalModelInfo(
        id=model,
        capabilities=caps,
        context_window=context_window,
        loaded_context_window=loaded,
        source="ollama",
    )


def parse_ollama_ps(payload: Any) -> dict[str, int]:
    """Map running model names to their effective ``context_length`` from ``/api/ps``."""
    running: dict[str, int] = {}
    if not isinstance(payload, dict):
        return running
    for item in payload.get("models") or []:
        if not isinstance(item, dict):
            continue
        length = _coerce_int(item.get("context_length"))
        if not length:
            continue
        for key in ("name", "model"):
            name = str(item.get(key) or "").strip()
            if name:
                running[name] = length
    return running


def parse_lm_studio_models(payload: Any) -> list[LocalModelInfo]:
    """Turn an LM Studio ``/api/v0/models`` response into model infos."""
    infos: list[LocalModelInfo] = []
    items = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        return infos
    for item in items:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "").strip()
        if not model_id:
            continue
        kind = str(item.get("type") or "").strip().lower()
        if kind == "embeddings":
            continue
        caps = infer_capabilities_from_name(model_id)
        if kind == "vlm":
            caps["vision"] = True
        elif kind == "llm" and "vision" not in caps:
            caps["vision"] = False
        infos.append(
            LocalModelInfo(
                id=model_id,
                capabilities=caps,
                context_window=_coerce_int(item.get("max_context_length")),
                loaded_context_window=_coerce_int(item.get("loaded_context_length")),
                source="lm_studio",
            )
        )
    return infos


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------


async def _get_json(session: aiohttp.ClientSession, url: str, headers: dict[str, str]) -> Any:
    async with session.get(url, headers=headers) as resp:
        if resp.status != 200:
            return None
        return await resp.json()


async def _post_json(
    session: aiohttp.ClientSession, url: str, headers: dict[str, str], body: dict[str, Any]
) -> Any:
    async with session.post(url, headers=headers, json=body) as resp:
        if resp.status != 200:
            return None
        return await resp.json()


async def _fetch_ollama(
    session: aiohttp.ClientSession, base_url: str, headers: dict[str, str]
) -> list[LocalModelInfo]:
    root = _server_root(base_url)
    tags = await _get_json(session, f"{root}/api/tags", headers)
    names = collect_model_names(tags.get("models") or []) if isinstance(tags, dict) else []
    if not names:
        return []

    running: dict[str, int] = {}
    try:
        running = parse_ollama_ps(await _get_json(session, f"{root}/api/ps", headers))
    except Exception as exc:  # noqa: BLE001 — /api/ps is optional detail
        logger.debug("Ollama /api/ps failed for %s: %s", root, exc)

    semaphore = asyncio.Semaphore(_SHOW_CONCURRENCY)

    async def show(name: str) -> LocalModelInfo:
        async with semaphore:
            try:
                payload = await _post_json(
                    session, f"{root}/api/show", headers, {"model": name, "name": name}
                )
            except Exception as exc:  # noqa: BLE001 — degrade to name heuristics
                logger.debug("Ollama /api/show failed for %s: %s", name, exc)
                payload = None
        info = parse_ollama_show(name, payload)
        loaded = running.get(name) or info.loaded_context_window
        if loaded != info.loaded_context_window:
            info = LocalModelInfo(
                id=info.id,
                capabilities=info.capabilities,
                context_window=info.context_window,
                loaded_context_window=loaded,
                source=info.source,
            )
        return info

    detailed = await asyncio.gather(*(show(name) for name in names[:_SHOW_LIMIT]))
    # Anything past the detail limit still gets listed, with heuristics only.
    rest = [
        LocalModelInfo(id=name, capabilities=infer_capabilities_from_name(name), source="ollama")
        for name in names[_SHOW_LIMIT:]
    ]
    return [*detailed, *rest]


async def _fetch_lm_studio(
    session: aiohttp.ClientSession, base_url: str, headers: dict[str, str]
) -> list[LocalModelInfo]:
    root = _server_root(base_url)
    try:
        payload = await _get_json(session, f"{root}/api/v0/models", headers)
    except Exception as exc:  # noqa: BLE001 — older LM Studio lacks /api/v0
        logger.debug("LM Studio /api/v0/models failed for %s: %s", root, exc)
        payload = None
    return parse_lm_studio_models(payload) if payload is not None else []


async def _fetch_openai_compat(
    session: aiohttp.ClientSession, base_url: str, headers: dict[str, str]
) -> list[LocalModelInfo]:
    payload = await _get_json(session, f"{base_url.rstrip('/')}/models", headers)
    entries: list[Any]
    if isinstance(payload, dict):
        entries = payload.get("data") or payload.get("models") or []
    elif isinstance(payload, list):
        entries = payload
    else:
        entries = []
    return [
        LocalModelInfo(id=name, capabilities=infer_capabilities_from_name(name))
        for name in collect_model_names(entries)
    ]


async def fetch_local_model_infos(
    base_url: str,
    api_key: str | None = None,
    *,
    binding: str | None = None,
) -> list[LocalModelInfo]:
    """List a local server's models together with what it reports about them.

    Falls back to the plain ``/models`` listing (with name heuristics) when the
    server-specific endpoint is unavailable, so the result is never worse than
    :func:`local_provider.fetch_models`.
    """
    base_url = (base_url or "").strip().rstrip("/")
    if not base_url:
        return []
    headers = build_auth_headers(api_key)
    headers.pop("Content-Type", None)
    kind = local_server_kind(base_url, binding)
    timeout = aiohttp.ClientTimeout(total=30)

    async with aiohttp.ClientSession(timeout=timeout) as session:
        infos: list[LocalModelInfo] = []
        if kind == "ollama":
            try:
                infos = await _fetch_ollama(session, base_url, headers)
            except Exception as exc:  # noqa: BLE001 — fall through to /models
                logger.debug("Ollama discovery failed for %s: %s", base_url, exc)
        elif kind == "lm_studio":
            infos = await _fetch_lm_studio(session, base_url, headers)
        if infos:
            return infos
        try:
            return await _fetch_openai_compat(session, base_url, headers)
        except Exception as exc:  # noqa: BLE001 — surface as empty list
            logger.error("Error fetching models from %s: %s", base_url, exc)
            return []


async def fetch_local_model_info(
    base_url: str,
    model: str,
    api_key: str | None = None,
    *,
    binding: str | None = None,
) -> LocalModelInfo | None:
    """Details for one model — used by the settings test run for the active model."""
    base_url = (base_url or "").strip().rstrip("/")
    if not base_url or not model or not is_local_llm_server(base_url):
        return None
    headers = build_auth_headers(api_key)
    headers.pop("Content-Type", None)
    kind = local_server_kind(base_url, binding)
    timeout = aiohttp.ClientTimeout(total=12)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            if kind == "ollama":
                root = _server_root(base_url)
                payload = await _post_json(
                    session, f"{root}/api/show", headers, {"model": model, "name": model}
                )
                if payload is None:
                    return None
                info = parse_ollama_show(model, payload)
                try:
                    running = parse_ollama_ps(await _get_json(session, f"{root}/api/ps", headers))
                except Exception:  # noqa: BLE001 — optional detail
                    running = {}
                loaded = running.get(model) or info.loaded_context_window
                return LocalModelInfo(
                    id=info.id,
                    capabilities=info.capabilities,
                    context_window=info.context_window,
                    loaded_context_window=loaded,
                    source=info.source,
                )
            if kind == "lm_studio":
                for info in await _fetch_lm_studio(session, base_url, headers):
                    if info.id == model:
                        return info
                return None
    except Exception as exc:  # noqa: BLE001 — discovery is best effort
        logger.debug("Local model detail lookup failed for %s on %s: %s", model, base_url, exc)
    return None


__all__ = [
    "LocalModelInfo",
    "fetch_local_model_info",
    "fetch_local_model_infos",
    "infer_capabilities_from_name",
    "is_known_tool_capable_local_model",
    "local_server_kind",
    "parse_lm_studio_models",
    "parse_ollama_ps",
    "parse_ollama_show",
]
