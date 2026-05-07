"""Unit tests for `agentcore.memory_aws.BedrockAgentCoreMemory`.

These tests do NOT call AWS. The boto3 client is replaced with a
`MagicMock`; every test asserts that the right boto3 method was called
with the right kwargs. There is one live integration test at the bottom
marked ``@pytest.mark.skip`` + ``@pytest.mark.live_aws`` describing the
env-var dance to enable.
"""

from __future__ import annotations

import datetime as dt
import json
from unittest.mock import MagicMock

import pytest

from agentcore.memory_aws import BedrockAgentCoreMemory


@pytest.fixture
def fake_client() -> MagicMock:
    """A MagicMock standing in for the boto3 `bedrock-agentcore` client."""
    client = MagicMock()
    # Default behaviour: no events, no nextToken.
    client.list_events.return_value = {"events": []}
    return client


@pytest.fixture
def mem(fake_client: MagicMock) -> BedrockAgentCoreMemory:
    return BedrockAgentCoreMemory(
        memory_id="mem-1234",
        actor_id="actorAgentSolanaPubkey",
        session_id="session-abc",
        region_name="us-east-1",
        client=fake_client,
    )


# --------------------------------------------------------------- write


@pytest.mark.asyncio
async def test_write_calls_create_event_with_blob_payload_and_metadata(
    mem: BedrockAgentCoreMemory, fake_client: MagicMock
) -> None:
    await mem.write("decision_xyz", {"task": "summarize", "score": 0.42})

    fake_client.create_event.assert_called_once()
    kwargs = fake_client.create_event.call_args.kwargs

    assert kwargs["memoryId"] == "mem-1234"
    assert kwargs["actorId"] == "actorAgentSolanaPubkey"
    assert kwargs["sessionId"] == "session-abc"
    assert isinstance(kwargs["eventTimestamp"], dt.datetime)

    # payload is a list with a single dict containing a JSON-encoded blob.
    payload = kwargs["payload"]
    assert len(payload) == 1
    blob = payload[0]["blob"]
    assert json.loads(blob.decode("utf-8")) == {"task": "summarize", "score": 0.42}

    # metadata round-trips both `key` and `kind`.
    metadata = kwargs["metadata"]
    assert metadata["key"] == {"stringValue": "decision_xyz"}
    assert metadata["kind"] == {"stringValue": "short"}


@pytest.mark.asyncio
async def test_write_long_kind_metadata(
    mem: BedrockAgentCoreMemory, fake_client: MagicMock
) -> None:
    await mem.write("pricing_https://x.example", {"amount": 1000}, kind="long")
    metadata = fake_client.create_event.call_args.kwargs["metadata"]
    assert metadata["kind"] == {"stringValue": "long"}


# ---------------------------------------------------------------- read


@pytest.mark.asyncio
async def test_read_returns_decoded_payload_when_event_exists(
    mem: BedrockAgentCoreMemory, fake_client: MagicMock
) -> None:
    fake_client.list_events.return_value = {
        "events": [
            {
                "eventId": "evt-1",
                "metadata": {
                    "key": {"stringValue": "decision_xyz"},
                    "kind": {"stringValue": "short"},
                },
                "payload": [{"blob": json.dumps({"hello": "world"}).encode("utf-8")}],
            }
        ]
    }
    out = await mem.read("decision_xyz")
    assert out == {"hello": "world"}

    # list_events must be called with the session/actor scoping.
    kwargs = fake_client.list_events.call_args.kwargs
    assert kwargs["memoryId"] == "mem-1234"
    assert kwargs["actorId"] == "actorAgentSolanaPubkey"
    assert kwargs["sessionId"] == "session-abc"
    assert kwargs["includePayloads"] is True


@pytest.mark.asyncio
async def test_read_returns_none_when_no_match(
    mem: BedrockAgentCoreMemory, fake_client: MagicMock
) -> None:
    fake_client.list_events.return_value = {"events": []}
    assert await mem.read("decision_missing") is None


# --------------------------------------------------------------- query


@pytest.mark.asyncio
async def test_query_filters_by_prefix_and_paginates(
    mem: BedrockAgentCoreMemory, fake_client: MagicMock
) -> None:
    page1 = {
        "events": [
            {
                "metadata": {
                    "key": {"stringValue": "decision_a"},
                    "kind": {"stringValue": "short"},
                },
                "payload": [{"blob": json.dumps({"v": 1}).encode("utf-8")}],
            },
            {
                "metadata": {
                    "key": {"stringValue": "pricing_xyz"},
                    "kind": {"stringValue": "long"},
                },
                "payload": [{"blob": json.dumps({"v": 99}).encode("utf-8")}],
            },
        ],
        "nextToken": "page-2",
    }
    page2 = {
        "events": [
            {
                "metadata": {
                    "key": {"stringValue": "decision_b"},
                    "kind": {"stringValue": "short"},
                },
                "payload": [{"blob": json.dumps({"v": 2}).encode("utf-8")}],
            },
        ],
    }
    fake_client.list_events.side_effect = [page1, page2]

    out = await mem.query("decision_")
    assert out == {"decision_a": {"v": 1}, "decision_b": {"v": 2}}

    # Two pages = two list_events calls; the second carries nextToken.
    assert fake_client.list_events.call_count == 2
    second_call_kwargs = fake_client.list_events.call_args_list[1].kwargs
    assert second_call_kwargs["nextToken"] == "page-2"


@pytest.mark.asyncio
async def test_query_kind_filter(
    mem: BedrockAgentCoreMemory, fake_client: MagicMock
) -> None:
    fake_client.list_events.return_value = {
        "events": [
            {
                "metadata": {
                    "key": {"stringValue": "pricing_a"},
                    "kind": {"stringValue": "long"},
                },
                "payload": [{"blob": json.dumps({"v": 1}).encode("utf-8")}],
            },
            {
                "metadata": {
                    "key": {"stringValue": "pricing_b"},
                    "kind": {"stringValue": "short"},
                },
                "payload": [{"blob": json.dumps({"v": 2}).encode("utf-8")}],
            },
        ],
    }
    out = await mem.query("pricing_", kind="long")
    assert out == {"pricing_a": {"v": 1}}


# -------------------------------------------------------------- delete


@pytest.mark.asyncio
async def test_delete_calls_delete_event_for_each_match(
    mem: BedrockAgentCoreMemory, fake_client: MagicMock
) -> None:
    fake_client.list_events.return_value = {
        "events": [
            {
                "eventId": "evt-1",
                "metadata": {
                    "key": {"stringValue": "decision_xyz"},
                    "kind": {"stringValue": "short"},
                },
                "payload": [{"blob": b"{}"}],
            },
            {
                "eventId": "evt-2",
                "metadata": {
                    "key": {"stringValue": "decision_xyz"},
                    "kind": {"stringValue": "short"},
                },
                "payload": [{"blob": b"{}"}],
            },
        ]
    }
    await mem.delete("decision_xyz")
    assert fake_client.delete_event.call_count == 2
    for call in fake_client.delete_event.call_args_list:
        kw = call.kwargs
        assert kw["memoryId"] == "mem-1234"
        assert kw["sessionId"] == "session-abc"
        assert kw["actorId"] == "actorAgentSolanaPubkey"
        assert kw["eventId"] in {"evt-1", "evt-2"}


# -------------------------------------------------------------- live


@pytest.mark.skip(
    reason=(
        "live_aws: requires AWS_REGION + AGENTCORE_MEMORY_ID + valid AWS"
        " credentials with bedrock-agentcore permissions. To enable, export"
        " AWS_REGION, AGENTCORE_MEMORY_ID, AGENTCORE_BACKEND=aws, then run"
        " `pytest -m live_aws tests/test_memory_aws.py::test_live_round_trip`."
    )
)
@pytest.mark.live_aws
@pytest.mark.asyncio
async def test_live_round_trip() -> None:
    """Real AWS smoke: write → read → query → delete against a real Memory.

    Env vars required:
      AWS_REGION                     e.g. us-east-1
      AGENTCORE_MEMORY_ID            from the Memory resource provisioned
                                     out-of-band (see README)
    Optional:
      AWS_PROFILE                    default credential chain otherwise
    """
    raise NotImplementedError("Day 3+: enable when AgentCore Memory provisioned.")
