"""Base abstractions and shared helpers for voice providers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
import logging
import re

from deeptutor.services.voice.config import (
    AUTH_API_KEY_HEADER,
    AUTH_TOKEN,
    STTConfig,
    TTSConfig,
)

logger = logging.getLogger(__name__)


class VoiceProviderError(RuntimeError):
    """Raised when a TTS/STT provider request fails or is misconfigured."""


class VoiceProviderHTTPError(VoiceProviderError):
    """Provider returned a non-2xx HTTP response."""

    def __init__(self, message: str, *, status_code: int, body: str = "") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class BaseTTSAdapter(ABC):
    """Abstract text-to-speech adapter."""

    @abstractmethod
    async def synthesize(self, text: str, config: TTSConfig) -> tuple[bytes, str]:
        """Synthesize ``text`` to audio.

        Returns:
            ``(audio_bytes, content_type)`` — content type is best-effort, e.g.
            ``audio/mpeg`` for mp3.
        """


@dataclass(frozen=True, slots=True)
class TranscriptCue:
    """One timed span of recognised speech, relative to the clip's own start.

    ``timed`` is False for providers that only return a transcript, so callers
    can tell "this whole clip says X" apart from "these words were said at
    01:12" instead of guessing from a zero start time.
    """

    start_seconds: float
    end_seconds: float
    text: str
    timed: bool = True


class BaseSTTAdapter(ABC):
    """Abstract speech-to-text adapter."""

    @abstractmethod
    async def transcribe(
        self,
        audio: bytes,
        config: STTConfig,
        *,
        filename: str = "audio.webm",
        content_type: str = "application/octet-stream",
    ) -> str:
        """Transcribe ``audio`` bytes to text."""

    async def transcribe_cues(
        self,
        audio: bytes,
        config: STTConfig,
        *,
        filename: str = "audio.webm",
        content_type: str = "application/octet-stream",
    ) -> list[TranscriptCue]:
        """Transcribe into timed cues, when the provider can produce them.

        The base implementation returns the plain transcript as one untimed
        cue, so a provider that cannot report word timings degrades to exactly
        today's behaviour instead of failing. Adapters that can do better
        override this.
        """
        text = await self.transcribe(audio, config, filename=filename, content_type=content_type)
        cleaned = (text or "").strip()
        return [TranscriptCue(0.0, 0.0, cleaned, timed=False)] if cleaned else []


def build_auth_headers(auth_style: str, api_key: str) -> dict[str, str]:
    """Map an ``auth_style`` + key onto request headers.

    ``bearer`` (default) → ``Authorization: Bearer``; ``api_key_header`` →
    ``api-key`` (Azure); ``token`` → ``Authorization: Token`` (Deepgram-style).
    """
    if not api_key:
        return {}
    if auth_style == AUTH_API_KEY_HEADER:
        return {"api-key": api_key}
    if auth_style == AUTH_TOKEN:
        return {"Authorization": f"Token {api_key}"}
    return {"Authorization": f"Bearer {api_key}"}


def normalize_stt_content_type(content_type: str | None) -> str:
    """Strip MIME parameters that STT APIs reject.

    Chrome's ``MediaRecorder.mimeType`` is typically ``audio/webm;codecs=opus``.
    OpenAI-compatible transcription endpoints treat the codec parameter as an
    unknown format and return 400 (``Unsupported file format: ...``). Keep the
    type/subtype only.
    """
    media_type = (content_type or "").split(";", 1)[0].strip()
    return media_type or "application/octet-stream"


def join_audio_path(base_url: str, suffix: str) -> str:
    """Append an OpenAI audio path to a configured base URL.

    ``base_url`` is the API base (e.g. ``https://api.openai.com/v1``). If the
    admin already pasted a full ``.../audio/...`` endpoint (some gateways /
    Azure deployments), it is used verbatim and the query string preserved.
    """
    base = (base_url or "").strip()
    if not base:
        raise VoiceProviderError("No endpoint URL configured for this provider.")
    head, sep, query = base.partition("?")
    if "/audio/" in head:
        return base
    joined = f"{head.rstrip('/')}/{suffix.lstrip('/')}"
    return f"{joined}?{query}" if sep else joined


# Content blocks that should never be spoken aloud, stripped before synthesis.
_FENCED_CODE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s*", re.MULTILINE)
_BLOCKQUOTE = re.compile(r"^\s{0,3}>\s?", re.MULTILINE)
_LIST_MARKER = re.compile(r"^\s{0,3}(?:[-*+]|\d+[.)])\s+", re.MULTILINE)
_EMPHASIS = re.compile(r"(\*{1,3}|_{1,3}|~~)(\S.*?\S|\S)\1")
_HTML_TAG = re.compile(r"<[^>]+>")
_TABLE_PIPE = re.compile(r"^\s*\|.*\|\s*$", re.MULTILINE)
_WHITESPACE = re.compile(r"[ \t]+")
_BLANK_LINES = re.compile(r"\n{3,}")


# ── things that are written, not said ─────────────────────────────────────
# A chat reply is full of visual texture a voice should skip: emoji, text
# laughter, filler interjections, stage directions. Read aloud they come out
# as "grinning face", "kieuk kieuk kieuk" or a literal "asterisk laughs
# asterisk" — so they are removed before synthesis.

# Emoji and pictographs: the SMP symbol blocks, the BMP misc-symbol /
# dingbat / arrow blocks, and the invisible glue (variation selectors, ZWJ,
# keycap combiner, flag tags) that sequences are built from.
_EMOJI = re.compile(
    "["
    "\U0001F000-\U0001FAFF"  # pictographs, emoticons, transport, symbols
    "☀-➿"  # misc symbols and dingbats (☀ ✅ ✨ ❌ ❤)
    "⬀-⯿"  # misc symbols and arrows (⭐ ⬆)
    "←-⇿"  # arrows (→ ⇒)
    "⏩-⏺"  # media controls (⏩ ⏰)
    "⌚⌛"  # ⌚ ⌛
    "〰〽㊗㊙"
    "︎️‍⃣"
    "\U000E0020-\U000E007F"
    "]"
)
# Decorative bullets and check marks that survive the Markdown pass.
_DECORATION = re.compile(r"[•·▪▫◦‣■□●○◆◇★☆✓✔✗✘]")
# Western text emoticons standing on their own: :) :-( ;) :D ^^ ^_^ T_T -_-
_EMOTICON = re.compile(
    r"(?<!\S)(?:[:;=8][-'^o]?[)(\[\]DPpOo3/\|*]+|\^+_?\^+|[Tt]_[Tt]|-_-|>_<|;_;|[xX][Dd])(?!\S)"
)
# Hangul jamo runs are never prose — ㅋㅋㅋ, ㅎㅎ, ㅠㅠ, ㄷㄷ, ㅇㅇ.
_JAMO = re.compile(r"[ㄱ-ㆎ]+")
# Filler interjections and text laughter, on their own (not inside a word),
# with whatever punctuation trails them (음..., 흠~, hmm!).
_INTERJECTION = re.compile(
    r"(?<![\w가-힣])(?:"
    r"음+|흠+|흐음|으음|하{2,}|허{2,}|호{2,}|히{2,}|헤{2,}|후{2,}|크{2,}|킥{2,}|푸하하+"
    r"|에휴|어휴|휴|아이고|아이구|에구|우와|와우|오호+|오오+|앗|헉|헐|어머+|쩝|흑흑+|엉엉+"
    r"|h+m+|u+m+|u+h+|a+h+|o+h+|e+r+m*|ha(?:ha)+|he(?:he)+|hah+|lol+|lmao|rofl|ugh+"
    r"|wow+|whoa|yay+|aw+|oops|phew|meh|tsk|psst|sh{2,}|hmph|ahem"
    r")(?:[.…~!?,]+)?(?![\w가-힣])",
    re.IGNORECASE,
)
# Stage directions: *laughs*, (chuckles), (웃음), *미소 지으며* — only phrases
# from a lexicon of actions, so emphasised words stay.
_ACTION_WORDS = (
    r"(?:laughs?|laughing|chuckles?|chuckling|giggles?|giggling|sighs?|sighing|smiles?|smiling"
    r"|grins?|grinning|nods?|nodding|shrugs?|winks?|pauses?|thinks|thinking|whispers?|gasps?"
    r"|coughs?|ahem|sniffs?|sniffles?|blushes|blushing|yawns?|cries|sobs?|clears throat|beat"
    r"|웃음|웃음소리|미소|한숨|끄덕|끄덕임|웃으며|미소\s*지으며|고개를\s*끄덕이며|헛기침|생각\s*중|잠시\s*침묵)"
)
_STAGE_DIRECTION = re.compile(
    r"(?:\*{1,2}\s*" + _ACTION_WORDS + r"\s*\*{1,2}"
    r"|[\(\[（]\s*" + _ACTION_WORDS + r"\s*[\)\]）])",
    re.IGNORECASE,
)
# A trailing or lone tilde is a tone marker (네~, 좋아요~~) or decoration,
# not a range like 1~5.
_TRAILING_TILDE = re.compile(r"(?:(?<=\S)|(?<!\S))~+(?=[\s.!?,]|$)")
_REPEATED_PUNCT = re.compile(r"([!?])\1+")
_EMPTY_BRACKETS = re.compile(r"[\(\[（]\s*[\)\]）]")
_SPACE_BEFORE_PUNCT = re.compile(r"\s+([,.!?;:])")
_LINE_EDGES = re.compile(r" *\n *")


def strip_unspoken(text: str) -> str:
    """Remove emoji, emoticons, text laughter, filler and stage directions."""
    out = _STAGE_DIRECTION.sub(" ", text)
    out = _EMOJI.sub("", out)
    out = _DECORATION.sub(" ", out)
    out = _EMOTICON.sub(" ", out)
    out = _JAMO.sub(" ", out)
    out = _INTERJECTION.sub(" ", out)
    out = _TRAILING_TILDE.sub("", out)
    out = _REPEATED_PUNCT.sub(r"\1", out)
    out = _EMPTY_BRACKETS.sub(" ", out)
    out = _SPACE_BEFORE_PUNCT.sub(r"\1", out)
    return out


def strip_markdown_for_speech(text: str, *, max_chars: int = 0) -> str:
    """Reduce Markdown to plain prose suitable for TTS.

    Drops code blocks and tables outright (they read terribly), unwraps links
    and emphasis to their visible text, removes structural markers, and then
    everything that is written rather than said (emoji, ㅋㅋ, "hmm", *laughs*
    — see :func:`strip_unspoken`). This is deliberately lossy — the goal is
    natural speech, not faithful rendering.
    """
    if not text:
        return ""
    out = _FENCED_CODE.sub(" ", text)
    out = _TABLE_PIPE.sub(" ", out)
    out = _IMAGE.sub(" ", out)
    out = _LINK.sub(r"\1", out)
    out = _INLINE_CODE.sub(r"\1", out)
    out = _HEADING.sub("", out)
    out = _BLOCKQUOTE.sub("", out)
    out = _LIST_MARKER.sub("", out)
    # Stage directions are emphasised (*laughs*), so they go before emphasis
    # is unwrapped into plain words.
    out = _STAGE_DIRECTION.sub(" ", out)
    out = _EMPHASIS.sub(r"\2", out)
    out = _HTML_TAG.sub("", out)
    out = strip_unspoken(out)
    out = _WHITESPACE.sub(" ", out)
    out = _LINE_EDGES.sub("\n", out)
    out = _BLANK_LINES.sub("\n\n", out).strip()
    if max_chars and len(out) > max_chars:
        # Cut on a sentence/space boundary near the cap so speech ends cleanly.
        window = out[:max_chars]
        cut = max(window.rfind("."), window.rfind("\n"), window.rfind(" "))
        out = window[: cut + 1].strip() if cut > max_chars // 2 else window.strip()
    return out


__all__ = [
    "TranscriptCue",
    "VoiceProviderError",
    "VoiceProviderHTTPError",
    "BaseTTSAdapter",
    "BaseSTTAdapter",
    "build_auth_headers",
    "join_audio_path",
    "normalize_stt_content_type",
    "strip_markdown_for_speech",
    "strip_unspoken",
]
