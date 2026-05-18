# escrow-explorer

> **30-second pitch:** A read-only inspector for the Agenomics
> settlement program. Fetches the singleton `ProtocolConfig`
> governance parameters and renders any `TaskEscrow`'s lifecycle
> state (status, amount, milestone breakdown) straight from devnet.
> The honest read side of the agent-to-agent settlement loop — fork
> it as the foundation of any escrow dashboard or audit tool.

ADR-140 gallery entry (the read-only realization of the settlement
slice of gallery target entries #1/#2).

## What it shows

The `@agenomics/client` `SettlementClient` read surface, end-to-end:

```
connect -> fetch ProtocolConfig -> derive escrow PDA ->
fetch TaskEscrow -> render lifecycle state
```

- **ProtocolConfig** is a program singleton; the sample always
  derives and fetches it, rendering `minEscrowAmount` and
  `disputeTimeoutSeconds` (ADR-075 governance parameters).
- **TaskEscrow** is keyed by `(client, provider, taskId)`. Supply
  those via env vars to inspect a real escrow's `status`,
  `totalAmount`, and per-milestone breakdown.

## Honest scope

This sample is **read-only**, like every v1 gallery entry. The
**write side** of the settlement program — `createEscrow`, fund,
`approveMilestone`, dispute, settle — is out of scope for
`@agenomics/client@0.1.0` per ADR-098. Those are the documented SDK
roadmap. This sample shows the escrow lifecycle *as observed
on-chain*, not as driven by this script. See
[`samples/README.md`](../README.md) and `sdk/client/README.md`.

## Prerequisites

- **Node.js 20+**
- No wallet required (read-only; a throwaway keypair is generated
  internally and never used to sign).
- Network access to a Solana devnet RPC.

## Setup

`samples/` is excluded from the root workspaces glob (ADR-140); SDK
packages resolve via `file:` references back into the workspace.

```sh
cd samples/escrow-explorer
npm install
```

A local `node_modules/` and `package-lock.json` are created on first
run; both are intentionally not committed.

## Run

```sh
cd samples/escrow-explorer
npm start
```

To inspect a specific escrow, supply its tuple:

```sh
ESCROW_CLIENT="<client pubkey>" \
ESCROW_PROVIDER="<provider pubkey>" \
ESCROW_TASK_ID="1" \
npm start
```

Optionally override the RPC endpoint:

```sh
RPC_URL="https://your-private-rpc.example/devnet" npm start
```

## Expected output (no escrow target)

```
escrow-explorer — read-only settlement inspector (devnet)

settlement program: <settlement program id>

ProtocolConfig PDA: <derived PDA>
  min escrow amount:      <value>
  dispute timeout (s):    <value>
  (governance parameters per ADR-075)

no escrow target set. To inspect a specific TaskEscrow, set:
  ESCROW_CLIENT=<client pubkey> \
  ESCROW_PROVIDER=<provider pubkey> \
  ESCROW_TASK_ID=<u64 task id> \
  npm start

Known EscrowStatus variants the SDK decodes: Created, Active,
Completed, Disputed, Cancelled, Expired.
...
```

If the settlement program is not bootstrapped on the cluster (no
`ProtocolConfig` initialized), the sample prints a clear "not
bootstrapped" branch instead of crashing — it only reads.

With a valid escrow tuple, it additionally prints the escrow's
status, total amount, and milestone breakdown.

## Switching to npm dependencies (post-publish)

Once `@agenomics/idl` and `@agenomics/client` publish per
`docs/SDK_PUBLISH.md`, swap the `file:` references in
[`package.json`](./package.json) for semver ranges. That single edit
is everything an external consumer changes; the sample code does
not change.

## Maintainer

Maintained by **k2jac9** (`k2jac9@users.noreply.github.com`).
