"""SSE emitter (producer side of IC-1).

This is the *agent-side* emit path. The HTTP transport — `GET
/v1/sessions/{session_id}/stream` (master line 97) — is owned by Surface 1
and wires into whatever ingress lambda fronts the AgentCore session. Surface
4 produces events; Surface 1 consumes.

Until that wiring lands, the emitter writes structured events into an
in-memory queue so unit tests + the Day-1-2 e2e round-trip can assert
on the streamed sequence (AC-1, AC-12 — every reasoning/payment SSE event
must be mirrored to a CloudWatch log line).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Literal

from agentcore.types import SSEEventName

logger = logging.getLogger(__name__)


@dataclass
class SSEEvent:
    """One SSE frame — `event: <name>\\ndata: <json>\\n\\n` on the wire."""

    name: SSEEventName
    data: dict[str, Any]


class SSEEmitter:
    """Producer-side SSE buffer.

    On real AgentCore: each `emit()` call also writes a structured CloudWatch
    log line (AC-12). Here we just log via stdlib + push to a queue.
    """

    def __init__(self, *, session_id: str) -> None:
        self.session_id = session_id
        self._queue: asyncio.Queue[SSEEvent] = asyncio.Queue()
        self._closed = False

    async def emit(self, name: SSEEventName, data: dict[str, Any]) -> None:
        if self._closed:
            raise RuntimeError(f"SSEEmitter for {self.session_id} already closed")
        event = SSEEvent(name=name, data=data)
        await self._queue.put(event)
        # AC-11/AC-12: every SSE event has a 1:1 CloudWatch log line.
        # TODO(Day 3+): swap stdlib logger for an AgentCore Observability
        # structured-log writer with session_id + agent_address indexed.
        logger.info(
            "sse_event",
            extra={
                "session_id": self.session_id,
                "event": name,
                "data": data,
            },
        )

    async def close(self) -> None:
        """Emit `done` and stop accepting further events."""
        if self._closed:
            return
        await self.emit("done", {"session_id": self.session_id})
        self._closed = True

    # Consumer-side API — used by tests and (eventually) the Surface 1 bridge
    # that drains this queue into the HTTP SSE response.

    async def drain(self) -> list[SSEEvent]:
        """Pop everything currently buffered. Test-only."""
        out: list[SSEEvent] = []
        while not self._queue.empty():
            out.append(self._queue.get_nowait())
        return out

    async def get(self) -> SSEEvent:
        return await self._queue.get()
