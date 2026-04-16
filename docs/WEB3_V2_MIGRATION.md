# Web3.js v2 Migration Plan

**Protocol**: AEAP
**Date**: 2026-04-15
**Current State**: v1 in production (`mcp-server/src/solana.ts`), v2 compatibility layer started (`mcp-server/src/solana-v2.ts`)

---

## 1. Current v1 API Usage Inventory

### 1.1 Imports from `@solana/web3.js`

| Import | File | Usage |
|--------|------|-------|
| `Connection` | `solana.ts:2` | RPC connection singleton (`getConnection()`) |
| `Keypair` | `solana.ts:3` | Wallet loading (`loadWallet()`) |
| `PublicKey` | `solana.ts:4` | Address representation throughout codebase |
| `LAMPORTS_PER_SOL` | `solana.ts:5` | SOL/lamports conversion |
| `Transaction` | `solana.ts:6` | Wallet adapter `signTransaction` type |
| `SystemProgram` | `index.ts:34` | `SystemProgram.programId` in Anchor contexts |
| `SYSVAR_RENT_PUBKEY` | `index.ts:34` | Rent sysvar in instruction contexts |

### 1.2 Imports from `@solana/spl-token`

| Import | File | Usage |
|--------|------|-------|
| `getAssociatedTokenAddressSync` | `solana.ts:10` | Derive ATAs for escrow PDAs |
| `TOKEN_PROGRAM_ID` | `solana.ts:11` | Token program in Anchor contexts |
| `ASSOCIATED_TOKEN_PROGRAM_ID` | `solana.ts:12` | ATA program in Anchor contexts |

### 1.3 Imports from `@coral-xyz/anchor`

| Import | File | Usage |
|--------|------|-------|
| `AnchorProvider` | `solana.ts:8` | Provider singleton for program interaction |
| `Program` | `solana.ts:8` | Program instances (Vault, Registry, Settlement) |
| `BN` | `solana.ts:8` | Numeric arguments to instructions |
| `Idl` | `solana.ts:8` | IDL type (unused at runtime) |

### 1.4 v1 API Call Sites

| v1 API Call | File:Line | Purpose | Frequency |
|-------------|-----------|---------|-----------|
| `new Connection(url, commitment)` | `solana.ts:83` | Create RPC connection | 1x (singleton) |
| `Keypair.fromSecretKey(bytes)` | `solana.ts:109` | Load wallet from disk | 1x (singleton) |
| `new PublicKey(string)` | `solana.ts:30-37, 264` | Parse address strings | ~20 call sites |
| `PublicKey.findProgramAddressSync(seeds, programId)` | `solana.ts:197-233, index.ts:875` | PDA derivation | 5 derivation functions |
| `conn.getBalance(pubkey)` | `solana.ts:290, index.ts:262` | Check SOL balance | 2 call sites |
| `tx.partialSign(keypair)` | `solana.ts:63,68` | Sign transactions (wallet adapter) | Implicit via Anchor |
| `new BN(value)` | `index.ts:224-225,306,340-341,501,584,745,756-759,1045-1046` | Numeric instruction args | ~15 call sites |
| `new AnchorProvider(conn, wallet, opts)` | `solana.ts:128-132` | Create Anchor provider | 1x (singleton) |
| `new Program(idl, provider)` | `solana.ts:163,175,187` | Create program instances | 3x (singletons) |
| `getAssociatedTokenAddressSync(mint, owner, allowOffCurve)` | `solana.ts:244, index.ts:749,988` | Derive ATA addresses | 3 call sites |
| `SystemProgram.programId` | `index.ts:231,312,508,774` | System program in contexts | 4 call sites |

---

## 2. v2 Equivalents

### 2.1 Addresses: `PublicKey` -> `Address` (string)

**v1:**
```typescript
import { PublicKey } from "@solana/web3.js";
const pk = new PublicKey("4wjd...");
const str = pk.toBase58();
```

**v2:**
```typescript
import { address, type Address } from "@solana/addresses";
const addr: Address = address("4wjd...");
// Addresses are strings -- no object wrapping
```

**Migration note**: The v2 compat layer (`solana-v2.ts`) already uses string addresses for program IDs.

### 2.2 Connection: `Connection` -> `createSolanaRpc`

**v1:**
```typescript
import { Connection } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const balance = await conn.getBalance(pubkey);
```

**v2:**
```typescript
import { createSolanaRpc } from "@solana/rpc";
const rpc = createSolanaRpc("https://api.mainnet-beta.solana.com");
const balance = await rpc.getBalance(address("...")).send();
// Returns { value: bigint }
```

### 2.3 Keypairs: `Keypair` -> `CryptoKeyPair`

**v1:**
```typescript
import { Keypair } from "@solana/web3.js";
const kp = Keypair.fromSecretKey(bytes);
const pubkey = kp.publicKey;
```

**v2:**
```typescript
import { createKeyPairFromBytes } from "@solana/keys";
const keyPair = await createKeyPairFromBytes(bytes);
const addr = await getAddressFromPublicKey(keyPair.publicKey);
```

### 2.4 PDA Derivation: `findProgramAddressSync` -> `getProgramDerivedAddress`

**v1:**
```typescript
const [pda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), authority.toBuffer()],
  VAULT_PROGRAM_ID
);
```

**v2:**
```typescript
import { getProgramDerivedAddress } from "@solana/addresses";
const [pda, bump] = await getProgramDerivedAddress({
  programAddress: address(VAULT_PROGRAM_ID),
  seeds: [
    new TextEncoder().encode("vault"),
    new Uint8Array(/* authority bytes */),
  ],
});
```

**Note**: v2 PDA derivation is async. All `deriveVaultPDA`, `deriveAgentProfilePDA`, `deriveEscrowPDA` functions must become async.

### 2.5 Amounts: `BN` -> `bigint`

**v1:**
```typescript
import { BN } from "@coral-xyz/anchor";
const amount = new BN(1_000_000);
const sum = amount.add(new BN(500_000));
```

**v2:**
```typescript
const amount = 1_000_000n;
const sum = amount + 500_000n;
// Native BigInt -- no library needed
```

**Migration note**: The v2 compat layer (`solana-v2.ts`) already provides `solToLamports()` returning `bigint` and bridge functions `bnToBigInt()` and `pubkeyToAddress()`.

### 2.6 Token ATAs: `getAssociatedTokenAddressSync` -> `findAssociatedTokenPda`

**v1:**
```typescript
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
const ata = getAssociatedTokenAddressSync(mint, owner, true);
```

**v2:**
```typescript
import { findAssociatedTokenPda } from "@solana-program/token";
const [ata] = await findAssociatedTokenPda({
  mint: address(mint),
  owner: address(owner),
  tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
});
```

### 2.7 Transactions: `Transaction` -> `pipe(createTransaction, ...)`

**v1:**
```typescript
import { Transaction } from "@solana/web3.js";
const tx = new Transaction().add(instruction);
tx.recentBlockhash = blockhash;
tx.feePayer = payer;
```

**v2:**
```typescript
import { pipe } from "@solana/functional";
import { createTransactionMessage, setTransactionMessageFeePayer, appendTransactionMessageInstruction } from "@solana/transaction-messages";
const msg = pipe(
  createTransactionMessage({ version: 0 }),
  m => setTransactionMessageFeePayer(payer, m),
  m => appendTransactionMessageInstruction(instruction, m),
);
```

---

## 3. Migration Order

### Phase 1: Read-Only Operations (Low Risk)

Migrate functions that only read data from the chain. No transaction signing involved.

| Function | File | v1 Call | v2 Replacement | Risk |
|----------|------|---------|----------------|------|
| `getBalance()` | `solana.ts:288` | `conn.getBalance()` | `rpc.getBalance().send()` | Low |
| `isValidPublicKey()` | `solana.ts:253` | `new PublicKey(key)` | `isAddress(key)` from `@solana/addresses` | Low |
| `parsePublicKey()` | `solana.ts:264` | `new PublicKey(key)` | `address(key)` | Low |
| `solToLamports()` | `solana.ts:275` | Returns `number` | Return `bigint` (already done in v2 layer) | Low |
| `lamportsToSol()` | `solana.ts:281` | Takes `number|bigint` | Takes `bigint` (already done in v2 layer) | Low |
| `hashDescription()` | `solana.ts:297` | Returns `number[]` | Return `Uint8Array` (already done in v2 layer) | Low |
| PDA derivation functions | `solana.ts:196-244` | `findProgramAddressSync` | `getProgramDerivedAddress` (async) | Medium |

**Estimated effort**: 2-3 days

### Phase 2: Write Operations (Medium Risk)

Migrate transaction-building code. Requires careful testing since these move funds.

| Function | File | Risk | Notes |
|----------|------|------|-------|
| Vault initialization | `index.ts:~220` | Medium | Anchor handles tx building |
| Transfer execution | `index.ts:~300` | High | Moves SOL |
| Escrow creation | `index.ts:~740` | High | Locks tokens |
| Milestone approval | `index.ts:~860` | High | Releases tokens |
| Dispute resolution | `index.ts:~1040` | High | Splits tokens |

**Estimated effort**: 5-7 days

### Phase 3: Anchor Client Migration (Blocked)

Replace `@coral-xyz/anchor` v1 Program/Provider with v2-compatible equivalents.

**Status**: BLOCKED -- see Blockers section below.

**Estimated effort**: 3-5 days (after Anchor v2 client is released)

---

## 4. Blockers

### 4.1 Anchor JS Client (Critical Blocker)

**Issue**: `@coral-xyz/anchor` (the TypeScript client) internally uses `@solana/web3.js` v1. The `Program`, `AnchorProvider`, and `BN` types are all v1-based.

**Impact**: All instruction calls in `index.ts` go through `program.methods.instructionName(...).accounts({...}).rpc()`. This entire pipeline uses v1 types. We cannot migrate write operations to v2 until Anchor releases a v2-compatible JS client.

**Workaround in progress**: The `solana-v2.ts` compat layer provides bridge functions (`bnToBigInt`, `pubkeyToAddress`) that convert v1 types returned by Anchor into v2-style values for downstream code.

**Tracking**: Monitor [coral-xyz/anchor](https://github.com/coral-xyz/anchor) for v2 client release announcements.

### 4.2 SPL Token Package

**Issue**: `@solana/spl-token` v1 provides `getAssociatedTokenAddressSync`. The v2 equivalent is `@solana-program/token` which has a different API surface.

**Impact**: 3 call sites for ATA derivation.

**Workaround**: Can be migrated independently of Anchor using `@solana-program/token`.

### 4.3 Dynamic Import in index.ts

**Issue**: `index.ts:749` uses `await import("@solana/spl-token")` as a dynamic import. This must be updated to import from the v2 package.

---

## 5. Timeline Estimate

| Phase | Duration | Dependencies | Start |
|-------|----------|-------------|-------|
| Phase 1: Read-only ops | 2-3 days | None | Immediate |
| Phase 2: Write ops (partial) | 5-7 days | Phase 1 complete | Week 2 |
| Phase 3: Anchor client | 3-5 days | Anchor v2 JS client release | TBD |
| Integration testing | 3-5 days | All phases complete | After Phase 3 |
| Devnet validation | 2-3 days | Integration testing | After integration |
| **Total** | **~3-4 weeks** (excluding Anchor blocker wait) | | |

---

## 6. Rollback Plan

### 6.1 Strategy: Dual-Module Approach

The existing `solana.ts` (v1) and `solana-v2.ts` (v2 compat) will be maintained in parallel during migration. If v2 introduces regressions:

1. **Immediate rollback**: Revert `index.ts` imports from `solana-v2` back to `solana` module
2. **No data migration needed**: On-chain state is independent of client library version
3. **No redeployment needed**: Only the MCP server TypeScript code changes, not on-chain programs

### 6.2 Feature Flags

During migration, use environment variable to toggle between v1 and v2 code paths:

```typescript
const USE_V2 = process.env.AEAP_WEB3_V2 === "true";

export function getBalance(address: string): Promise<number> {
  if (USE_V2) {
    return getBalanceV2(address);
  }
  return getBalanceV1(new PublicKey(address));
}
```

### 6.3 Testing Requirements Before Switching

- [ ] All existing MCP handler tests pass with v2 code paths
- [ ] Devnet smoke test passes end-to-end with v2
- [ ] No precision loss in amount conversions (BN -> BigInt)
- [ ] PDA derivation produces identical addresses in v1 and v2
- [ ] ATA derivation produces identical addresses in v1 and v2
- [ ] Transaction signing produces valid signatures in v2

### 6.4 Rollback Triggers

- Any test failure not present in v1
- Transaction signing failures on devnet
- PDA or ATA address mismatches between v1 and v2
- Unexpected RPC errors from v2 client
