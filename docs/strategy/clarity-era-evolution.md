# CLARITY-Era Evolution: From Agent Infrastructure to Machine Institutional Substrate

**Status:** Strategy (non-binding; orients ADR drafting and roadmap sequencing)
**Date:** 2026-05-14
**Owners:** Protocol team
**Linked branches:** `claude/delegation-grants-adr-111`, `claude/execution-provenance-events`, `claude/portable-reputation-attestations`

---

## 1. Thesis

Agenomics began as "Solana infrastructure for AI agents." That framing is too narrow to defend over a five-year horizon. The right framing is **trust, identity, compliance, and economic coordination substrate for autonomous machine systems** — a layer below any one agent runtime, payments rail, or orchestration framework.

The reason is structural. "AI agents" is a workload class; workload classes get commoditized as model APIs converge. Trust substrates — the things that decide *which* machine can hold *which* money under *which* policy with *what* reputation, attested by *whom* — accrue value as the number of distinct agent operators grows. Once the substrate is the source of truth for delegation, reputation, and provenance, switching off it costs the entire counterparty graph. That is a structurally larger and more defensible category than "agent infra."

The existing on-chain surface — `programs/agent-vault`, `programs/agent-registry`, `programs/settlement`, `programs/cctp-hook` — is the seed of that substrate. What changes under the new framing is the prioritization: features that compound the trust graph (portable reputation, execution provenance, delegation grants) move ahead of features that only widen the workload surface (more MCP tools, more chains).

**Forward-looking note (CLARITY Act).** If the U.S. CLARITY Act passes in roughly its current shape, the regulatory incentive for builders shifts toward auditable on-chain settlement, identifiable counterparties at the edge, and credential issuance that can carry jurisdictional metadata. *If* that happens, protocols that already separate identity, capability, and reputation as orthogonal artifacts (ADR-060 `ADR-060-capability-descriptor-format.md`, ADR-061 `ADR-061-sas-integration.md`) inherit a compliance posture cheaply. *If* CLARITY does not pass — or passes in a form that pushes obligations onto custodians rather than protocols — the same separation still pays for itself in enterprise integrations and dispute defensibility. The thesis is conditional on the macro environment in degree, not in direction.

---

## 2. Current positioning (grounded in the repo)

The repo already maps cleanly to four quadrants: **identity**, **reputation**, **provenance**, and **economics**. Delegation is a fifth axis currently under construction.

**Identity.** `AgentProfile` is the canonical agent record (`programs/agent-registry/src/state.rs`). Each profile carries `authority`, `vault_address`, manifest pointer fields (ADR-060), and a `registration_nonce` (ADR-097 `ADR-097-registration-nonce-sybil-resistance.md`) included in the PDA seed so that a close-then-reopen cannot reuse the prior PDA and inherit its history. `Vault.agent_identity` (`programs/agent-vault/src/state.rs:38`) binds a runtime hot key to the vault, and `initialize_vault` requires an Ed25519 precompile proof-of-control over `vault_identity_bind_message(authority, agent_identity)` (ADR-124 `ADR-124-vault-agent-identity-proof-of-control.md`), so a wrong-key bind is impossible at init rather than only recoverable by rotation. The vault's `profile_nonce` (`programs/agent-vault/src/state.rs:73`) couples the vault to the live profile PDA per ADR-095 `ADR-095-vault-registry-suspension-coupling.md`.

**Reputation.** Scores are `u64` clamped to `[0, 100]` and mutated exclusively through `propose_reputation_delta` (ADR-094 `ADR-094-reputation-trust-hierarchy-inversion.md`). Settlement proposes via CPI with `|delta| ≤ MAX_DELTA_PER_CALL = 10`; Registry enforces the clamp. The deprecated direct `update_reputation` setter is retained only for migration continuity. ADR-020 `ADR-020-reputation-staking.md` provides the reputation stake + slash path that, combined with ADR-095 suspension coupling, blocks asset movement out of a suspended agent's vault.

**Provenance.** Capabilities are an off-chain JSON manifest committed on-chain via `manifest_cid`, `manifest_hash`, `manifest_signature`, `manifest_version` (ADR-060). The reference resolver `@agenomics/sas-resolver` (`packages/sas-resolver/`) implements the manifest → SAS attestation flow defined in ADR-061 and ADR-064 `ADR-064-sas-resolver-package.md`. Build-artifact provenance via `cosign sign-blob` is reserved as ADR-130 `ADR-130-artifact-provenance-cosign.md` — held until a B2B, regulatory, or maintainer-set trigger fires.

**Delegation.** Today the vault has a two-level authority model (`authority` for policy + `agent_identity` for transfers). Bounded sub-authorities — "this subagent can spend ≤ 100 USDC to these three recipients until Friday" — do not exist yet; ADR-111 `ADR-111-vault-delegation-grants.md` is the in-flight design.

**Economics.** `programs/settlement` handles milestone escrow with dispute and timeout paths; CPI to Registry on milestone completion drives the reputation delta. `programs/cctp-hook` auto-approves milestones on a CCTP V2 round-trip (`programs/cctp-hook/src/lib.rs`). The `pay_x402_service` MCP tool (`mcp-server/src/tools/pay-x402-service.ts`) is a stub; full x402 integration is open.

**What is not yet there.** Three gaps matter for the strategy:

- **Cross-chain identity.** The CCTP hook reads a binding (`cdp_wallet` on the Registry profile) but there is no DID-style resolver, no portable agent passport, and no equivalent of `AgentProfile` on a non-Solana chain.
- **ZK attestations.** SAS attestations are public on-chain records (ADR-061 §7). KYC, jurisdiction, and accreditation attestations cannot be carried in clear text on-chain; a ZK proof layer is required before those become first-class.
- **Portable reputation.** Until the in-flight ADR-139 branch lands, reputation is a single `u64` inside one Registry program. There is no signed export, no third-party verification path, and no replay-safe import target.

Each gap maps to a wedge in §4.

---

## 3. The agent-internet stack and where Agenomics sits

Treat the agent internet as five layers:

1. **Identity** — who is this agent, who controls it, what is the proof.
2. **Communication** — how do agents discover each other and exchange messages.
3. **Trust** — what reputation, attestations, and provenance bind to an identity.
4. **Coordination** — escrow, delegation, dispute, policy enforcement.
5. **Economics** — settlement, payments, fees.

Agenomics is in layers 1, 3, 4, 5. It is not in layer 2 and should not try to be.

**Moltbook (social graph + emergent norms).** Public signal characterizes Moltbook as an agent-native social layer where reputation emerges from observed behavior across an agent peer graph. *Signal:* the peer-graph framing aligns with where SAS attestations sit in our stack — third parties asserting bounded claims that consumers compose off-chain. *Speculation:* whether Moltbook becomes the dominant social graph or one of several. Agenomics should expose reputation as a portable, signed artifact (wedge 3) so that any social graph — Moltbook or otherwise — can consume it without protocol-level coupling.

**AgentConnect (communication protocols).** Public signal positions AgentConnect as a transport / discovery protocol for agent-to-agent messaging. *Signal:* the agent ecosystem will pick one or two dominant communication protocols within 18 months, the same way HTTP won the document web. *Speculation:* which protocol wins. Agenomics should integrate with whichever wins via thin adapter packages (the way `@agenomics/sas-resolver` adapts to SAS) and should not own the wire format.

**AIS-1 (multi-agent societies).** Public signal frames AIS-1 as a research program on agent societies — emergent governance, norm enforcement, and group behavior at scale. *Signal:* multi-agent governance pressure is real; ADR-113 `ADR-113-progressive-decentralization-governance.md`'s validator-DAO model is a concrete instance of the same problem. *Speculation:* timeline and dominant design pattern. Agenomics's role here is to provide the on-chain primitives (stake, reputation, slash) that any society-layer governance protocol can build on, not to design the society layer itself.

**Where Agenomics is well-positioned.** Identity (deep on-chain commitments + Ed25519 binding), trust (Registry-authoritative reputation + SAS-additive third-party claims), and settlement (milestone escrow with verified CPI reputation feedback). These are the parts of the stack where on-chain enforcement is load-bearing — exactly where a sovereign Solana program earns its keep.

**Where it should not compete.** Communication transport, social applications, and orchestration runtimes. Those layers are won by network effects on user/agent count, not by on-chain guarantees. Building them inside the protocol would burn engineering attention against entrenched incumbents (ElizaOS, sendai's stack, Anthropic's MCP, OpenAI's plugin ecosystem) for marginal protocol value.

---

## 4. Wedge sequencing (the 18-month roadmap)

Each wedge is sequenced so that later wedges can assume earlier ones have landed. Wedges 1–3 are in flight on sibling branches; 4–8 follow.

### Wedge 1 — Delegation grants (ADR-111)

*Scope.* New `DelegationGrant` PDA child of `Vault` with bounded spend cap, expiry, recipient allowlist, and action bitfield (`ADR-111-vault-delegation-grants.md`). New instructions `grant_delegation`, `revoke_delegation`, `execute_delegated_transfer`, `execute_delegated_token_transfer`. Grants must intersect — never widen — the parent vault's policy and remain gated by ADR-095 suspension.

*ADR(s).* ADR-111. Sibling branch `claude/delegation-grants-adr-111`.

*Why now.* Operators are creating disposable sub-vaults as a workaround today; that loses the audit trail and wastes rent. Without first-class delegation, every subagent integration is a one-off.

*Risk.* Delegation explosion (many grants → audit complexity). Mitigated by `max_active_grants_per_vault` in `ProtocolConfig` and by the emergency-suspend gate from ADR-081 propagating instantly. Revocation latency is the residual exposure; mitigated by short default expiries.

*Success criteria.* Grants survive a full lifecycle (grant → partial spend → revoke → archive) under integration test; `mcp-server` exposes `grant_delegation` / `revoke_delegation` / `list_active_grants`; suspension propagates to delegated transfers in the same block.

### Wedge 2 — Execution provenance

*Scope.* Canonical event stream and an off-chain provenance pin for every privileged action (vault transfer, delegated transfer, escrow milestone). Each event carries a content-addressable reference that off-chain verifiers can independently re-derive. Targets ADR-138 (new).

*ADR(s).* ADR-138 (new, in-flight on `claude/execution-provenance-events`).

*Why now.* Reputation is only as defensible as the actions backing it. A delta of `-5` for `dispute_loss` (ADR-094) is meaningful only if a third party can reconstruct *what dispute, over what payload, with what timing*. Today the indexer (ADR-082, ADR-118, ADR-127) covers happy-path observability but not adversarial reconstruction.

*Risk.* Event-schema churn. Mitigated by versioning the provenance envelope from day one and reusing the canonical-JSON discipline ADR-060 already requires.

*Success criteria.* Every `propose_reputation_delta` call links to a reconstructible action; indexer emits a tamper-evident provenance feed; cosign-style artifact pinning gains a counterpart for transaction-level provenance.

### Wedge 3 — Portable reputation attestations

*Scope.* A signed, versioned reputation artifact that an agent can carry off Solana and that a third party (another chain, an off-chain registry, a counterparty) can verify without RPC access to `agent-registry`. Builds on ADR-061's SAS schema as the canonical on-chain attestation surface. Targets ADR-139 (new).

*ADR(s).* ADR-139 (new, in-flight on `claude/portable-reputation-attestations`). Extends ADR-061 schema `AEP_AGENT_REPUTATION_v1`.

*Why now.* Reputation is the data network-effect asset of the substrate (see §5). Until reputation is portable, every new chain or registry restarts the graph from zero. Portability is the moat-builder, not a follow-on.

*Risk.* Replay across chains. Mitigated by domain-tagged signatures (same pattern as ADR-124's `VAULT_IDENTITY_BIND_DOMAIN`) and by the SAS attestation's `subject` field already binding to the agent authority. Stale-attestation drift (ADR-061 §6) is the secondary risk; the resolver's `stale` flag handles it.

*Success criteria.* External verifier reproduces a Registry-derived score from a signed attestation alone; same artifact lands in two SAS credentials (`AEP_PROTOCOL`, future `AEP_VALIDATORS`) without schema rewrite.

### Wedge 4 — Policy-aware MCP authorization

*Scope.* Replace bearer-token-as-all-caps with capability-scoped tokens that carry the action set the holder is authorized for. Closes the gap ADR-083 `ADR-083-mcp-transport-security-model.md` documented: today every authenticated HTTP request gets the full capability set (`mcp-server/src/index.ts`).

*ADR(s).* Extends ADR-083. New ADR likely required for the capability-scoped token format and verification path.

*Why now.* Wedges 1 and 2 add new privileged actions (delegation issuance, provenance signing). Adding them to a transport surface where a bearer token grants every capability multiplies blast radius. The authorization model needs to scale before the action surface does.

*Risk.* Token format churn forces every operator to re-mint. Mitigated by a versioned token envelope and a deprecation window. Operator UX cost is real — many operators run a single bearer with all caps today.

*Success criteria.* Bearer tokens carry a typed capability set; the MCP server refuses any handler whose required capabilities are not a subset of the token's; CI lint gate (ADR-115 `ADR-115-ci-blocking-security-gates.md`) extends to flag token configurations granting `ALL_CAPABILITIES`.

### Wedge 5 — Peer-ranked dispute consensus (ADR-112)

*Scope.* Opt-in `DisputeMode::PeerConsensus` alongside the existing `SingleResolver` path (ADR-112 `ADR-112-peer-ranked-dispute-consensus.md`). Bradley-Terry MLE runs off-chain in the indexer; `finalize_peer_resolved_dispute` verifies the ranking proof on-chain in O(V).

*ADR(s).* ADR-112.

*Why now.* Wedge 3's portable reputation makes the validator pool larger and more legible — same pool that votes in peer dispute resolution. The two compose: more verified validators → cheaper-to-trust consensus → less reliance on a hand-picked `dispute_resolver`.

*Risk.* Collusion among voters and timing attacks on final votes (both flagged in ADR-112). Mitigated by TraceRank-weighted votes (ADR-106) and ADR-107 decay; commit-reveal as a v2 enhancement if empirical attacks emerge. Legal classification of peer-consensus arbitration is open — devnet/testnet rollout is risk-free, mainnet requires a legal review.

*Success criteria.* Five distinct disputes resolved via peer consensus on devnet with reproducible Bradley-Terry winners; collusion-cost analysis updated against ADR-108 stake gate.

### Wedge 6 — Progressive decentralization governance (ADR-113)

*Scope.* The four-stage governance ratchet from ADR-113 `ADR-113-progressive-decentralization-governance.md`: core-team multisig → core-team + validator-DAO → validator-DAO with bounded core-team veto → validator-DAO alone. Implemented as a `GovernanceStage` PDA gating every existing governance instruction.

*ADR(s).* ADR-113.

*Why now.* By the time wedges 1–5 land, the protocol has new governance knobs every wedge (delegation cap, provenance schema version, peer-consensus window, MCP capability policy, dispute mode default). Centralizing all of that on the bootstrap multisig is operationally and politically untenable past stage 0. The validator-DAO substrate is also a useful product surface in its own right — validators have a reason to stake beyond passive reputation accumulation.

*Risk.* Stage transitions are irreversible; a buggy stage-2 governance program could lock parameters until stage 3 unlocks. Mitigated by a 7-day devnet simulation requirement per stage transition (ADR-113 §Security) and by ADR-036 audit sign-off for mainnet. DAO-capture risk handled by `log10(stake)` weighting (same pattern as ADR-108).

*Success criteria.* Stage 0 → 1 transition lands with at least 5 non-core-team validators in the DAO; veto budget exercised at least once on a devnet trial change to verify the accounting works.

### Wedge 7 — ZK compliance attestations

*Scope.* KYC, jurisdiction, accreditation, and sanctions-screening attestations carried as zero-knowledge proofs over public commitments, with the underlying data behind off-chain access control. The on-chain artifact is the proof + commitment; the off-chain artifact is the verifiable claim. Slots into the SAS substrate as one or more new schemas (`AEP_AGENT_KYC_v1`, `AEP_AGENT_JURISDICTION_v1`).

*ADR(s).* New. Extends the SAS schema discussion from ADR-061 §7. ADR-075 `ADR-075-protocol-config-delta-bounds.md` deliberately keeps these schemas out of scope today; this wedge brings them in.

*Why now.* Conditional. *If* the CLARITY Act (or any equivalent jurisdictional framework) lands and pushes compliance obligations onto agent operators, every B2B integration starts asking the same question: "can the counterparty prove they are KYC'd / accredited / not sanctioned without revealing identity?" The honest answer today is "not on-chain." This wedge fixes that.

*Risk.* ZK proof system choice is load-bearing and one-way: a Groth16 commitment ties the protocol to a trusted setup, a STARK commitment costs more bytes, a PLONK/Halo2 commitment splits the difference. Picking the wrong one is expensive to revisit. Mitigated by isolating the proof system behind a verifier interface so a v2 ADR can swap implementations.

*Success criteria.* At least one credential authority (likely `AEP_PROTOCOL` plus one off-chain KYC issuer) issues a working ZK-attested credential; the resolver surfaces it without seeing the underlying PII; a Settlement-side gate consumes it without learning more than "yes / no, this counterparty satisfies the predicate."

### Wedge 8 — Cross-chain identity / agent passports

*Scope.* A DID-style resolver for agent identity that survives across Solana, EVM chains (already reachable via `programs/cctp-hook`), and future non-EVM substrates. The agent's canonical record stays on Solana; cross-chain consumers verify a signed passport derived from the Registry profile + reputation attestation.

*ADR(s).* New. Builds on ADR-061 (SAS as substrate), wedge 3 (portable reputation), and the existing CCTP hook integration.

*Why now.* This is intentionally last among the planned wedges. Cross-chain identity is only worth solving once portable reputation (wedge 3) and ZK compliance (wedge 7) have schemas worth porting. Doing it earlier produces a thin passport that consumers ignore.

*Risk.* Standards fragmentation — DID method choice, W3C VC vs. SAS-native format, conflicting per-chain DID registries. Mitigated by treating the Solana Registry profile as canonical and emitting derivative passports rather than syncing state across chains.

*Success criteria.* Working passport flow that lets an agent prove identity + reputation on at least one EVM chain without round-tripping through a centralized indexer; the CCTP hook's `cdp_wallet` binding becomes the seed for the EVM-side passport.

---

## 5. Moat analysis

Three things, taken individually, are commodities: reputation systems, execution logs, and spending-policy wallets. Taken together — with the constraint that they share an identity model, an attestation substrate, and a governance ratchet — they are a moat.

**Portable reputation + execution provenance + delegation, together, are defensible** because each one strengthens the value of the others against substitution. Portable reputation alone is a JSON file. Provenance alone is an audit log. Delegation alone is a permission system. The composition is "an agent whose claim to a delegated capability is backed by a reputation it can carry across chains, defended by an execution history a third party can reconstruct." That composite cannot be cloned by adding one feature to a competing protocol — the value is in the schema invariants holding *together* (ADR-060 §6's "identity / reputation / capabilities" separation is the load-bearing rule), and re-deriving that consistency in a fork is a year of work.

**"AI agents" is not a category; "machine institutional infrastructure" is.** AI agents are a workload class — they will commoditize as model APIs converge and orchestration frameworks (ElizaOS, Sendai's stack, the MCP server ecosystem) generalize. What does not commoditize is the substrate underneath: the thing that decides whose vault can fund whose escrow, whose reputation can vouch for whose action, whose attestation a regulator will read. That is the same role financial-market institutional infrastructure (clearinghouses, custody, ratings agencies) plays for human commerce — and it is a structurally larger and more durable category than "AI agents."

**Data network effects: the reputation graph compounds.** Every settled escrow drives a reputation delta (ADR-094); every reputation delta updates an attestation (wedge 3); every attestation feeds a discovery query (`mcp-server/src/tools/registry.ts:discoverAgents`); every discovery query reinforces the matching graph. Today the graph is small. At 10,000 active agents, it is the most valuable asset in the protocol — and the cost of recreating it elsewhere scales superlinearly with size, because reputation history compounds in a way capital cannot replicate by spending.

---

## 6. Strategic risks

**Scope sprawl** (most acute). The strategy enumerates eight wedges across 18 months; the team's framing has consistently warned against making "AI agents" a catch-all. Every wedge above must be defensible as *trust / identity / compliance / coordination* substrate, not as agent UX. Concretely: the §7 "What we are NOT building" list exists because it is easier to onboard a feature than to remove it. Any future ADR proposing a feature outside the four quadrants should be marked rejected before the design phase, not after.

**Regulatory drift.** The CLARITY Act may not pass, may pass with materially different obligations than current drafts, or may be superseded by a state-level framework. Wedge 7 (ZK compliance) is explicitly conditional on a forcing function. The mitigation is to keep wedge 7 in `Reserved` ADR state (the same pattern as ADR-130) until a concrete counterparty demands it. The strategy must not commit engineering attention to compliance plumbing that no consumer asks for.

**Centralization of issuer keys.** ADR-061 §3 names `AEP_PROTOCOL` and (deferred) `AEP_VALIDATORS` as credential authorities. Today both are gated by the same Squads multisig as Registry program upgrades — a single point of trust for all baseline attestations. Wedge 6 (ADR-113 progressive decentralization) is the structural fix; until it lands, the mitigation is operational: rotate issuer keys on the same cadence as the bootstrap multisig, document the rotation path (ADR-079 operator key hygiene), and avoid issuing attestations that a future DAO cannot re-issue under its own credential.

**Ecosystem fragmentation.** If three competing trust layers emerge on Solana — say, Agenomics, a sendai-native equivalent, and an EigenLayer-style restaking primitive — the substrate value of any single one is reduced. The mitigation is to treat trust artifacts as portable from day one (wedge 3) and to interoperate with SAS rather than fork it (ADR-061 option B). A protocol whose reputation can be consumed by competing layers is harder to displace than one whose reputation only lives inside its own programs.

---

## 7. What we are NOT building

These are out of scope. Every future ADR proposing one of them should be rejected, and tangential PRs should be redirected before the design phase.

- **Not an agent marketplace.** Discovery (`discover_agents`, `find_similar_agents`) exists as a primitive; building a marketplace UI / front end on top is a downstream product decision, not a protocol concern.
- **Not an agent communication protocol.** Message transport, routing, and discovery semantics belong to AgentConnect, MCP, A2A, or whichever protocol wins. Agenomics integrates via adapter packages.
- **Not a social application.** Norm enforcement, peer follows, agent timelines — all are downstream of the trust graph and properly live in Moltbook or its successors.
- **Not a token speculation vehicle.** Governance weight is stake × TraceRank × decay (ADR-113); there is no liquid governance token in plan, no airdrop mechanic, no AMM listing target. Tokenization decisions, if they ever happen, are downstream of substrate adoption — not a wedge.

---

## 8. Open questions

- **Decentralized issuer set composition.** Who joins `AEP_VALIDATORS` at bootstrap, by what criteria, and how is the founding cohort prevented from becoming a permanent oligarchy?
- **ZK proof system.** Groth16 (trusted setup, cheap verification), STARK (no setup, larger proofs), PLONK/Halo2 (universal setup, moderate proofs) — pick before wedge 7 starts, because the verifier circuit is hard to swap.
- **Jurisdiction routing model.** Does a "jurisdiction" attestation carry an explicit country code, a predicate (`is-OFAC-compliant`), or a set membership against an off-chain list? The trade-off is privacy vs. expressiveness.
- **Dispute consensus economic design.** ADR-112 voters earn reputation, not money. Does that incentive scale past devnet, or does mainnet need a fee-share or commit-reveal incentive layer?
- **Governance instrument.** Stake-weighted DAO (ADR-113 as drafted), governance NFT (one-vote-per-named-validator), governance token (cheap-to-buy power, explicitly rejected in ADR-113), or hybrid? Decision affects wedges 5 and 6 together.

---

## Cross-references

| Wedge | Primary ADR(s) | In-flight branch | Audit / status notes |
|---|---|---|---|
| 1. Delegation grants | ADR-111 (Proposed) | `claude/delegation-grants-adr-111` | Open items: rent sizing, CU profile, SAS credential gate (deferred to ADR-111b) |
| 2. Execution provenance | ADR-138 (new) | `claude/execution-provenance-events` | Extends ADR-082, ADR-118, ADR-127 indexer surface |
| 3. Portable reputation | ADR-139 (new) | `claude/portable-reputation-attestations` | Extends ADR-061, ADR-064; cross-domain replay defense per ADR-124 pattern |
| 4. Policy-aware MCP auth | Extends ADR-083 (new ADR likely) | not yet branched | CI gate extension per ADR-115 |
| 5. Peer-ranked disputes | ADR-112 (Proposed) | not yet branched | Legal review required before mainnet; devnet/testnet safe |
| 6. Progressive decentralization | ADR-113 (Proposed) | not yet branched | Stage 1 unblocks issuer-key decentralization (risk §6) |
| 7. ZK compliance | new ADR (Reserved-pending-trigger) | not yet branched | Conditional on CLARITY Act or equivalent forcing function |
| 8. Cross-chain identity | new ADR | not yet branched | Builds on `programs/cctp-hook`, wedges 3 + 7 |

**Foundation ADRs (already accepted; not wedges):** ADR-020 (reputation staking), ADR-060 (capability manifest), ADR-061 / ADR-064 (SAS integration + resolver), ADR-094 (reputation trust hierarchy), ADR-095 (vault/registry suspension coupling), ADR-097 (registration nonce), ADR-124 (vault identity binding), ADR-130 (cosign — Reserved).

**Supporting ADRs:** ADR-083 (MCP transport security), ADR-115 (CI security gates), ADR-082 / ADR-118 / ADR-127 (indexer hardening), ADR-075 (ProtocolConfig delta bounds), ADR-079 (operator key hygiene), ADR-081 (emergency suspend), ADR-106 (TraceRank), ADR-107 (reputation decay), ADR-108 (stake-backed discovery).
