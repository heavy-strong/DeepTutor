"""Cost estimation must never bill a self-hosted or unknown model at a vendor rate."""

from __future__ import annotations

from deeptutor.agents.research.utils.token_tracker import calculate_cost, get_model_pricing
from deeptutor.logging.stats.llm_stats import (
    ZERO_PRICING,
    LLMStats,
    get_pricing,
    is_zero_cost_endpoint,
    resolve_pricing,
)
from deeptutor.runtime.agentic.usage import UsageTracker


def test_local_binding_is_free_even_for_a_priced_model_name() -> None:
    assert is_zero_cost_endpoint("ollama", None)
    assert is_zero_cost_endpoint(None, "http://localhost:1234/v1")
    assert not is_zero_cost_endpoint("openai", "https://api.openai.com/v1")
    assert resolve_pricing("gpt-4o", binding="ollama") == (ZERO_PRICING, "local")
    assert resolve_pricing("qwen3.8", base_url="http://127.0.0.1:11434/v1") == (
        ZERO_PRICING,
        "local",
    )


def test_unknown_model_is_zero_not_gpt_4o_mini() -> None:
    pricing, source = resolve_pricing("qwen3.8", binding="openrouter")
    assert (pricing, source) == (ZERO_PRICING, "unknown")
    assert get_pricing("totally-unknown", binding="custom") == ZERO_PRICING


def test_priced_cloud_model_keeps_its_table_rate() -> None:
    pricing, source = resolve_pricing("gpt-4o-2024-08-06", binding="openai")
    assert source == "table"
    assert pricing["input"] == 0.0025


def test_usage_tracker_reports_pricing_source() -> None:
    tracker = UsageTracker(model="qwen3.8", binding="ollama")
    tracker.add_estimated(input_chars=3500, output_chars=700)
    summary = tracker.summary()
    assert summary is not None
    assert summary["total_cost_usd"] == 0.0
    assert summary["pricing_source"] == "local"

    priced = UsageTracker(model="gpt-4o", binding="openai")
    priced.add_estimated(input_chars=3500, output_chars=700)
    assert priced.summary()["pricing_source"] == "table"
    assert priced.summary()["total_cost_usd"] > 0


def test_llm_stats_add_call_honours_binding() -> None:
    stats = LLMStats("test")
    stats.add_call(model="gpt-4o", prompt_tokens=1000, completion_tokens=1000, binding="ollama")
    assert stats.total_cost == 0.0
    stats.add_call(model="gpt-4o", prompt_tokens=1000, completion_tokens=1000, binding="openai")
    assert stats.total_cost > 0


def test_research_tracker_falls_back_to_zero_for_unknown(monkeypatch) -> None:
    # No active profile serves this model, so neither table applies.
    monkeypatch.setattr(
        "deeptutor.logging.stats.llm_stats._active_endpoint_for", lambda _m: ("openai", None)
    )
    assert get_model_pricing("qwen3.8") == ZERO_PRICING
    assert calculate_cost("qwen3.8", 10_000, 10_000) == 0.0
    # The research-only fuzzy table still wins for its own entries.
    assert get_model_pricing("deepseek-v4-flash-preview")["input"] == 0.00014
