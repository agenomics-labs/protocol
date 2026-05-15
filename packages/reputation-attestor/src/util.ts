// Internal helpers — base58 and hex codecs. We re-implement here rather
// than re-exporting from `@agenomics/sas-resolver` so this package has
// no peer dependency on it; `mcp-server` and the issuer service should
// be able to depend on `reputation-attestor` without dragging the SAS
// resolver into the graph.

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET[i]!] = i;
  return m;
})();

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    out = B58_ALPHABET[rem]! + out;
  }
  for (let i = 0; i < zeros; i++) out = "1" + out;
  return out;
}

export function decodeBase58(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let num = 0n;
  for (const ch of s) {
    const v = B58_MAP[ch];
    if (v === undefined) {
      throw new Error(`invalid base58 character: ${ch}`);
    }
    num = num * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes, zeros);
  return out;
}

export function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexDecode(s: string): Uint8Array {
  if (s.length % 2 !== 0) {
    throw new Error(`hexDecode: odd-length string (${s.length})`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(s.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`hexDecode: invalid byte at offset ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}

/** Constant-time byte-equality check. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
