// ADR-060 golden-vector test — ensures the canonical-JSON +
// SHA-256 pipeline produces a stable, checked-in hash for a fixed
// manifest. If `canonicalize` changes its output (a 3.x release, a
// drift from RFC-8785, or a replacement library) this test fails
// loudly before any hashes are published on-chain.
//
// See DEEP-AUDIT-2026-04-22.md Audit 2 — "canonicalize has no public
// types that express 'RFC-8785 compliance is a SemVer contract'; a
// canonicalize 3.x release could silently change output." The `package.json`
// pins `canonicalize` to exact `2.0.0`; this test is the paired
// runtime check that the pinned version still produces the expected
// bytes.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  manifestHash,
  unstable_canonicalBytes,
  unstable_canonicalJson,
} from "../src/index.js";

// ------------------------------------------------------------------
// Checked-in golden vector — generated with canonicalize@2.0.0 + the
// ADR-060 §3 SHA-256 pipeline. Do NOT regenerate casually; any change
// here is a breaking change for every published manifest hash.
// ------------------------------------------------------------------

const GOLDEN_MANIFEST = {
  $schema: "https://aep.dev/schemas/capability-manifest/v1.0.json",
  version: "1.0",
  agent: {
    pubkey: "11111111111111111111111111111111",
    name: "Golden Vector Agent",
  },
  agent_version: "1.0.0",
  capabilities: [
    {
      name: "golden-capability",
      description: "Deterministic golden vector for canonical-JSON round-trip.",
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      required_capabilities: [],
      side_effects: ["read-onchain"],
      stability: "stable",
    },
  ],
  published_at: "2026-04-22T00:00:00Z",
} as const;

/**
 * The canonical-JSON encoding of GOLDEN_MANIFEST under RFC-8785. Key
 * order is lexicographic at every level.
 */
const GOLDEN_CANONICAL_JSON =
  '{"$schema":"https://aep.dev/schemas/capability-manifest/v1.0.json",' +
  '"agent":{"name":"Golden Vector Agent","pubkey":"11111111111111111111111111111111"},' +
  '"agent_version":"1.0.0",' +
  '"capabilities":[{' +
  '"description":"Deterministic golden vector for canonical-JSON round-trip.",' +
  '"input_schema":{"type":"object"},' +
  '"name":"golden-capability",' +
  '"output_schema":{"type":"object"},' +
  '"required_capabilities":[],' +
  '"side_effects":["read-onchain"],' +
  '"stability":"stable"' +
  "}]," +
  '"published_at":"2026-04-22T00:00:00Z",' +
  '"version":"1.0"}';

/** SHA-256 of UTF-8 bytes of GOLDEN_CANONICAL_JSON. */
const GOLDEN_HASH_HEX =
  "7aebddca0dedc0c35e7c52d3a2a88f05034a85fbdc480efb943e3e19db6bb3fb";

describe("ADR-060 golden canonical-JSON vector", () => {
  it("unstable_canonicalJson produces the checked-in canonical string", () => {
    const got = unstable_canonicalJson(GOLDEN_MANIFEST);
    assert.equal(got, GOLDEN_CANONICAL_JSON);
  });

  it("unstable_canonicalBytes round-trips to the same UTF-8 bytes", () => {
    const bytes = unstable_canonicalBytes(GOLDEN_MANIFEST);
    const decoded = new TextDecoder("utf-8").decode(bytes);
    assert.equal(decoded, GOLDEN_CANONICAL_JSON);
  });

  it("manifestHash produces the checked-in SHA-256 hex", () => {
    const hash = manifestHash(GOLDEN_MANIFEST);
    const hex = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    assert.equal(
      hex,
      GOLDEN_HASH_HEX,
      "canonicalize or sha256 output drifted — check canonicalize pin and @noble/hashes pin",
    );
  });

  it("hash is key-order-independent (RFC-8785 canonicalization invariant)", () => {
    // Same manifest with keys reversed; canonical form must be
    // identical, so hashes must match.
    const reversed = {
      published_at: GOLDEN_MANIFEST.published_at,
      capabilities: GOLDEN_MANIFEST.capabilities,
      agent_version: GOLDEN_MANIFEST.agent_version,
      agent: {
        pubkey: GOLDEN_MANIFEST.agent.pubkey,
        name: GOLDEN_MANIFEST.agent.name,
      },
      version: GOLDEN_MANIFEST.version,
      $schema: GOLDEN_MANIFEST.$schema,
    };
    assert.deepEqual(manifestHash(reversed), manifestHash(GOLDEN_MANIFEST));
  });
});
