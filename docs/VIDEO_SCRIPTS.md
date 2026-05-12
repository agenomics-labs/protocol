# Submission Videos — Scripts

Two videos required by Colosseum Frontier 2026 per
`https://github.com/SuperteamCanada/how-to-win-colosseum-hackathon`:

1. **Pitch video** (≤3 min) — team, problem, target user. *"The first
   thing judges see. If they can't understand your project in 60 seconds,
   you've already lost."*
2. **Technical demo video** (no hard cap; recommend 6–10 min) —
   implementation, Solana integration, architecture explanation.

Read straight off the page. Beats are timestamped relative to the start
of each video. `[ON SCREEN]` cues describe what should be visible at
that moment. `[VO]` is voice-over (speaking, off-camera or face-cam).

---

## Recording prep (do once, before either video)

**Capture stack (zero-cost, judge-grade):**
- Screen recorder: macOS QuickTime (`File → New Screen Recording`,
  built-in) or [OBS](https://obsproject.com/) for finer control.
- Audio: USB mic or AirPods Pro w/ noise suppression — record into a
  *quiet* room, not a coffee shop.
- Optional face-cam: macOS Continuity Camera (iPhone as webcam) +
  natural window light over the laptop screen, NOT behind you.
- Editing: macOS iMovie (free) or [DaVinci Resolve](https://www.blackmagicdesign.com/products/davinciresolve)
  if you want titles/lower-thirds. Don't over-edit; jump-cuts > fancy
  transitions.

**Browser setup (do this BEFORE starting the screen recording):**
- New incognito/private window so no cached state leaks personal info
- Zoom to 110-125% so text is readable in 1080p compressed video
- Hide bookmarks bar (View → Hide Bookmarks Bar)
- Pre-open tabs in this order, left-to-right:
  1. https://agenomics.xyz (landing)
  2. https://agenomics.xyz/thesis (the "coming shortly" page is fine)
  3. https://app.agenomics.xyz (dashboard)
  4. https://docs.agenomics.xyz (docs)
  5. https://explorer.solana.com/address/28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw?cluster=devnet
     (Agent Vault on Solana Explorer — proves devnet liveness)
- Have Claude Desktop already showing the `agenomics` MCP entry under
  Settings → Developer

**Terminal setup (for the tech demo):**
- Wide font (14-16pt), high-contrast theme
- One terminal window, full-screen, with `cd` already in
  `~/dev/projects/protocol`
- Have `scripts/demo-e2e.ts` already running in a paused state if
  possible, OR be prepared to narrate while it runs
- Run `solana config set --url devnet` ahead of time so the prompt
  doesn't surprise you

**Upload targets:**
- Loom (unlisted, copyable link) — recommended; built-in trim, low
  friction
- YouTube unlisted — if you want chapter markers
- Vimeo if Loom feels too informal

**Final-takes file format:**
- 1080p (1920×1080), 30 fps, MP4 (H.264 + AAC). Loom does this by
  default.
- Both videos's links go into `SUBMISSION.md` (next ticket) and the
  Colosseum project page.

---

## Script 1 — Pitch Video (≤3 min)

**Goal of the first 60 seconds:** judges close the tab if they don't
understand WHO this is for and WHAT problem it solves. Beats 1-3 carry
this.

### Beat 1 — Hook (0:00 – 0:12)

```
[ON SCREEN] Black title card, white text:
            "AGENOMICS — coordination layer for a machine-speed economy"
            (already a phrase used on the live site — keep it consistent)

[VO]  Humans negotiate contracts in days.
      AI agents could do it in milliseconds —
      if there were any infrastructure for them to do it ON.
      Agenomics is that infrastructure.
```

### Beat 2 — Why now (0:12 – 0:40)

```
[ON SCREEN] Cut to https://agenomics.xyz — let the hero scroll naturally,
            stop on the "HUMAN-BATCH CADENCE / MACHINE CONTINUOUS"
            architecture diagram.

[VO]  Every AI agent shipped in the last year — Claude, GPT, ElizaOS,
      custom — can think, plan, write code, write contracts.
      None of them can hold money, prove they're real, or settle a
      payment without a human in the loop.
      That gap is the bottleneck on the entire agent economy.
      It's also the gap blockchains were literally built to close.
```

### Beat 3 — What Agenomics is (0:40 – 1:00)

```
[ON SCREEN] Switch to the SUMMARY.md architecture diagram OR the
            dashboard at https://app.agenomics.xyz showing the three
            programs.

[VO]  Agenomics is three Solana programs plus an MCP server.
      Agent Vault — programmable wallets with daily caps, per-tx
      limits, and token allowlists, enforced by Anchor on-chain.
      Agent Registry — discovery and reputation, scored by actual
      delivered work.
      Settlement — milestone-based escrow with built-in dispute
      resolution.
      The MCP server makes all 28 tools available to any agent, today,
      via Claude Desktop or any MCP-compatible client — or directly
      from claude.ai via the hosted remote connector.
```

### Beat 4 — Live proof (1:00 – 1:50)

```
[ON SCREEN] Cut to Solana Explorer tab (Agent Vault devnet address).
            Pan to show "Executable: Yes". Then back to agenomics.xyz,
            scroll to the signup form.

[VO]  All three programs are live on devnet right now —
      vault, registry, settlement, deployed and executable, RPC-verifiable.
      The landing page itself runs through the same protocol it
      describes — the waitlist signup hits a Vercel edge function
      hardened with a four-layer cycle of security audits, and the
      welcome email fires through Resend with a verified domain.
      Sign up at agenomics.xyz; you'll see it land.
```

### Beat 5 — Why a solo builder, why now (1:50 – 2:30)

```
[ON SCREEN] Quick montage: README scroll, MAINNET_CHECKLIST scroll
            (showing all the green checkmarks), one ADR file, one
            test-output terminal showing 580+ tests passing.

[VO]  This was built solo over the hackathon window —
      three Anchor programs, an MCP server with 28 tools,
      a React dashboard, a landing page, a thesis presentation,
      a four-cycle audit framework, end-to-end self-deploying CI.
      The point isn't that one person built it.
      The point is that one person CAN build this shape now —
      and that's the same world AI agents are about to step into.
      Agenomics is the rails for when they do.
```

### Beat 6 — CTA (2:30 – 3:00)

```
[ON SCREEN] Title card with three URLs stacked, large:
              agenomics.xyz
              github.com/agenomics-labs/protocol
              [your X / contact handle]

[VO]  Three things you can do right now —
      Try the live demo at agenomics.xyz.
      Read the code at github dot com slash agenomics-labs slash protocol.
      And if you're judging the Frontier hackathon —
      thank you. Hit me up if you want a deeper walkthrough.
```

**Total: 3:00 exactly. Cut to ~2:50 if any beat runs long.**

---

## Script 2 — Technical Demo Video (target 6–8 min; cap at 10)

**Goal:** prove the protocol actually works, the design choices were
deliberate, and the test/security posture is real. Judges who watch
this are the deeper-tech ones who decide finalists; talk to them like
peers.

### Beat 1 — Re-intro for judges who skipped the pitch (0:00 – 0:30)

```
[ON SCREEN] Same hero shot from agenomics.xyz; scroll to architecture
            diagram and stop.

[VO]  Quick recap if you skipped the pitch.
      Agenomics is three Solana programs plus an MCP server that
      lets AI agents hold money, find each other, and transact
      with built-in dispute resolution.
      In this video I'll walk the architecture, show the interesting
      Solana primitives we lean on, run the full lifecycle on devnet,
      and end on the test and security posture.
```

### Beat 2 — Architecture walkthrough (0:30 – 1:45)

```
[ON SCREEN] Full-screen: SUMMARY.md "Architecture Overview" diagram.
            Then split-pane to the dashboard's Programs tab.

[VO]  Three programs, intentionally separated.
      Agent Vault — programmable wallet PDAs. Each vault stores
      its own daily cap, per-tx cap, rate-limit window, and a
      token allowlist. The Anchor program enforces every transfer
      against this policy at instruction-handler time, not just
      in the client. So even a compromised agent can't drain past
      its bounds.
      Agent Registry — agent identities tied to keypairs, with
      reputation scores updated only by Settlement via PDA-signed CPI.
      That last bit matters — reputation isn't a vibes column, it's
      a number provably mutated by completed escrow.
      Settlement — milestone-based escrow. State machine: created →
      accepted → submitted → approved → completed. Disputes carve
      out their own resolution path with a governance-tunable timeout.
      All three deployed to devnet at the addresses you see on screen,
      and verifiable on Solana Explorer right now.
```

### Beat 3 — The interesting Solana bits (1:45 – 3:00)

```
[ON SCREEN] Open mcp-server/src/handlers/registry.ts OR the program's
            CPI invoker. Highlight the PDA-signed invoke().
            Also show settlement/state.rs::SettlementState enum.

[VO]  Three design choices worth explaining.
      First — the cross-program reputation update is a PDA-signed CPI
      from Settlement to Registry. Settlement holds the authority
      seed; Registry's instruction-handler verifies the signer is
      that exact PDA. Result: only a real, completed milestone can
      change a reputation score. No external script can spoof it.
      Second — the vault policy is per-vault state, not global config.
      An operator can grant their agent a $10/day stipend for
      experimentation while the production agent has $10K/day.
      Same program, different policies, isolated PDAs.
      Third — the dispute-timeout instruction. If the dispute counter-
      party doesn't respond inside the governance-set window, a
      caller can resolve it deterministically without manual
      intervention. Auto-resolution with reputation penalties built
      into the same atomic transaction.
```

### Beat 4 — Live lifecycle on devnet (3:00 – 5:30)

```
[ON SCREEN] Full-screen terminal. Run:
            anchor test  (or scripts/demo-e2e.ts)
            Narrate as it runs.

[VO]  Now the full lifecycle on devnet. This is `scripts/demo-e2e.ts`
      — eight steps, all real on-chain transactions.
      Step 1, fund a fresh demo account.
      Step 2, create a vault with a 2-USDC daily cap and a token
      allowlist of one mint.
      Step 3, register a client agent and a provider agent.
      Step 4, open a 2-USDC escrow with two milestones, 0.8 and 1.2.
      Step 5, provider accepts the work, submits milestone zero,
      client approves — 0.8 USDC released atomically.
      Step 6, provider submits milestone one, client approves —
      1.2 USDC released, escrow auto-completes.
      Step 7, completion fires the CPI to Registry — the provider's
      reputation goes from zero to fifty, earnings counter from zero
      to two million lamports of USDC.
      Step 8, on-chain verification of the new state.
      Every step is a real signed transaction, queryable on Explorer.
```

### Beat 5 — MCP integration (5:30 – 6:30)

```
[ON SCREEN] Claude Desktop window. Show the Settings → Developer
            panel with the `agenomics` MCP entry. Then open a chat
            and ask Claude to "list available agenomics tools" or
            similar — narrate the response.

[VO]  And here's why this matters for the agent economy.
      The MCP server exposes all 27 protocol actions to any
      MCP-compatible client. Claude Desktop, Cursor, custom GPT
      runners, whatever you build.
      Same wire format as on-chain — the server validates, signs,
      submits, and returns the result. The agent never sees the
      private key.
      What that unlocks: an agent can discover other agents through
      `discover_agents` and `find_similar_agents`, lock funds with
      `create_escrow`, settle via the milestone flow, all without
      a human in any of those calls.
      The protocol becomes the negotiation primitive.
```

### Beat 6 — Test, security, governance posture (6:30 – 7:30)

```
[ON SCREEN] Terminal split:
              left:  cd mcp-server && npm test
              right: cargo test --workspace
            Let both finish. Then briefly cd docs/adr && ls | wc -l.

[VO]  Behind the demo there's 580+ passing tests —
      164 anchor unit and integration tests on the programs,
      416 node:test cases on the MCP server.
      All gated in CI. Both ran clean three times in a row before
      this recording.
      The architecture decisions behind every nontrivial choice
      live as ADRs — over 130 files in `docs/adr/`, every accepted
      decision linked to its implementation evidence.
      Four hostile audit cycles ran against the codebase pre-recording.
      Each one closed with a punch-list at zero open. The waitlist
      endpoint alone has six layers of defense — rate limit, origin
      gate, honeypot, form-fill timing, response-padding plus jitter,
      per-email throttle. That's not for a hackathon judge —
      that's because this is the kind of code we want to run when
      money is moving.
```

### Beat 7 — Close (7:30 – 8:00)

```
[ON SCREEN] Title card with the same three URLs from the pitch:
              agenomics.xyz
              github.com/agenomics-labs/protocol
              [your X / contact handle]

[VO]  That's Agenomics. Thanks for watching.
      Code is at github.com/agenomics-labs/protocol —
      live demo at agenomics.xyz —
      and if you're judging Frontier, I'm one DM away from a
      private walkthrough whenever it's useful. Talk soon.
```

**Total target: 8:00. Acceptable range 6:00 – 10:00.**

---

## Post-recording checklist

- [ ] Pitch video uploaded (Loom unlisted) → URL noted in
      `SUBMISSION.md`
- [ ] Tech demo uploaded → URL noted in `SUBMISSION.md`
- [ ] Both URLs added to the landing page CTA strip (TODO ticket)
- [ ] First 60s of the pitch tested on a non-technical viewer:
      can they restate the problem in one sentence?
- [ ] Tech demo's `anchor test` segment trimmed if it ran long
      (target ≤45s of test-runner output, even if the actual run
      took longer)
- [ ] No personal email / API key / shell prompt with sensitive paths
      visible in any frame (review the timeline once before publish)

## Notes for the script reader

- The voice-overs are **drafts**, not religion. Substitute your own
  phrasing where the rhythm doesn't match how you talk. The
  *structure* (beat order, what's on screen, what to prove) is the
  load-bearing part.
- If a beat is running long, the safest cuts are: shrink Beat 5 of
  the pitch (solo-builder framing — judges who care about
  execution-credibility already get it from the test count) and
  Beat 6 of the tech demo (test posture — keep the count, drop the
  ADR enumeration).
- If you want to do **one** weekly progress-update video per the
  Colosseum guide's bonus tip, a 90-second walking-through-the-week
  Loom is enough. Mention what shipped this week, link the
  diff/commit. Cumulative judge visibility compounds.
