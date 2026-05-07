# AEP examples

Runnable, copy-paste examples for builders integrating with the Agenomics
Protocol on-chain programs. This directory is intentionally **not** a
workspace member of the root `package.json`, so it mirrors what an
external consumer's repo will look like once `@agenomics/idl` and
`@agenomics/client` ship to npm.

## Honest scope

The examples in this directory are **read-only today**. SDK instruction
builders (the helpers that emit `registerAgent`, `initializeVault`,
`createEscrow`, etc. transactions) are out of scope for the `0.1.0` SDK
release — see ADR-098 and the package READMEs at:

- [`sdk/idl/README.md`](../sdk/idl/README.md)
- [`sdk/client/README.md`](../sdk/client/README.md)
- [`sdk/action-runtime/README.md`](../sdk/action-runtime/README.md)

Each example here demonstrates the canonical wiring pattern and exercises
the read surface (PDA derivation + account fetch). Write-side examples
will land in this directory when instruction builders ship.

## Examples in this directory

| File | What it shows | Network |
|------|---------------|---------|
| [`register-agent.ts`](./register-agent.ts) | connect -> derive profile PDA -> fetch profile -> render reputation | devnet |

## Prerequisites

- **Node.js 20+**
- A funded devnet keypair at `~/.config/solana/id.json`. If that file
  does not exist, the example will generate an ephemeral keypair and
  print its public key so you can airdrop to it. To fund a keypair:
  ```sh
  solana airdrop 1 -u devnet
  ```
  (The example does not currently submit transactions, so funding is
  not strictly required for `register-agent.ts` — but you will need it
  the moment instruction builders land.)

## Setup

This directory uses `file:` references back into the workspace, so the
SDK packages resolve directly from `../sdk/idl` and `../sdk/client`
without going through npm. That keeps the example runnable today,
pre-publish.

```sh
cd examples
npm install
```

This will create a local `node_modules/` and (on first run) a
`package-lock.json`. Both are intentionally not committed — `examples/`
is a sandbox, not a build target.

## Run

```sh
cd examples
npx tsx register-agent.ts
```

## Expected output (first run, unregistered authority)

```
authority: <your pubkey>
agent-registry program: psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv
profile PDA (nonce=0): <derived PDA>

no profile found at <derived PDA> — this is expected for an unregistered authority.
   underlying error: Account does not exist or has no data ...
   to register, build a `registerAgent` transaction against
   the agent-registry program. SDK instruction builders are
   out of scope for @agenomics/client@0.1.0; see ADR-098 and
   sdk/client/README.md for the roadmap.
```

If the authority has already registered an agent (e.g. you used the same
keypair against another tool that wrote to the registry), the script
will instead print:

```
found profile: <derived PDA>
   reputation: <0..100>/100
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `429 Too Many Requests` from the RPC | devnet public RPC is rate-limiting; this is common during peak hours | Retry, or point `RPC_URL` at a private RPC endpoint (Helius, Triton, QuickNode, etc.) |
| `AgentRegistryClient: IDL programId X does not match supplied programId Y` | The IDL's `address` field does not match the program ID you passed; usually the IDL bundled in `@agenomics/idl` is out of sync with `getProgramIds("devnet")` | Verify both packages were built from the same commit; `npm install` again from `examples/` |
| `No keypair at ~/.config/solana/id.json` (warning) | Solana CLI keypair not present | Either install `solana-keygen` and run `solana-keygen new`, or let the script generate one and airdrop to it (see the printed pubkey) |
| `getaddrinfo ENOTFOUND api.devnet.solana.com` | network connectivity / DNS failure | Check your network; `curl -sS https://api.devnet.solana.com -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' -H 'content-type: application/json'` should return `"ok"` |
| `Cannot find module '@agenomics/idl'` | `npm install` was not run inside `examples/` | `cd examples && npm install` |
| `Account does not exist` (when not handled) | The authority has not registered an agent yet | This is the expected first-run state and is handled explicitly by the example; if you see this raw, check that your wiring is calling `fetchProfile` inside the `try` block |

## Switching to npm dependencies (post-publish)

Once `@agenomics/idl` and `@agenomics/client` flip to `private: false` in
their respective `package.json` files and a publish lands per
[`docs/SDK_PUBLISH.md`](../docs/SDK_PUBLISH.md), swap the `file:`
references in [`examples/package.json`](./package.json) for proper
semver references:

```diff
- "@agenomics/idl": "file:../sdk/idl",
- "@agenomics/client": "file:../sdk/client",
+ "@agenomics/idl": "^0.1.0",
+ "@agenomics/client": "^0.1.0",
```

That single edit is everything an external consumer needs to do — the
example code itself does not change.

## Coming next

The next examples in this directory will cover registration, vault
creation, and the escrow lifecycle once SDK instruction builders ship.
