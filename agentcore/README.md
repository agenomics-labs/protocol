# agentcore — Surface 4 (AEP Reflex)

Autonomous **Strands SDK** agent that runs on **Bedrock AgentCore Runtime**, calls AEP MCP tools through **AgentCore Gateway**, and streams reasoning + payments + results back to the Seeker phone over SSE.

This is the AWS-judging-criterion centerpiece of the AEP Reflex demo. See `docs/aep-reflex-tech-spec.md` lines 365-472 (master) and `.kiro/specs/surface-4-agentcore/spec.md` (full self-contained spec) for the binding contracts.

## Layout

```
agentcore/
├── pyproject.toml             # uv/pip-compatible (PEP 621); see Strands pin notes inside
├── README.md                  # this file
├── src/agentcore/
│   ├── __init__.py
│   ├── agent_loop.py          # the planner-executor Strands loop (master §"agent loop")
│   ├── prompts.py             # ECONOMIC_REASONING_PROMPT (verbatim) + SYNTHESIS_PROMPT
│   ├── gateway.py             # MCP-over-Gateway tool catalogue loader (IC-2)
│   ├── memory.py              # AgentCore Memory protocol (decision_*, pricing_*) — STUB
│   ├── identity.py            # AgentCore Identity protocol (OAuth vault) — STUB
│   ├── nova_browser.py        # Nova Act sub-agent — STUB
│   ├── sse.py                 # SSE emitter (IC-1 producer side) — STUB
│   └── types.py               # Pydantic models for IC-1 / IC-3 / candidates
└── tests/
    ├── __init__.py
    ├── conftest.py            # fakes for Memory / Identity / Browser / Gateway
    └── test_agent_loop.py     # end-to-end round-trip with all stubs wired
```

## Running

Install with `uv` (preferred) or pip:

```bash
# uv
uv sync --extra dev

# pip
pip install -e '.[dev]'
```

> Do not run `pip install` blindly until you have the AWS creds + bedrock-runtime + AgentCore preview entitlements wired. Several deps require AWS-account-bound permissions at first invocation, not at install. Author-only installs (no LLM call) are safe.

Run the unit suite (no AWS, all stubs):

```bash
pytest -m "not live_aws"
```

Live-AWS tests are marked `@pytest.mark.skip` with `live_aws` reason. Enable by removing the skip and exporting `AWS_PROFILE` + `BEDROCK_AGENTCORE_*` env vars per AgentCore quickstart.

## What this scaffold gives you (Day 1-2)

- **Skeleton + agent loop only.** No real AWS calls. The loop is wired against in-memory fakes for Memory, Identity, Nova Act, and Gateway-wrapped MCP tools.
- The economic-reasoning prompt is **inlined verbatim** from master spec lines 433-452 (per acceptance criterion AC-13 — any change requires an ADR).
- IC-3 (`pay_x402_service`) is consumed exactly per master lines 109-134; the type model in `types.py` enforces the wire shape.

## What is **not** in this scaffold (Day 3+ work)

- Real Strands LLM invocation — the loop calls a `LLMClient` protocol; tests inject a fake.
- Real Nova Act `Browser` instance — the `NovaBrowser` stub returns a canned action result.
- Real SSE transport — `sse.py` writes to an in-memory queue; Surface 1 (IC-1) wires the HTTP transport.
- The AgentCore Gateway URL (`gateway.py` reads `AGENTCORE_GATEWAY_URL` from env; the canary call in AC-16 is a Day-2/3 task).
- DNS / TLS / Lambda authorizer for `reflex.agenomics.xyz` and `agent.agenomics.xyz` (open question OQ-S4-A).
- Self-monetized endpoint (AC-6) — separate CDK app, not scoped here.

## AWS deployment

The AgentCore Memory + Identity adapters in `memory.py` / `identity.py` are
Python `Protocol`s with two implementations side-by-side:

| Backend (env var `AGENTCORE_BACKEND=`) | Memory impl | Identity impl |
|---|---|---|
| `fake` (default) | `InMemoryAgentCoreMemory` | `InMemoryAgentCoreIdentity` |
| `aws` | `BedrockAgentCoreMemory` (`memory_aws.py`) | `BedrockAgentCoreIdentity` (`identity_aws.py`) |

`agent_loop.build_memory()` and `agent_loop.build_identity()` route on
`AGENTCORE_BACKEND`. The unit suite runs entirely against the fakes; AWS
deps are gated behind the `aws` extra.

### Install with AWS extras

```bash
# uv
uv sync --extra dev --extra aws

# pip
pip install -e '.[dev,aws]'
```

This pulls `boto3>=1.43`, `botocore>=1.43`, and the official
`bedrock-agentcore` SDK.

### Required env vars (when `AGENTCORE_BACKEND=aws`)

| Var | Required by | Purpose |
|---|---|---|
| `AWS_REGION` | both adapters | e.g. `us-east-1`. Falls back to AWS SDK default chain if unset. |
| `AGENTCORE_BACKEND=aws` | `agent_loop` | Switches both adapters to the boto3 impls. |
| `AGENTCORE_MEMORY_ID` | Memory | The memory resource id created via the control plane (`bedrock-agentcore-control:CreateMemory`) at deploy time. |
| `AGENTCORE_IDENTITY_WORKLOAD_NAME` | Identity (OAuth) | Workload identity name; the `GetWorkloadAccessToken` boto3 call uses this. |

`actor_id` (the agent's Solana pubkey) and `session_id` (per-request UUID
issued by IC-1) are passed at runtime by `run_session`, not via env.

### Required IAM permissions

The agent's runtime execution role needs:

```jsonc
{
  "Effect": "Allow",
  "Action": [
    // AgentCore Memory data plane
    "bedrock-agentcore:CreateEvent",
    "bedrock-agentcore:GetEvent",
    "bedrock-agentcore:ListEvents",
    "bedrock-agentcore:DeleteEvent",
    "bedrock-agentcore:GetMemoryRecord",
    "bedrock-agentcore:ListMemoryRecords",
    "bedrock-agentcore:RetrieveMemoryRecords",
    // AgentCore Identity (OAuth vault)
    "bedrock-agentcore:GetWorkloadAccessToken",
    "bedrock-agentcore:GetResourceOauth2Token"
  ],
  "Resource": "arn:aws:bedrock-agentcore:<region>:<account>:memory/<memory-id>"
},
{
  "Effect": "Allow",
  "Action": ["secretsmanager:GetSecretValue"],
  "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:aep/cdp-wallet/*"
}
```

Plus `bedrock:InvokeModel` for the Claude Sonnet 4 calls (LLM seam,
separate from these two adapters).

### Out-of-band provisioning (one-time, Day 3)

These are **not** done by `run_session`; they are deploy-time CDK / console
steps:

1. **Create the Memory resource** via
   `bedrock-agentcore-control:CreateMemory` (or the `bedrock_agentcore.memory.client.MemoryClient.create_memory_and_wait`
   helper). Capture the returned `memoryId` into `AGENTCORE_MEMORY_ID`.
   Configure long-term strategies (semantic / summary) here — the
   `kind="long"` writes from the loop are tagged so the strategy extractor
   picks them up.
2. **Create the Workload Identity** via the control plane and store its
   name in `AGENTCORE_IDENTITY_WORKLOAD_NAME`.
3. **Register OAuth2 credential providers** for any web2 sites Nova Act
   needs (Google, etc.) using `IdentityClient.create_oauth2_credential_provider`.
4. **Provision the CDP wallet secret** at
   `aep/cdp-wallet/<agent_address>` containing the opaque handle Surface 2
   expects (per master open question OQ-5).

## Open questions deferred (not resolved in scaffold)

See `.kiro/specs/surface-4-agentcore/open-questions.md`. Surfaced and **not** resolved by this scaffold:

- **OQ-2** Nova Act US-account access — stub assumes Nova Act path; falls back to AgentCore Browser + Playwright if R3 fires.
- **OQ-S4-B** Tool-count drift between `README.md` (27) and `docs/api-reference.md` (25). The Gateway loader trusts whatever Gateway's `tools/list` returns — count is informational only here.
- **OQ-S4-C** `SYNTHESIS_PROMPT` exact wording — placeholder in `prompts.py`, marked as draft.
- **OQ-S4-D** JWT issuance flow at app install — affects IC-1 ingress, not this scaffold.

## Stage gates

| Day | Deliverable | Status |
|---|---|---|
| 1-2 | Skeleton + agent loop with stubs (this scaffold) | done |
| 3 | Real Gateway hello-world (AC-16, R6 canary) | not started |
| 5-7 | LLM-real, MCP-mock e2e demoable (AC-1, AC-2, AC-13) | not started |
| 8-10 | Real Mobile + real AEP MCP integration (AC-3, AC-4, AC-5) | not started |
| 11 | Self-monetized endpoint live + rehearsal purchase (AC-6) | not started |
