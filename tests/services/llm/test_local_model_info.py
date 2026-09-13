"""Tests for local-server capability / context-window discovery."""

from __future__ import annotations

from collections.abc import Callable
from types import TracebackType
from typing import Any

from _pytest.monkeypatch import MonkeyPatch
import pytest

from deeptutor.services.llm import local_model_info
from deeptutor.services.llm.local_model_info import (
    fetch_local_model_info,
    fetch_local_model_infos,
    infer_capabilities_from_name,
    is_known_tool_capable_local_model,
    local_server_kind,
    parse_lm_studio_models,
    parse_ollama_ps,
    parse_ollama_show,
)


class _FakeResponse:
    def __init__(self, status: int, json_data: object) -> None:
        self.status = status
        self._json_data = json_data

    async def __aenter__(self):
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        return None

    async def json(self):
        return self._json_data


class _FakeSession:
    def __init__(self, route: Callable[[str, str, Any], _FakeResponse]) -> None:
        self._route = route
        self.calls: list[tuple[str, str, Any]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        return None

    def get(self, url: str, **_kwargs: object) -> _FakeResponse:
        self.calls.append(("GET", url, None))
        return self._route("GET", url, None)

    def post(self, url: str, json: Any = None, **_kwargs: object) -> _FakeResponse:
        self.calls.append(("POST", url, json))
        return self._route("POST", url, json)


def _install(monkeypatch: MonkeyPatch, route) -> _FakeSession:
    session = _FakeSession(route)
    monkeypatch.setattr(local_model_info.aiohttp, "ClientSession", lambda *a, **kw: session)
    return session


# ---------------------------------------------------------------------------
# Heuristics
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("qwen3:8b", {"tools": True}),
        ("hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M", {"tools": True}),
        ("llama3.1:8b-instruct-q4_K_M", {"tools": True}),
        ("llama3:8b", {"tools": False}),
        ("gemma3:4b", {"tools": True, "vision": True}),
        ("gemma3:1b", {"tools": True, "vision": False}),
        ("llava:13b", {"vision": True}),
        ("qwen2.5vl:7b", {"tools": True, "vision": True}),
        ("dolphin-llama3:8b", {"tools": False}),
        ("some-unknown-model", {}),
    ],
)
def test_infer_capabilities_from_name(model: str, expected: dict[str, bool]) -> None:
    assert infer_capabilities_from_name(model) == expected


def test_is_known_tool_capable_local_model() -> None:
    assert is_known_tool_capable_local_model("mistral-small3.2:24b")
    assert not is_known_tool_capable_local_model("unknown")
    assert not is_known_tool_capable_local_model(None)


def test_local_server_kind_prefers_binding_then_url() -> None:
    assert local_server_kind("http://localhost:8000/v1", "ollama") == "ollama"
    assert local_server_kind("http://localhost:11434/v1", None) == "ollama"
    assert local_server_kind("http://localhost:1234/v1", "vllm") == "lm_studio"
    assert local_server_kind("http://localhost:8000/v1", "vllm") == "openai_compat"


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------


def test_parse_ollama_show_reads_capabilities_and_context() -> None:
    payload = {
        "capabilities": ["completion", "tools", "thinking"],
        "model_info": {
            "general.architecture": "qwen3",
            "qwen3.context_length": 40960,
            "qwen3.embedding_length": 4096,
        },
        "parameters": 'num_ctx                        16384\nstop                           "<|im_end|>"',
    }
    info = parse_ollama_show("qwen3:8b", payload)

    assert info.capabilities == {"tools": True, "vision": False, "thinking": True}
    assert info.context_window == 40960
    assert info.loaded_context_window == 16384
    assert info.source == "ollama"


def test_parse_ollama_show_falls_back_to_name_heuristics() -> None:
    info = parse_ollama_show("llava:7b", {"model_info": {}})

    assert info.capabilities == {"vision": True}
    assert info.context_window is None


def test_parse_ollama_ps_maps_running_models_to_context_length() -> None:
    payload = {"models": [{"name": "qwen3:8b", "model": "qwen3:8b", "context_length": 4096}]}

    assert parse_ollama_ps(payload) == {"qwen3:8b": 4096}
    assert parse_ollama_ps({"models": [{"name": "x"}]}) == {}


def test_parse_lm_studio_models_uses_type_and_context() -> None:
    payload = {
        "data": [
            {"id": "qwen2.5-7b-instruct", "type": "llm", "max_context_length": 32768},
            {
                "id": "llava-v1.6",
                "type": "vlm",
                "max_context_length": 4096,
                "loaded_context_length": 2048,
            },
            {"id": "nomic-embed", "type": "embeddings"},
        ]
    }
    infos = parse_lm_studio_models(payload)

    assert [info.id for info in infos] == ["qwen2.5-7b-instruct", "llava-v1.6"]
    assert infos[0].capabilities == {"tools": True, "vision": False}
    assert infos[0].context_window == 32768
    assert infos[1].capabilities == {"vision": True}
    assert infos[1].loaded_context_window == 2048


# ---------------------------------------------------------------------------
# Network flows
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_local_model_infos_ollama(monkeypatch: MonkeyPatch) -> None:
    def route(method: str, url: str, body: Any) -> _FakeResponse:
        if url.endswith("/api/tags"):
            return _FakeResponse(200, {"models": [{"name": "qwen3:8b"}, {"name": "llava:7b"}]})
        if url.endswith("/api/ps"):
            return _FakeResponse(200, {"models": [{"name": "qwen3:8b", "context_length": 4096}]})
        if url.endswith("/api/show"):
            if body["model"] == "qwen3:8b":
                return _FakeResponse(
                    200,
                    {
                        "capabilities": ["completion", "tools"],
                        "model_info": {"qwen3.context_length": 40960},
                    },
                )
            return _FakeResponse(200, {"capabilities": ["completion", "vision"]})
        return _FakeResponse(404, {})

    session = _install(monkeypatch, route)
    infos = await fetch_local_model_infos("http://localhost:11434/v1")

    by_id = {info.id: info for info in infos}
    assert by_id["qwen3:8b"].capabilities == {"tools": True, "vision": False, "thinking": False}
    assert by_id["qwen3:8b"].context_window == 40960
    assert by_id["qwen3:8b"].loaded_context_window == 4096
    assert by_id["llava:7b"].capabilities["vision"] is True
    assert ("GET", "http://localhost:11434/api/tags", None) in session.calls
    assert by_id["qwen3:8b"].as_dict() == {
        "id": "qwen3:8b",
        "name": "qwen3:8b",
        "source": "ollama",
        "capabilities": {"tools": True, "vision": False, "thinking": False},
        "context_window": 40960,
        "loaded_context_window": 4096,
    }


@pytest.mark.asyncio
async def test_fetch_local_model_infos_falls_back_to_models_endpoint(
    monkeypatch: MonkeyPatch,
) -> None:
    def route(method: str, url: str, body: Any) -> _FakeResponse:
        if url.endswith("/v1/models"):
            return _FakeResponse(200, {"data": [{"id": "mistral-7b"}, {"id": "mystery"}]})
        return _FakeResponse(404, {})

    _install(monkeypatch, route)
    infos = await fetch_local_model_infos("http://localhost:1234/v1")

    assert [info.id for info in infos] == ["mistral-7b", "mystery"]
    assert infos[0].capabilities == {"tools": True}
    assert infos[1].capabilities == {}
    assert infos[0].source == "openai_compat"


@pytest.mark.asyncio
async def test_fetch_local_model_info_single_ollama_model(monkeypatch: MonkeyPatch) -> None:
    def route(method: str, url: str, body: Any) -> _FakeResponse:
        if url.endswith("/api/show"):
            return _FakeResponse(
                200,
                {"capabilities": ["completion"], "model_info": {"llama.context_length": 8192}},
            )
        if url.endswith("/api/ps"):
            return _FakeResponse(200, {"models": []})
        return _FakeResponse(404, {})

    _install(monkeypatch, route)
    info = await fetch_local_model_info("http://localhost:11434/v1", "llama3:8b")

    assert info is not None
    assert info.context_window == 8192
    assert info.loaded_context_window is None
    assert info.capabilities == {"tools": False, "vision": False, "thinking": False}


@pytest.mark.asyncio
async def test_fetch_local_model_info_skips_cloud_urls() -> None:
    assert await fetch_local_model_info("https://api.openai.com/v1", "gpt-4o") is None
