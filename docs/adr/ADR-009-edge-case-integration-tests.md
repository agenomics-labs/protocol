# ADR-009: Add Negative and Edge-Case Integration Tests

## Status
Accepted

## Date
2026-04-15

## Context
The existing integration test suite (`mcp-handlers.test.ts`) only tested the happy path:
- Create vault, update policy, manage allowlist, pause/resume
- Register agent, update profile, discover agents
- Create escrow, accept, submit, approve, reject, dispute, resolve, cancel

Missing coverage included:
- Unauthorized caller rejection
- Spending limit enforcement
- Rate limit enforcement
- Invalid milestone operations (wrong index, wrong status)
- Escrow expiry flow
- Double-dispute prevention
- Deregistration flow

## Decision
Extend the integration test suite with negative and edge-case test sections:

### Vault Edge Cases
- Unauthorized policy update (non-authority signer)
- Transfer while paused
- Per-transaction limit exceeded
- Allowlist full (11th add)

### Registry Edge Cases
- Name too long (65 bytes)
- Invalid status transition (Retired -> Active)
- Deregistration and rent recovery

### Settlement Edge Cases
- Wrong provider accepts task
- Submit milestone on wrong status
- Approve already-approved milestone
- Cancel after acceptance (should fail)
- Double dispute prevention

These tests use `expect(...).to.be.rejectedWith()` patterns to verify that the program returns the expected error codes.

## Consequences

### Positive
- Comprehensive coverage of authorization and validation logic
- Regression safety for security-critical constraints
- Documents expected behavior for edge cases

### Negative
- Requires local validator running (slower than unit tests)
- Error message matching can be brittle across Anchor versions

## Files Changed
- `mcp-server/test/mcp-handlers.test.ts` - Extended with edge-case sections
