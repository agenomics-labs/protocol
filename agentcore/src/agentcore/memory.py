"""AgentCore Memory adapter.

STUB ONLY for Day 1-2 — real bedrock-agentcore client wiring is Day 3+.

The runtime exposes two key spaces (master spec lines 22-24, 375):
  * `decision_*`  short-term, current-session task graph + decision records
  * `pricing_*`   long-term, pricing history per service per agent

Acceptance criterion AC-3 (master line 468): both spaces must be queryable.
"""

from __future__ import annotations

from typing import Any, Protocol


class AgentCoreMemory(Protocol):
    """Protocol the agent loop calls.

    A real implementation will wrap `boto3.client("bedrock-agentcore-memory")`
    (preview SDK) once it stabilises. The protocol shape MUST match the keys
    listed at master line 22 so the queryability acceptance check (AC-3) holds
    against either the stub or the real client.
    """

    async def write(self, key: str, value: Any) -> None:
        """Persist `value` under `key`.

        TODO(Day 3+): wire to bedrock-agentcore-memory short-term namespace
        when key starts with `decision_`, long-term when `pricing_`.
        Master line 468.
        """
        ...

    async def read(self, key: str) -> Any | None:
        """Retrieve a previously written value, or None if absent."""
        ...

    async def query(self, prefix: str) -> dict[str, Any]:
        """Return all key/value pairs whose key starts with `prefix`.

        Used by the AC-3 queryability check and by pricing-history lookups
        during the planning step.
        TODO(Day 3+): map to whatever search/list API the real client gives us.
        """
        ...


class InMemoryAgentCoreMemory:
    """Dev/test fake. Behaviour is intentionally simple: a flat dict.

    Keys starting with `decision_` and `pricing_` are stored side by side,
    mirroring the conceptual two-space split master describes — the real
    implementation will route on prefix.
    """

    def __init__(self) -> None:
        self._store: dict[str, Any] = {}

    async def write(self, key: str, value: Any) -> None:
        self._store[key] = value

    async def read(self, key: str) -> Any | None:
        return self._store.get(key)

    async def query(self, prefix: str) -> dict[str, Any]:
        return {k: v for k, v in self._store.items() if k.startswith(prefix)}

    # Test-only convenience.
    @property
    def all(self) -> dict[str, Any]:
        return dict(self._store)
