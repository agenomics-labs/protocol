"""Wire-shape Pydantic models for Surface 4.

Pinned to interface contracts in master spec docs/aep-reflex-tech-spec.md:

  IC-1 lines  79-103   Mobile -> AgentCore (session create + SSE stream)
  IC-3 lines 109-134   pay_x402_service tool (consumed only; Surface 2 owns)

Anything that crosses a surface boundary should be modelled here. Adding a
field is fine; renaming or removing one is an ADR-required interface change.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, NonNegativeInt


# -- IC-1: Mobile -> AgentCore ------------------------------------------------


class SessionRequest(BaseModel):
    """POST /v1/sessions body. IC-1, master lines 84-89."""

    agent_address: str = Field(..., description="Solana pubkey (base58)")
    prompt: str = Field(..., description="User natural-language task")
    budget_usdc_micros: NonNegativeInt = Field(
        ..., description="Already-signed Vault delegation amount"
    )
    vault_session_signature: str = Field(
        ..., description="Solana signature over the budget delegation"
    )


class SessionAck(BaseModel):
    """POST /v1/sessions response. IC-1, master lines 91-93."""

    session_id: str
    stream_url: str


SSEEventName = Literal["reasoning", "payment", "result", "done"]


class ReasoningEvent(BaseModel):
    """SSE 'reasoning' event payload. IC-1, master line 99."""

    decision_text: str
    candidates: list["Candidate"]
    selection: list["Selection"]


class PaymentEvent(BaseModel):
    """SSE 'payment' event payload. IC-1, master line 100."""

    service_url: str
    amount: int
    tx_hash: str
    network: Literal["base-mainnet", "base-sepolia", "solana-devnet"]


class ResultEvent(BaseModel):
    """SSE 'result' event payload. IC-1, master line 101."""

    final_output: str
    total_spent: int
    refund: int = 0


class DoneEvent(BaseModel):
    """SSE 'done' event payload. IC-1, master line 102."""

    session_id: str


# -- Candidates produced by Plan + consumed by Reason/Execute -----------------


class Candidate(BaseModel):
    """One row in the candidates table fed to the economic-reasoning prompt.

    `source` discriminates the execution path in the agent loop (master §"agent
    loop", lines 404-417): AEP -> create_escrow + accept_task; x402 ->
    pay_x402_service.
    """

    name: str
    source: Literal["aep", "x402"]
    url: str | None = None  # x402-protected URL, None for AEP path
    agent: str | None = None  # Solana pubkey, None for x402 path
    price_usdc_micros: NonNegativeInt
    reputation: float = Field(..., ge=0.0, le=1.0)
    historical_reliability: float = Field(..., ge=0.0, le=1.0)
    metadata: dict[str, Any] = Field(default_factory=dict)


class Selection(BaseModel):
    """One pick from the LLM's selection array. Maps to a single execute step."""

    type: Literal["aep", "x402"]
    name: str
    url: str | None = None
    agent: str | None = None
    price: NonNegativeInt = Field(..., description="Hard cap in USDC micros")
    score: float
    justification: str = Field(
        ...,
        description="Mandatory `reasoning` field on pay_x402_service (IC-3 line 121).",
    )


# -- IC-3: pay_x402_service ---------------------------------------------------
#
# Surface 4 only consumes this tool; do not edit field names without
# coordination with Surface 2. Master lines 109-134.


class X402Request(BaseModel):
    method: Literal["GET", "POST"]
    headers: dict[str, str] | None = None
    body: str | None = None


class PayX402ServiceArgs(BaseModel):
    agent_address: str
    service_url: str
    max_price_usdc_micros: NonNegativeInt
    request: X402Request
    reasoning: str = Field(
        ...,
        min_length=1,
        description=(
            "MANDATORY per IC-3 line 136 — calls without it are rejected. "
            "Primary AWS judging-criterion artifact."
        ),
    )


class PaymentReceipt(BaseModel):
    """`payment` field of pay_x402_service response. IC-3 lines 124-129."""

    tx_hash: str
    amount_paid_micros: NonNegativeInt
    network: Literal["base-mainnet", "base-sepolia"]
    facilitator: Literal["cdp", "kora"]


class PayX402ServiceResult(BaseModel):
    """Full pay_x402_service response. IC-3 lines 122-133."""

    status: int
    body: str
    payment: PaymentReceipt
    duration_ms: int
    decision_record_id: str


# -- AEP-path execute leg -----------------------------------------------------


class EscrowResult(BaseModel):
    """Subset of create_escrow / accept_task response Surface 4 cares about."""

    escrow: str
    seller: str
    amount_usdc_micros: NonNegativeInt
    tx_hash: str | None = None


# -- Session result -----------------------------------------------------------


class SessionResult(BaseModel):
    """In-process return value of run_session. Not on the wire."""

    session_id: str
    final_output: str
    total_spent_micros: int
    refund_micros: int
    decision_record_ids: list[str]
    payment_receipts: list[PaymentReceipt]


# Pydantic forward-ref resolution
ReasoningEvent.model_rebuild()
