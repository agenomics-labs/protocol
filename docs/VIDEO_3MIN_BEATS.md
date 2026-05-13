# 3-Minute Technical Demo — Beat Sheet (read over the silent recording)

> Companion to `docs/VIDEO_SCRIPTS.md` (the 6–10 min canonical tech demo).
> This is the **short version** for the silent screencast produced by
> `scripts/record-demo-video.sh` — the user records voice-over on top
> in iMovie / DaVinci Resolve.
>
> Output file: `demo-output/agenomics-demo.mp4` (1080p, ~105 s).
>
> The recording shows seven phases of on-chain action against Solana
> devnet — every phase is a real transaction, RPC-verifiable.
>
> Pad with a black title card (0:00–0:15) and a CTA outro (2:40–3:00)
> in post to hit exactly 3:00.

---

## 0:00 – 0:15 — Title card (added in post)

> Solid black card. White text:
>   **AGENOMICS PROTOCOL**
>   *An AI agent creating its own programmable wallet on Solana —*
>   *with safety policies enforced by Anchor, not by the SDK.*

```
[VO]  This is an AI agent — running locally on my machine —
      talking to three programs on Solana devnet through
      twenty-eight typed tools. In ninety seconds it will
      register itself, mint its own wallet, try to break its
      own rules, get rejected by Solana, then get paused
      mid-flight by its operator. Every move is on-chain.
```

---

## 0:15 – 0:35 — SCENE: terminal demo, steps 1 & 2

> Fresh keypair is generated and funded from the operator wallet.
> The MCP server boots in stdio mode bound to that keypair.

```
[VO]  Each run starts with a brand-new wallet — a fresh keypair
      funded with five-hundredths of a SOL by my operator.
      The Agenomics MCP server boots in stdio mode and binds
      to that key. This is the same server any Claude or Cursor
      instance would load — protocol version 2024-11-05.
```

---

## 0:35 – 0:55 — Step 3: MCP handshake & 28 tools

```
[VO]  The server announces its menu: twenty-eight typed tools,
      grouped by domain — nine for vault management, four for
      the on-chain registry, ten for milestone-escrow settlement,
      and five for reputation, similarity search, and x402
      service payment.
```

---

## 0:55 – 1:20 — Step 4: register_agent + create_vault

> Two real transactions land on devnet. AgentProfile + OwnerNonce
> PDAs on the Registry program, then the Vault PDA on the Vault
> program. Policy fields written into account state.

```
[VO]  The agent's first move is to publish its capabilities to
      the Registry program — that's transaction one.
      Then it mints its own programmable wallet with a hard
      on-chain policy: one SOL per day, a tenth of a SOL per
      transaction, ten transactions per hour. Those caps are
      Anchor account constraints, not client-side checks the
      agent could bypass. Ed25519 proof-of-control bind message,
      verified by the Solana ed25519 precompile.
```

---

## 1:20 – 1:35 — Step 5: read-back via MCP

> get_vault_info + get_agent_profile prove the state landed.

```
[VO]  Read the state back through MCP. Vault balance, paused
      status, rate-limit window — all coming from on-chain
      accounts. The agent's profile is published and its vault
      address is bound to it.
```

---

## 1:35 – 2:05 — **WOW #1**: per-tx cap is enforced ON-CHAIN

> Vault is funded with 0.2 SOL. First vault_transfer of 0.05 SOL
> succeeds. Second vault_transfer of 0.5 SOL — five times the
> per-tx cap — gets rejected by Anchor with `PerTxLimitExceeded`
> from `programs/agent-vault/src/instructions.rs:456`. The error
> message is on screen.

```
[VO]  Now the test. The legit transfer — five-hundredths of
      a SOL, well under the cap — lands. Good.
      Then a misbehaving agent tries to spend half a SOL — five
      times the per-transaction limit. The Solana program rejects
      it. PerTxLimitExceeded, error code six-thousand-one, thrown
      at instructions.rs line four-five-six.
      That's the entire value proposition of Agenomics on screen:
      a malicious agent CANNOT bypass this by patching the client.
      The constraint runs inside the Solana program.
```

---

## 2:05 – 2:35 — **WOW #2**: emergency stop (pause/resume)

> pause_vault is called by the authority. A perfectly-legal
> transfer (0.02 SOL — well under the cap) is still rejected,
> this time with `VaultPaused` from line 453. resume_vault is
> called. The same transfer now lands.

```
[VO]  Different threat model: assume the agent isn't malicious,
      it's compromised. The operator pauses the vault on-chain.
      Now the same agent, same caller, same amount —
      two-hundredths of a SOL, well under the cap — gets
      rejected. VaultPaused, error six-thousand. Resume the
      vault, and the identical instruction lands.
      Same code path, only the on-chain pause flag changed.
```

---

## 2:35 – 2:50 — Explorer URL pinned

> The captured Explorer URL is on screen for ~30 seconds.

```
[VO]  Public proof. The link is on screen — anyone can verify
      this transaction on Solana Explorer right now.
      Every byte of vault policy state lives on Solana devnet,
      not in this process.
```

---

## 2:50 – 3:00 — Outro card (added in post)

> Black. White text, stacked:
>   **agenomics.xyz**
>   **github.com/agenomics-labs/protocol**
>   *3 programs · 28 MCP tools · 580+ tests · 4 hostile audits closed*

```
[VO]  Three Solana programs, twenty-eight MCP tools, five-hundred-plus
      tests, four hostile audits closed. Built solo for the agent
      economy that's about to need it. Agenomics dot xyz.
```

---

## Director notes

- **Two Anchor errors are visible on screen** at different timestamps,
  both citing source file + line:
  - `PerTxLimitExceeded` (6001) — `instructions.rs:456`
  - `VaultPaused` (6000) — `instructions.rs:453`
  These are gold for the VO — they prove the constraint is
  Rust-on-Solana, not a JS check.
- **Pause for the rejections**: when each red `REJECTED` line
  appears, let the VO breathe for a beat. The visual is the
  punchline; don't talk over it.
- **Every run is fresh** — keypair, vault, all transactions get
  new addresses. The Explorer URL is captured into
  `demo-output/demo-meta.json` after each take. If you re-record,
  re-pull it before overlaying lower-thirds.
- **Tooling**: iMovie is enough. DaVinci Resolve if you want
  motion-graphics on top of the rejection moments.
