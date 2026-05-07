"""Nova Act SDK sub-agent.

STUB ONLY for Day 1-2 — real Nova Act SDK wiring is Day 3+, gated on
open question OQ-2 (which teammate has US-account access).

Master spec line 378, line 192, AC-5 (line 470): Nova Act is a *subordinate*
sub-agent invoked by the Strands master loop for browser-shaped work. The
managed Chromium and live-view streaming come from AgentCore Browser
(master line 26); Nova Act drives it with high-level natural-language
actions ("search for X on this page", "click the first result").

Risk R3 mitigation: if Nova Act access is blocked, swap this module's
implementation for plain AgentCore Browser + Playwright; the input/output
contract here stays the same so the master loop is unaffected.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class NovaActRequest:
    """Input shape the master loop passes to the sub-agent."""

    target_url: str
    instruction: str  # natural-language task, e.g. "search for X and return top 3 titles"
    oauth_token: str | None = None  # drawn from AgentCore Identity if needed
    screenshots: bool = True
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class NovaActResult:
    """Output shape the master loop expects back."""

    success: bool
    extracted: str  # natural-language summary or JSON-as-string
    live_view_url: str | None = None  # AgentCore Browser live-view URL, streamed via SSE
    replay_url: str | None = None  # post-session replay
    duration_ms: int = 0
    error: str | None = None


class NovaBrowser(Protocol):
    """Protocol the agent loop calls when a candidate requires browser work."""

    async def run(self, request: NovaActRequest) -> NovaActResult:
        """Drive a managed Chromium session per `request.instruction`.

        TODO(Day 3+): import nova_act and AgentCore Browser; stream the
        live-view URL into the SSE 'reasoning' channel so Surface 1 can
        render it.
        """
        ...


class StubNovaBrowser:
    """Dev/test fake. Returns a canned successful result so the rest of the
    loop is exercisable without Nova Act access."""

    def __init__(self, canned_result: str = "stub: 3 results extracted") -> None:
        self._canned = canned_result

    async def run(self, request: NovaActRequest) -> NovaActResult:
        return NovaActResult(
            success=True,
            extracted=self._canned,
            live_view_url=f"https://stub-live/{request.target_url}",
            replay_url=None,
            duration_ms=42,
            error=None,
        )
