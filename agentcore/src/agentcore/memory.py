"""AgentCore Memory adapter.

The Protocol below is what the agent loop calls. Two implementations live
side by side:
  * `InMemoryAgentCoreMemory`  flat-dict fake used by unit tests + the
    Day-1/2 round-trip test (no AWS required).
  * `BedrockAgentCoreMemory`   real boto3-backed impl in
    `agentcore.memory_aws`. Selected at runtime by `AGENTCORE_BACKEND=aws`.

The runtime exposes two key spaces (master spec lines 22-24, 375):
  * `decision_*`  short-term, current-session task graph + decision records
  * `pricing_*`   long-term, pricing history per service per agent

Acceptance criterion AC-3 (master line 468): both spaces must be queryable.

The `kind` parameter on `write` lets the AWS impl tag the underlying
`CreateEvent` call with metadata that the AgentCore Memory resource's
extraction strategy uses to route into short-term vs. long-term storage.
The fake ignores it (everything is one dict).
"""

from __future__ import annotations

from typing import Any, Literal, Protocol


MemoryKind = Literal["short", "long"]


class AgentCoreMemory(Protocol):
    """Protocol the agent loop calls.

    A real implementation wraps `boto3.client("bedrock-agentcore")` (the data
    plane). See `memory_aws.BedrockAgentCoreMemory`. The Protocol shape MUST
    match the conceptual key spaces at master line 22 so the queryability
    acceptance check (AC-3) holds against either fake or real client.
    """

    async def write(
        self, key: str, value: Any, *, kind: MemoryKind = "short"
    ) -> None:
        """Persist `value` under `key`.

        `kind="short"` -> session-scoped (decision records, default).
        `kind="long"`  -> agent-scoped (pricing history, survives session end).

        The key prefix (`decision_` / `pricing_`) is conventional and
        independent from `kind`; both are recorded in the AWS impl's event
        metadata so listEvents-with-filter can fan out by either dimension.
        """
        ...

    async def read(self, key: str) -> Any | None:
        """Retrieve a previously written value, or None if absent."""
        ...

    async def query(
        self, prefix: str, *, kind: MemoryKind | None = None
    ) -> dict[str, Any]:
        """Return all key/value pairs whose key starts with `prefix`.

        If `kind` is given, restrict to that namespace; otherwise return
        across both. Used by AC-3 queryability and by pricing-history
        lookups during planning.
        """
        ...

    async def delete(self, key: str) -> None:
        """Remove the record at `key`. No-op if absent."""
        ...


class InMemoryAgentCoreMemory:
    """Dev/test fake. Behaviour is intentionally simple: a flat dict.

    Keys starting with `decision_` and `pricing_` are stored side by side,
    mirroring the conceptual two-space split master describes — the real
    implementation routes on `kind` + key prefix.
    """

    def __init__(self) -> None:
        self._store: dict[str, Any] = {}
        self._kinds: dict[str, MemoryKind] = {}

    async def write(
        self, key: str, value: Any, *, kind: MemoryKind = "short"
    ) -> None:
        self._store[key] = value
        self._kinds[key] = kind

    async def read(self, key: str) -> Any | None:
        return self._store.get(key)

    async def query(
        self, prefix: str, *, kind: MemoryKind | None = None
    ) -> dict[str, Any]:
        return {
            k: v
            for k, v in self._store.items()
            if k.startswith(prefix) and (kind is None or self._kinds.get(k) == kind)
        }

    async def delete(self, key: str) -> None:
        self._store.pop(key, None)
        self._kinds.pop(key, None)

    # Test-only convenience.
    @property
    def all(self) -> dict[str, Any]:
        return dict(self._store)
