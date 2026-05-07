"""The Strands agent's main loop.

Implements the planner-executor sketch in master spec §"agent loop"
(lines 380-426). Side-effects:
  * AgentCore Memory writes (`decision_*`, `pricing_*` keys) — AC-3.
  * SSE event emission (reasoning / payment / result / done) — IC-1, AC-1.
  * Gateway-wrapped MCP tool calls — IC-2, AC-16.

Day 1-2 scope: skeleton + tests against in-memory fakes. The LLM is
abstracted behind `LLMClient` so the same loop runs against the real Bedrock
Claude Sonnet 4 (Day 3+) and against a deterministic test fake.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

from agentcore.gateway import MCPGatewayClient
from agentcore.identity import AgentCoreIdentity, InMemoryAgentCoreIdentity
from agentcore.memory import AgentCoreMemory, InMemoryAgentCoreMemory
from agentcore.nova_browser import NovaBrowser
from agentcore.prompts import (
    ECONOMIC_REASONING_PROMPT,
    SYNTHESIS_PROMPT,
    render_candidates_table,
)
from agentcore.sse import SSEEmitter
from agentcore.types import (
    Candidate,
    PayX402ServiceArgs,
    PaymentReceipt,
    SessionRequest,
    SessionResult,
    Selection,
    X402Request,
)

logger = logging.getLogger(__name__)


# ----- LLM seam --------------------------------------------------------------


class LLMClient(Protocol):
    """Bedrock Claude Sonnet 4 invocation seam.

    Day 3+ real impl: `boto3.client("bedrock-runtime").invoke_model(...)` or
    Strands' built-in `BedrockModel`. Day 1-2: tests inject a deterministic
    fake that returns the JSON shape the economic-reasoning prompt asks for.
    """

    async def invoke(self, *, prompt: str, max_tokens: int = 400) -> str: ...


# ----- Helpers ---------------------------------------------------------------


def infer_capability(prompt: str) -> str:
    """Extract a discover_agents `capability` filter from a free-text task.

    Day 1-2: keyword heuristic. Day 3+: optionally LLM-driven.
    """
    p = prompt.lower()
    if "image" in p or "picture" in p or "photo" in p:
        return "image-generation"
    if "translate" in p or "translation" in p:
        return "translation"
    if "summari" in p:
        return "summarization"
    if "search" in p or "find" in p or "browse" in p:
        return "search"
    return "general"


def build_request_for_x402(choice: Selection, prompt: str) -> X402Request:
    """Assemble the `request` payload for pay_x402_service (IC-3 line 117).

    Day 1-2: every x402 candidate is exercised as `POST` with the user prompt
    in the body. Day 3+: per-candidate templating from the candidate's
    metadata (declared in discover_agents / bazaar_search response).
    """
    return X402Request(
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json.dumps({"prompt": prompt}),
    )


def parse_selection(reasoning_json: str) -> tuple[str, list[Selection]]:
    """Parse the LLM output of the economic-reasoning prompt.

    Returns `(decision_text, selection)` where `decision_text` is what we
    stream as the SSE 'reasoning' event payload (master line 99 + line 155).
    """
    payload = json.loads(reasoning_json)
    decision_text: str = payload["reasoning"]
    raw_selection: list[dict[str, Any]] = payload.get("selection", [])
    selection = [Selection.model_validate(row) for row in raw_selection]
    return decision_text, selection


# ----- Session config + system prompt ---------------------------------------

# System prompt: short, role-defining preamble for the Strands agent. The
# economic reasoning happens in a separate, fully-templated prompt
# (ECONOMIC_REASONING_PROMPT) which is what the AWS judges read. This system
# prompt only sets context.
SYSTEM_PROMPT = """\
You are the AEP Reflex agent. You spend USDC autonomously on behalf of a
Solana-wallet-authenticated user, calling AEP MCP tools through a Gateway.
You always (a) plan candidates from both AEP-native providers and the x402
Bazaar, (b) reason economically with explicit numerical scoring, and (c)
narrate every decision back to the user over SSE in real time. Mandatory
honesty: every payment must include a `reasoning` justification and is
auditable on-chain.
"""


@dataclass
class SessionDeps:
    """Everything the loop needs, injected once per session."""

    gateway: MCPGatewayClient
    memory: AgentCoreMemory
    identity: AgentCoreIdentity
    browser: NovaBrowser
    llm: LLMClient
    sse: SSEEmitter


# ----- Backend selection ----------------------------------------------------


def _resolve_backend() -> str:
    """Return the configured backend, defaulting to `fake`.

    `AGENTCORE_BACKEND=aws`  -> use boto3-backed adapters in
                                ``agentcore.memory_aws`` /
                                ``agentcore.identity_aws``. Requires
                                ``boto3`` and the relevant env vars
                                (see README §AWS deployment).
    `AGENTCORE_BACKEND=fake` (or unset) -> use the in-memory fakes.
    """
    return os.environ.get("AGENTCORE_BACKEND", "fake").lower()


def build_memory(*, actor_id: str, session_id: str) -> AgentCoreMemory:
    """Construct the AgentCoreMemory for this session per `AGENTCORE_BACKEND`.

    Kept separate from `build_identity` because the AWS impl needs the
    per-session ``session_id`` baked in (the boto3 calls require it on every
    request) while Identity does not.
    """
    backend = _resolve_backend()
    if backend == "aws":
        # Lazy import: never load boto3 unless explicitly requested.
        from agentcore.memory_aws import BedrockAgentCoreMemory

        return BedrockAgentCoreMemory(actor_id=actor_id, session_id=session_id)
    if backend == "fake":
        return InMemoryAgentCoreMemory()
    raise ValueError(
        f"AGENTCORE_BACKEND={backend!r}; expected 'aws' or 'fake'"
    )


def build_identity() -> AgentCoreIdentity:
    """Construct the AgentCoreIdentity per `AGENTCORE_BACKEND`."""
    backend = _resolve_backend()
    if backend == "aws":
        from agentcore.identity_aws import BedrockAgentCoreIdentity

        return BedrockAgentCoreIdentity()
    if backend == "fake":
        return InMemoryAgentCoreIdentity()
    raise ValueError(
        f"AGENTCORE_BACKEND={backend!r}; expected 'aws' or 'fake'"
    )


# ----- The loop --------------------------------------------------------------


async def run_session(req: SessionRequest, deps: SessionDeps) -> SessionResult:
    """Master spec §"agent loop", lines 380-426 — implemented.

    Returns once `done` has been streamed; SSE consumer is expected to be
    draining concurrently in real deployments.
    """
    session_id = uuid.uuid4().hex

    # 0. Pre-warm: list Gateway tools so the catalogue is populated before
    # the planner runs (master line 210, perf target AC-7).
    tool_catalogue = await deps.gateway.list_tools()
    logger.info("gateway tools loaded", extra={"count": len(tool_catalogue)})

    # 1. PLAN — discover AEP-native + Bazaar candidates in parallel.
    capability = infer_capability(req.prompt)
    aep_candidates, bazaar_candidates = (
        await deps.gateway.discover_agents(capability=capability),
        await deps.gateway.x402_bazaar_search(query=req.prompt),
    )
    candidates: list[Candidate] = list(aep_candidates) + list(bazaar_candidates)

    # AC-2: at least 3 candidates evaluated per task.
    if len(candidates) < 3:
        logger.warning(
            "fewer than 3 candidates discovered; AC-2 will fail in production",
            extra={"count": len(candidates)},
        )

    # 2. REASON — invoke LLM with the economic-reasoning prompt (verbatim).
    reasoning_prompt = ECONOMIC_REASONING_PROMPT.format(
        budget_micros=req.budget_usdc_micros,
        N=len(candidates),
        task=req.prompt,
        candidates_table=render_candidates_table(
            [c.model_dump() for c in candidates]
        ),
        k=min(3, len(candidates)),
    )
    raw_reasoning = await deps.llm.invoke(prompt=reasoning_prompt, max_tokens=400)
    decision_text, selection = parse_selection(raw_reasoning)

    # AC-3: write decision_<session_id> to AgentCore Memory.
    decision_key = f"decision_{session_id}"
    await deps.memory.write(
        decision_key,
        {
            "raw": raw_reasoning,
            "decision_text": decision_text,
            "candidates": [c.model_dump() for c in candidates],
            "selection": [s.model_dump() for s in selection],
            "task": req.prompt,
            "budget_usdc_micros": req.budget_usdc_micros,
        },
    )

    # IC-1: stream the reasoning event.
    await deps.sse.emit(
        "reasoning",
        {
            "decision_text": decision_text,
            "candidates": [c.model_dump() for c in candidates],
            "selection": [s.model_dump() for s in selection],
        },
    )

    # 3. EXECUTE — dispatch each pick.
    payment_receipts: list[PaymentReceipt] = []
    decision_record_ids: list[str] = [decision_key]
    total_spent = 0
    raw_results: list[dict[str, Any]] = []

    for choice in selection:
        if choice.type == "aep":
            assert choice.agent is not None, "AEP selection missing agent pubkey"
            escrow = await deps.gateway.create_escrow(
                seller=choice.agent,
                amount_usdc_micros=choice.price,
                agent_address=req.agent_address,
            )
            await deps.gateway.accept_task(escrow=escrow.escrow)
            # NOTE: Real loop awaits submit_milestone + biometric approve on
            # the phone (master line 410). Day 1-2 stub treats acceptance as
            # terminal so the e2e round-trip closes; revisit Day 5+.
            total_spent += escrow.amount_usdc_micros
            await deps.sse.emit(
                "payment",
                {
                    "service_url": f"aep://{choice.agent}",
                    "amount": escrow.amount_usdc_micros,
                    "tx_hash": escrow.tx_hash or "",
                    "network": "solana-devnet",
                },
            )
            raw_results.append(
                {
                    "name": choice.name,
                    "source": "aep",
                    "escrow": escrow.escrow,
                    "tx_hash": escrow.tx_hash,
                }
            )

        elif choice.type == "x402":
            assert choice.url is not None, "x402 selection missing service_url"
            args = PayX402ServiceArgs(
                agent_address=req.agent_address,
                service_url=choice.url,
                max_price_usdc_micros=choice.price,
                request=build_request_for_x402(choice, req.prompt),
                # IC-3 line 121 — mandatory.
                reasoning=choice.justification,
            )
            t0 = time.perf_counter()
            r = await deps.gateway.pay_x402_service(args)
            duration_ms = int((time.perf_counter() - t0) * 1000)

            payment_receipts.append(r.payment)
            decision_record_ids.append(r.decision_record_id)
            total_spent += r.payment.amount_paid_micros

            # AC-3: pricing history (long-term key space).
            await deps.memory.write(
                f"pricing_{choice.url}",
                {
                    "agent_address": req.agent_address,
                    "amount_paid_micros": r.payment.amount_paid_micros,
                    "tx_hash": r.payment.tx_hash,
                    "duration_ms": duration_ms,
                    "session_id": session_id,
                },
                kind="long",
            )

            await deps.sse.emit(
                "payment",
                {
                    "service_url": choice.url,
                    "amount": r.payment.amount_paid_micros,
                    "tx_hash": r.payment.tx_hash,
                    "network": r.payment.network,
                },
            )
            raw_results.append(
                {
                    "name": choice.name,
                    "source": "x402",
                    "status": r.status,
                    "body": r.body,
                    "tx_hash": r.payment.tx_hash,
                }
            )

        else:  # pragma: no cover — Selection type is Literal-narrowed
            raise ValueError(f"unknown selection type: {choice.type!r}")

    # 4. SYNTHESIZE — final user-facing answer.
    synthesis = await deps.llm.invoke(
        prompt=SYNTHESIS_PROMPT.format(
            total_spent_micros=total_spent,
            n_calls=len(raw_results),
            task=req.prompt,
            results_table=json.dumps(raw_results, indent=2),
        ),
        max_tokens=400,
    )

    refund = max(0, req.budget_usdc_micros - total_spent)

    await deps.sse.emit(
        "result",
        {
            "final_output": synthesis,
            "total_spent": total_spent,
            "refund": refund,
        },
    )
    await deps.sse.close()

    return SessionResult(
        session_id=session_id,
        final_output=synthesis,
        total_spent_micros=total_spent,
        refund_micros=refund,
        decision_record_ids=decision_record_ids,
        payment_receipts=payment_receipts,
    )
