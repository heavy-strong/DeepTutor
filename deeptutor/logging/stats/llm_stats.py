"""
LLM Stats Tracker
=================

Simple utility for tracking LLM token usage and costs across all modules.
Outputs summary via the unified logging system.

Usage:
    from deeptutor.logging import LLMStats

    stats = LLMStats("Solver")

    # After each LLM call:
    stats.add_call(
        model="gpt-4o-mini",
        prompt_tokens=100,
        completion_tokens=50
    )

    # At the end:
    stats.log_summary()  # Uses logging system
"""

from dataclasses import dataclass, field
from datetime import datetime
import logging
from typing import Any, Optional

# Model pricing per 1K tokens (USD)
MODEL_PRICING = {
    "gpt-4o": {"input": 0.0025, "output": 0.010},
    "gpt-4o-mini": {"input": 0.00015, "output": 0.0006},
    "gpt-4-turbo": {"input": 0.01, "output": 0.03},
    "gpt-4": {"input": 0.03, "output": 0.06},
    "gpt-3.5-turbo": {"input": 0.0005, "output": 0.0015},
    "deepseek-chat": {"input": 0.00014, "output": 0.00028},
    "claude-3-5-sonnet": {"input": 0.003, "output": 0.015},
    "claude-3-opus": {"input": 0.015, "output": 0.075},
    "claude-3-haiku": {"input": 0.00025, "output": 0.00125},
}


ZERO_PRICING: dict[str, float] = {"input": 0.0, "output": 0.0}


def _table_pricing(model: str) -> dict[str, float] | None:
    model_lower = (model or "").lower()
    if not model_lower:
        return None
    for key, pricing in MODEL_PRICING.items():
        if key in model_lower or model_lower in key:
            return pricing
    return None


def is_zero_cost_endpoint(binding: str | None, base_url: str | None) -> bool:
    """True for self-hosted servers (Ollama, LM Studio, vLLM, ...) with no per-token bill."""
    # Local imports: this module is loaded by ``deeptutor.logging`` early.
    from deeptutor.services.llm.utils import is_local_llm_server
    from deeptutor.services.provider_registry import find_by_name

    spec = find_by_name(binding) if binding else None
    if spec is not None and spec.is_local:
        return True
    return bool(base_url) and is_local_llm_server(base_url or "")


def _active_endpoint_for(model: str) -> tuple[str | None, str | None]:
    """Binding / base URL of the active LLM profile when it serves *model*."""
    try:
        from deeptutor.services.llm.config import get_llm_config

        config = get_llm_config()
    except Exception:  # noqa: BLE001 - pricing is best effort, never fatal
        return None, None
    if (getattr(config, "model", "") or "").lower() != (model or "").lower():
        return None, None
    return getattr(config, "binding", None), getattr(config, "base_url", None)


def resolve_pricing(
    model: str,
    *,
    binding: str | None = None,
    base_url: str | None = None,
) -> tuple[dict[str, float], str]:
    """Per-1K-token pricing for *model* and where the answer came from.

    Returns ``(pricing, source)`` with ``source`` one of:

    * ``"local"`` - the model is served by a local/self-hosted endpoint; zero.
    * ``"table"`` - matched :data:`MODEL_PRICING`.
    * ``"unknown"`` - no entry; zero rather than a made-up vendor rate, so a
      Qwen on Ollama or a gateway model never shows a fictitious bill.

    When *binding*/*base_url* are not given, the active LLM profile is used
    if it is the one serving *model*.
    """
    if binding is None and base_url is None:
        binding, base_url = _active_endpoint_for(model)
    if is_zero_cost_endpoint(binding, base_url):
        return ZERO_PRICING, "local"
    table = _table_pricing(model)
    if table is not None:
        return table, "table"
    return ZERO_PRICING, "unknown"


def get_pricing(
    model: str,
    *,
    binding: str | None = None,
    base_url: str | None = None,
) -> dict[str, float]:
    """Pricing for a model; zero for local endpoints and unknown models."""
    return resolve_pricing(model, binding=binding, base_url=base_url)[0]


def estimate_tokens(text: str) -> int:
    """Rough estimate of tokens (1.3 tokens per word)."""
    return int(len(text.split()) * 1.3)


@dataclass
class LLMCall:
    """Single LLM call record."""

    model: str
    prompt_tokens: int
    completion_tokens: int
    cost: float
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())


class LLMStats:
    """
    LLM usage statistics tracker.
    Tracks token usage and costs, outputs summary to terminal.
    """

    def __init__(self, module_name: str = "Module"):
        """
        Initialize stats tracker.

        Args:
            module_name: Name of the module (for display)
        """
        self.module_name = module_name
        self.calls: list[LLMCall] = []
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
        self.total_cost = 0.0
        self.model_used: Optional[str] = None

    def add_call(
        self,
        model: str,
        prompt_tokens: Optional[int] = None,
        completion_tokens: Optional[int] = None,
        # Alternative: estimate from text
        system_prompt: Optional[str] = None,
        user_prompt: Optional[str] = None,
        response: Optional[str] = None,
        binding: Optional[str] = None,
        base_url: Optional[str] = None,
    ):
        """
        Add an LLM call to the stats.

        Args:
            model: Model name
            prompt_tokens: Number of prompt tokens (if known)
            completion_tokens: Number of completion tokens (if known)
            system_prompt: System prompt text (for estimation)
            user_prompt: User prompt text (for estimation)
            response: Response text (for estimation)
            binding: Provider binding; local servers are billed at zero
            base_url: Endpoint URL, used the same way when binding is unknown
        """
        # Estimate tokens if not provided
        if prompt_tokens is None and (system_prompt or user_prompt):
            prompt_text = (system_prompt or "") + "\n" + (user_prompt or "")
            prompt_tokens = estimate_tokens(prompt_text)

        if completion_tokens is None and response:
            completion_tokens = estimate_tokens(response)

        prompt_tokens = prompt_tokens or 0
        completion_tokens = completion_tokens or 0

        # Calculate cost
        pricing = get_pricing(model, binding=binding, base_url=base_url)
        cost = (prompt_tokens / 1000.0) * pricing["input"] + (completion_tokens / 1000.0) * pricing[
            "output"
        ]

        # Record call
        call = LLMCall(
            model=model, prompt_tokens=prompt_tokens, completion_tokens=completion_tokens, cost=cost
        )
        self.calls.append(call)

        # Update totals
        self.total_prompt_tokens += prompt_tokens
        self.total_completion_tokens += completion_tokens
        self.total_cost += cost

        # Track primary model
        if self.model_used is None:
            self.model_used = model

    def get_summary(self) -> dict[str, Any]:
        """Get summary as dictionary."""
        return {
            "module": self.module_name,
            "model": self.model_used or "Unknown",
            "calls": len(self.calls),
            "prompt_tokens": self.total_prompt_tokens,
            "completion_tokens": self.total_completion_tokens,
            "total_tokens": self.total_prompt_tokens + self.total_completion_tokens,
            "cost_usd": self.total_cost,
        }

    def log_summary(self, logger: Optional[logging.Logger] = None):
        """
        Log summary using the unified logging system.

        Args:
            logger: Optional Logger instance. If None, creates one using module_name.
        """
        if len(self.calls) == 0:
            return

        if logger is None:
            logger = logging.getLogger(f"deeptutor.stats.{self.module_name}")

        total_tokens = self.total_prompt_tokens + self.total_completion_tokens

        logger.info("=" * 60)
        logger.info(f"LLM Usage Summary for {self.module_name}")
        logger.info("=" * 60)
        logger.info(f"Model       : {self.model_used or 'Unknown'}")
        logger.info(f"API Calls   : {len(self.calls)}")
        logger.info(
            f"Tokens      : {total_tokens:,} (Input: {self.total_prompt_tokens:,}, Output: {self.total_completion_tokens:,})"
        )
        logger.info(f"Cost        : ${self.total_cost:.6f} USD")
        logger.info("=" * 60)

    def print_summary(self):
        """
        Print summary to terminal.

        Deprecated: Use log_summary() instead for consistent logging.
        """
        self.log_summary()

    def reset(self):
        """Reset all statistics."""
        self.calls.clear()
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
        self.total_cost = 0.0
        self.model_used = None
