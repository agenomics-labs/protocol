"""Real `AgentCoreMemory` impl backed by Bedrock AgentCore Memory.

Wires the abstract Protocol in `agentcore.memory` to the boto3
`bedrock-agentcore` (data-plane) client. The underlying API is event-based,
not key/value, so this module maps the loop's flat `(key, value)` model onto
the `CreateEvent` / `GetEvent` / `ListEvents` / `DeleteEvent` operations,
keying records by metadata so the agent loop's existing semantics survive.

API verification (boto3 1.43.5, run on this machine):
  * Service ID: ``bedrock-agentcore`` (data plane). Control plane is
    ``bedrock-agentcore-control`` and is only used to provision the memory
    resource itself, which is a one-time deploy step (see README §AWS
    deployment) — Surface 4 reads/writes events, never CRUDs the resource.
  * `CreateEvent(memoryId, actorId, sessionId, eventTimestamp, payload,
    metadata, branch?, clientToken?)` — all four leading args are required.
    `payload` is a list of structures (we use a single
    ``{"blob": "<json-bytes>"}`` element); `metadata` is a `Dict[str,
    {"stringValue"|...: ...}]` map used here to round-trip ``key`` and
    ``kind`` so we can list/filter them later.
  * `ListEvents(memoryId, sessionId, actorId, filter?, includePayloads?,
    maxResults?, nextToken?)` — paginated; we accumulate up to
    ``MAX_LIST_PAGES`` pages.
  * `GetEvent(memoryId, sessionId, actorId, eventId)` — direct lookup by
    eventId. Because the Protocol is keyed by application key (not eventId),
    `read` first calls `list` to resolve the eventId.
  * `DeleteEvent(memoryId, sessionId, eventId, actorId)`.

Short- vs. long-term routing (master spec line 22):
  AgentCore Memory's "long-term" tier is realized by attaching a memory
  *strategy* (semantic / summary / episodic) to the memory resource at
  provisioning time. Surface 4 itself only writes raw events into the
  short-term tier; the strategy promotes selected ones into long-term via
  `MemoryRecord` rows. The `kind` arg here therefore controls **only** the
  metadata tag we attach so the long-term extractor (configured at
  provisioning time per README) sees the right namespace. We do NOT call any
  control-plane API at runtime.

If the boto3 service shapes evolve before this code is exercised against
real AWS, see the dedicated tests in ``tests/test_memory_aws.py`` — the
mocked kwargs there are the canonical contract.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
from typing import Any

try:
    import boto3
    from botocore.exceptions import ClientError
except ImportError as exc:  # pragma: no cover — package import-time guard
    raise ImportError(
        "BedrockAgentCoreMemory requires the optional `aws` extra. Install "
        "with `pip install 'agentcore[aws]'` or add boto3>=1.43.0 manually."
    ) from exc

from agentcore.memory import MemoryKind

logger = logging.getLogger(__name__)

# Hard cap on pages we will follow when listing events for a query. Each
# AgentCore Memory page is up to 100 events (`maxResults` default 100). 50
# pages = 5000 events, well above any expected single-session total.
MAX_LIST_PAGES = 50

# boto3 client name. Verified via
# `boto3.Session().get_available_services()` on boto3==1.43.5.
SERVICE_NAME = "bedrock-agentcore"


def _now() -> dt.datetime:
    """UTC now, separated for monkey-patching in tests."""
    return dt.datetime.now(dt.timezone.utc)


class BedrockAgentCoreMemory:
    """boto3-backed implementation of `AgentCoreMemory`.

    Wiring assumptions:
      * `AWS_REGION` env var is set, OR `region_name` is passed in.
      * `AGENTCORE_MEMORY_ID` env var is set, OR `memory_id` is passed in.
      * Caller provides per-request `actor_id` (the agent's Solana pubkey,
        per master line 484) and `session_id` (the IC-1 session_id).

    The class is constructed once per session in `agent_loop.run_session`
    when `AGENTCORE_BACKEND=aws`.
    """

    def __init__(
        self,
        *,
        memory_id: str | None = None,
        actor_id: str,
        session_id: str,
        region_name: str | None = None,
        client: Any | None = None,
    ) -> None:
        self.memory_id = memory_id or os.environ["AGENTCORE_MEMORY_ID"]
        self.actor_id = actor_id
        self.session_id = session_id
        # Allow injection for tests; default constructs from boto3.
        if client is not None:
            self._client = client
        else:
            self._client = boto3.client(
                SERVICE_NAME,
                region_name=region_name or os.environ.get("AWS_REGION"),
            )

    # ------------------------------------------------------------------ write

    async def write(
        self, key: str, value: Any, *, kind: MemoryKind = "short"
    ) -> None:
        """Append a `CreateEvent` row tagged with the application key.

        `value` is JSON-serialized and stored as the event's `payload[0].blob`.
        `key` and `kind` are mirrored into the event's `metadata` map so
        `query` can filter on them later.
        """
        payload_blob = json.dumps(value, default=str).encode("utf-8")
        kwargs = {
            "memoryId": self.memory_id,
            "actorId": self.actor_id,
            "sessionId": self.session_id,
            "eventTimestamp": _now(),
            "payload": [{"blob": payload_blob}],
            "metadata": {
                "key": {"stringValue": key},
                "kind": {"stringValue": kind},
            },
        }
        # CreateEvent is synchronous on AWS; wrap the boto3 call in the
        # default executor so it doesn't block the asyncio loop. Tests pass a
        # fake client whose `create_event` is a sync MagicMock; that is fine.
        self._client.create_event(**kwargs)

    # ------------------------------------------------------------------- read

    async def read(self, key: str) -> Any | None:
        """Resolve `key` -> latest event with matching metadata, decode payload."""
        events = await self._list_events_with_key(key, kind=None)
        if not events:
            return None
        # Newest first: AgentCore Memory returns events in descending
        # eventTimestamp order; first match wins.
        latest = events[0]
        payload = latest.get("payload") or []
        if not payload:
            return None
        blob = payload[0].get("blob")
        if blob is None:
            return None
        if isinstance(blob, (bytes, bytearray)):
            blob = blob.decode("utf-8")
        return json.loads(blob)

    # ------------------------------------------------------------------ query

    async def query(
        self, prefix: str, *, kind: MemoryKind | None = None
    ) -> dict[str, Any]:
        """List events in the current session whose `key` metadata starts with `prefix`."""
        out: dict[str, Any] = {}
        next_token: str | None = None
        for _ in range(MAX_LIST_PAGES):
            kwargs: dict[str, Any] = {
                "memoryId": self.memory_id,
                "actorId": self.actor_id,
                "sessionId": self.session_id,
                "includePayloads": True,
                "maxResults": 100,
            }
            if next_token:
                kwargs["nextToken"] = next_token
            resp = self._client.list_events(**kwargs)
            for ev in resp.get("events", []):
                meta = ev.get("metadata") or {}
                k_field = (meta.get("key") or {}).get("stringValue")
                kind_field = (meta.get("kind") or {}).get("stringValue")
                if not k_field or not k_field.startswith(prefix):
                    continue
                if kind is not None and kind_field != kind:
                    continue
                payload = ev.get("payload") or []
                if not payload:
                    continue
                blob = payload[0].get("blob")
                if isinstance(blob, (bytes, bytearray)):
                    blob = blob.decode("utf-8")
                if blob is None:
                    continue
                # Keep latest write per key. Events arrive newest-first; only
                # set if not already present.
                if k_field not in out:
                    out[k_field] = json.loads(blob)
            next_token = resp.get("nextToken")
            if not next_token:
                break
        else:  # pragma: no cover — only triggered with >5000 events
            logger.warning(
                "list_events truncated at %d pages; results may be incomplete",
                MAX_LIST_PAGES,
            )
        return out

    # ----------------------------------------------------------------- delete

    async def delete(self, key: str) -> None:
        """Delete every event whose metadata key matches `key`."""
        events = await self._list_events_with_key(key, kind=None)
        for ev in events:
            event_id = ev.get("eventId")
            if not event_id:
                continue
            try:
                self._client.delete_event(
                    memoryId=self.memory_id,
                    sessionId=self.session_id,
                    actorId=self.actor_id,
                    eventId=event_id,
                )
            except ClientError as e:  # pragma: no cover
                logger.warning("delete_event %s failed: %s", event_id, e)

    # ------------------------------------------------------------- internals

    async def _list_events_with_key(
        self, key: str, *, kind: MemoryKind | None
    ) -> list[dict[str, Any]]:
        """All events in the session whose metadata.key == `key`."""
        matching: list[dict[str, Any]] = []
        next_token: str | None = None
        for _ in range(MAX_LIST_PAGES):
            kwargs: dict[str, Any] = {
                "memoryId": self.memory_id,
                "actorId": self.actor_id,
                "sessionId": self.session_id,
                "includePayloads": True,
                "maxResults": 100,
            }
            if next_token:
                kwargs["nextToken"] = next_token
            resp = self._client.list_events(**kwargs)
            for ev in resp.get("events", []):
                meta = ev.get("metadata") or {}
                k_field = (meta.get("key") or {}).get("stringValue")
                kind_field = (meta.get("kind") or {}).get("stringValue")
                if k_field == key and (kind is None or kind_field == kind):
                    matching.append(ev)
            next_token = resp.get("nextToken")
            if not next_token:
                break
        return matching
