"""Test fakes for the agent-loop round-trip.

These fakes implement the same Protocols as the real adapters in
`src/agentcore/`. They are wired together by `make_session_deps()` below so
each test can construct a fully-mocked SessionDeps in one line.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import pytest

from agentcore.agent_loop import LLMClient, SessionDeps
from agentcore.gateway import MCPGatewayClient, MCPToolDescriptor
from agentcore.identity import InMemoryAgentCoreIdentity
from agentcore.memory import InMemoryAgentCoreMemory
from agentcore.nova_browser import StubNovaBrowser
from agentcore.sse import SSEEmitter
from agentcore.types import (
    Candidate,
    EscrowResult,
    PayX402ServiceArgs,
    PayX402ServiceResult,
    PaymentReceipt,
)


# --- LLM fake ---------------------------------------------------------------


@dataclass
class FakeLLMClient:
    """Returns a canned reasoning JSON on the first call (matching the
    economic-reasoning prompt's expected shape) and a canned synthesis
    string on the second."""

    canned_reasoning: dict[str, Any] = field(default_factory=dict)
    canned_synthesis: str = "stub synthesis: used candidates A and B."
    calls: list[str] = field(default_factory=list)

    async def invoke(self, *, prompt: str, max_tokens: int = 400) -> str:
        self.calls.append(prompt)
        if "Output JSON" in prompt:  # economic-reasoning
            return json.dumps(self.canned_reasoning)
        return self.canned_synthesis


# --- Gateway fake -----------------------------------------------------------


@dataclass
class FakeMCPGatewayClient:
    """Behaviour:
    * `list_tools` returns a 3-item catalogue.
    * `discover_agents` returns 1 AEP candidate.
    * `x402_bazaar_search` returns 2 x402 candidates.
    * `create_escrow` / `accept_task` echo a deterministic EscrowResult.
    * `pay_x402_service` returns a deterministic PayX402ServiceResult.
    """

    aep_candidates: list[Candidate] = field(default_factory=list)
    bazaar_candidates: list[Candidate] = field(default_factory=list)
    pay_log: list[PayX402ServiceArgs] = field(default_factory=list)

    async def list_tools(self) -> list[MCPToolDescriptor]:
        return [
            MCPToolDescriptor(name="discover_agents", description=""),
            MCPToolDescriptor(name="x402_bazaar_search", description=""),
            MCPToolDescriptor(name="pay_x402_service", description=""),
        ]

    async def call_tool(self, name: str, args: dict[str, Any]) -> Any:
        raise NotImplementedError(f"unexpected generic call_tool: {name}")

    async def discover_agents(self, *, capability: str) -> list[Candidate]:
        return list(self.aep_candidates)

    async def x402_bazaar_search(self, *, query: str) -> list[Candidate]:
        return list(self.bazaar_candidates)

    async def create_escrow(
        self, *, seller: str, amount_usdc_micros: int, agent_address: str
    ) -> EscrowResult:
        return EscrowResult(
            escrow=f"escrow-{seller[:6]}",
            seller=seller,
            amount_usdc_micros=amount_usdc_micros,
            tx_hash=f"sol-tx-{seller[:6]}",
        )

    async def accept_task(self, *, escrow: str) -> EscrowResult:
        return EscrowResult(
            escrow=escrow,
            seller="acked",
            amount_usdc_micros=0,
            tx_hash=f"sol-accept-{escrow}",
        )

    async def pay_x402_service(self, args: PayX402ServiceArgs) -> PayX402ServiceResult:
        # IC-3 contract: `reasoning` is mandatory.
        if not args.reasoning.strip():
            raise ValueError("pay_x402_service: reasoning is mandatory (IC-3)")
        self.pay_log.append(args)
        return PayX402ServiceResult(
            status=200,
            body=json.dumps({"echo": args.service_url}),
            payment=PaymentReceipt(
                tx_hash=f"base-tx-{len(self.pay_log)}",
                amount_paid_micros=args.max_price_usdc_micros,
                network="base-sepolia",
                facilitator="cdp",
            ),
            duration_ms=123,
            decision_record_id=f"decrec-{len(self.pay_log)}",
        )


# --- Wiring fixture ---------------------------------------------------------


@pytest.fixture
def session_deps() -> SessionDeps:
    """Default deps for round-trip tests. Override fields per-test as needed."""
    aep = [
        Candidate(
            name="aep-summarizer-7",
            source="aep",
            agent="AEPagentSolanaPubkey1111111111111111",
            price_usdc_micros=5_000,
            reputation=0.9,
            historical_reliability=0.95,
        ),
    ]
    bazaar = [
        Candidate(
            name="bazaar-search-A",
            source="x402",
            url="https://example.com/bazaar/a",
            price_usdc_micros=2_000,
            reputation=0.8,
            historical_reliability=0.9,
        ),
        Candidate(
            name="bazaar-search-B",
            source="x402",
            url="https://example.com/bazaar/b",
            price_usdc_micros=4_000,
            reputation=0.7,
            historical_reliability=0.85,
        ),
    ]
    gateway = FakeMCPGatewayClient(aep_candidates=aep, bazaar_candidates=bazaar)

    canned_reasoning = {
        "ranked_candidates": [
            {"name": "bazaar-search-A", "score": 0.36},
            {"name": "bazaar-search-B", "score": 0.149},
            {"name": "aep-summarizer-7", "score": 0.171},
        ],
        # AC-2: pick at least 1 from each path so the test exercises both
        # branches of the executor (master lines 404-417).
        "selection": [
            {
                "type": "x402",
                "name": "bazaar-search-A",
                "url": "https://example.com/bazaar/a",
                "price": 2_000,
                "score": 0.36,
                "justification": (
                    "Highest score (0.36) by 1/price * reputation * reliability;"
                    " fits well within budget."
                ),
            },
            {
                "type": "aep",
                "name": "aep-summarizer-7",
                "agent": "AEPagentSolanaPubkey1111111111111111",
                "price": 5_000,
                "score": 0.171,
                "justification": (
                    "AEP-native fallback at score 0.171; on-chain reputation"
                    " 0.90 makes it the safest second pick."
                ),
            },
        ],
        "reasoning": (
            "Picked bazaar-search-A (score 0.36) as primary because it has the"
            " best price/reliability ratio at 2000 micros. Added"
            " aep-summarizer-7 (score 0.171) as an AEP-native fallback for"
            " redundancy under a 100000-micro budget."
        ),
    }

    deps = SessionDeps(
        gateway=gateway,
        memory=InMemoryAgentCoreMemory(),
        identity=InMemoryAgentCoreIdentity(),
        browser=StubNovaBrowser(),
        llm=FakeLLMClient(canned_reasoning=canned_reasoning),
        sse=SSEEmitter(session_id="test-session"),
    )
    return deps
