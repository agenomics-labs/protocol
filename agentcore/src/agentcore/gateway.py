"""AgentCore Gateway adapter — IC-2 (master lines 105-107).

Wraps the AEP MCP server (`@agenomics/mcp-server`) as MCP tools the Strands
agent can list and call. The tool catalogue is fetched at session start so
Strands' tool registry is populated before the planner runs — this also
pre-warms the Gateway connection (master line 210, performance target AC-7).

STUB-friendly: a `MCPGatewayClient` Protocol describes the shape; the real
implementation will use the `mcp` package's HTTP/JSON-RPC transport pointed
at `${AGENTCORE_GATEWAY_URL}`. Tests inject `FakeMCPGatewayClient`.

Tool count drift (open question OQ-S4-B): README says 27, api-reference says
25, master says 27 + 1 new = 28 after Surface 2 ships. We trust whatever
`tools/list` returns — count is informational here.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Protocol

from agentcore.types import (
    Candidate,
    EscrowResult,
    PayX402ServiceArgs,
    PayX402ServiceResult,
)


@dataclass
class MCPToolDescriptor:
    """One row of `tools/list`. Strands registers each as a callable tool."""

    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)


class MCPGatewayClient(Protocol):
    """Protocol the agent loop uses to talk to the Gateway-wrapped AEP MCP.

    All methods correspond to specific AEP tools that the planner-executor
    flow needs. Anything else uses `call_tool` generically.
    """

    async def list_tools(self) -> list[MCPToolDescriptor]:
        """JSON-RPC `tools/list`. Master line 374, AC-16.

        TODO(Day 3+): real client hits ${AGENTCORE_GATEWAY_URL}.
        """
        ...

    async def call_tool(self, name: str, args: dict[str, Any]) -> Any:
        """JSON-RPC `tools/call`. Generic escape hatch for tools the typed
        helpers below don't cover."""
        ...

    # Typed helpers for the hot-path tools the agent loop calls directly.

    async def discover_agents(self, *, capability: str) -> list[Candidate]:
        """AEP-native candidate set. Master line 84."""
        ...

    async def x402_bazaar_search(self, *, query: str) -> list[Candidate]:
        """Bazaar candidate set. Master line 85."""
        ...

    async def create_escrow(
        self, *, seller: str, amount_usdc_micros: int, agent_address: str
    ) -> EscrowResult:
        """Master line 408 (AEP execution leg)."""
        ...

    async def accept_task(self, *, escrow: str) -> EscrowResult:
        """Master line 409."""
        ...

    async def pay_x402_service(self, args: PayX402ServiceArgs) -> PayX402ServiceResult:
        """IC-3 (master lines 109-134). Surface 4 consumes only — Surface 2
        owns the implementation. Wire shape MUST match `PayX402ServiceArgs`
        exactly; renaming a field is an ADR-required interface change."""
        ...


def gateway_url_from_env() -> str:
    """Resolve the Gateway URL from `AGENTCORE_GATEWAY_URL`.

    Day 1-2 default: `http://localhost:8787` (matches the smoke harness for
    the AEP MCP server). Day 3+ canary points at the real Gateway endpoint.
    """
    return os.environ.get("AGENTCORE_GATEWAY_URL", "http://localhost:8787")
