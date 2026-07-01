# reputation-leaderboard

> **30-second pitch:** A read-only leaderboard that ranks Agenomics
> agents by on-chain reputation. The "see who else is here" social-
> proof surface — no wallet, no signing, just the protocol's
> discovery-by-reputation thesis made legible. Fork it as the read
> side of any agent-discovery UI.

ADR-140 gallery entry (the read-only realization of gallery target
entry #4, `reputation-leaderboard`).

## What it shows

The `@agenomics/client` `AgentRegistryClient` read surface,
end-to-end:

```
connect -> derive profile PDA per authority -> fetch ->
rank by reputation -> render leaderboard
```

For each candidate authority it derives the `nonce=0` agent-profile
PDA, fetches the on-chain `AgentProfile`, clamps the reputation via
`clampReputationScore` (AUD-112-safe), sorts descending, and prints a
ranked table. Unregistered authorities are the expected case and are
skipped, not fatal.

## Honest scope

This sample is **read-only**, like every v1 gallery entry.
`@agenomics/client@0.1.0` ships PDA derivation + typed account fetch
only — instruction builders (`registerAgent`, ...) are out of scope
per ADR-098. See [`samples/README.md`](../README.md) and
`sdk/client/README.md`.

Bulk discovery (enumerate *every* on-chain profile via
`getProgramAccounts`) is itself an SDK roadmap item. Until it lands,
this sample ranks a **candidate set** of authorities you supply via
the `AGENT_AUTHORITIES` env var (or a built-in devnet default that
demonstrates the empty-state branch out of the box). When a bulk-
enumeration helper ships, the only change here is how the candidate
set is populated — the ranking/render code is unchanged.

## Prerequisites

- **Node.js 20+**
- No wallet required (read-only; a throwaway keypair is generated
  internally and never used to sign).
- Network access to a Solana devnet RPC.

## Setup

This sample uses `file:` references back into the workspace, so the
SDK packages resolve from `../../sdk/idl` and `../../sdk/client`
without going through npm. `samples/` is excluded from the root
workspaces glob (ADR-140), so this is an isolated sandbox.

```sh
cd samples/reputation-leaderboard
npm install
```

A local `node_modules/` and `package-lock.json` are created on first
run; both are intentionally not committed.

## Run

```sh
cd samples/reputation-leaderboard
npm start
```

To rank real registered agents, pass their authority pubkeys:

```sh
AGENT_AUTHORITIES="<pubkey1>,<pubkey2>,<pubkey3>" npm start
```

Optionally override the RPC endpoint:

```sh
RPC_URL="https://your-private-rpc.example/devnet" npm start
```

## Expected output (first run, built-in defaults)

```
reputation-leaderboard — ranking 2 candidate authorities on devnet

agent-registry program: 26KETQPxeMmbakxpVbUEpQBQmVgpabHAweTHBRgBHjW7

no registered profiles found among the candidate set (2 unregistered).
   this is expected with the built-in defaults — set
   AGENT_AUTHORITIES to real registered-agent authorities:
     AGENT_AUTHORITIES="<pubkey1>,<pubkey2>" npm start
   ...
```

With at least one registered authority supplied via
`AGENT_AUTHORITIES`:

```
Leaderboard (top by reputation, out of 100):

  rank  reputation  authority
  ----  ----------  ---------
     1    87/100  <pubkey>
     2    63/100  <pubkey>

  (1 candidate authorities had no registered profile)
```

## Switching to npm dependencies (post-publish)

Once `@agenomics/idl` and `@agenomics/client` publish per
`docs/SDK_PUBLISH.md`, swap the `file:` references in
[`package.json`](./package.json) for semver ranges
(`"@agenomics/client": "^0.1.0"`). That single edit is everything an
external consumer changes; the sample code does not change.

## Maintainer

Maintained by **k2jac9** (`k2jac9@users.noreply.github.com`).
