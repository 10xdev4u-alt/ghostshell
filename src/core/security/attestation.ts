import type { EgressEvent, PrivacyReport } from '@/types/index.js';

/**
 * Privacy attestation: a signed, exportable report proving what ran and what
 * (if anything) left the machine.
 *
 * The report includes:
 *  - sha256 of the HTML file, model weights, and VM image
 *  - the full dependency list with licenses
 *  - the egress log
 *  - a WebCrypto ECDSA signature over the canonical JSON
 *
 * See docs/CREATIVE_INNOVATION.md §5.
 */

export interface AttestationConfig {
  htmlSha256: string;
  modelSha256: string;
  vmImageSha256: string;
  dependencies: { name: string; version: string; license: string }[];
}

export interface AttestationKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto?.subtle;
  if (!c) {
    throw new Error('WebCrypto is unavailable; attestation requires a secure context');
  }
  return c;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes: Uint8Array<ArrayBuffer> =
    typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await subtle().digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildReport(
  config: AttestationConfig,
  egress: EgressEvent[],
): Promise<PrivacyReport> {
  return {
    htmlSha256: config.htmlSha256,
    modelSha256: config.modelSha256,
    vmImageSha256: config.vmImageSha256,
    dependencies: config.dependencies.map((d) => ({ ...d })),
    egress: egress.map((e) => ({ ...e })),
    generatedAt: Date.now(),
  };
}

/**
 * Deterministic JSON: object keys are sorted recursively and `undefined`
 * values are dropped, so the same report always canonicalizes to the same
 * bytes regardless of how the object was assembled.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return 'null';
}

/**
 * Canonical bytes covered by the signature. The signature itself is excluded
 * so a report can be signed and verified without circularity.
 */
export function canonicalize(report: PrivacyReport): string {
  return stableStringify({
    htmlSha256: report.htmlSha256,
    modelSha256: report.modelSha256,
    vmImageSha256: report.vmImageSha256,
    dependencies: report.dependencies,
    egress: report.egress,
    generatedAt: report.generatedAt,
  });
}

/** Generate an ephemeral ECDSA P-256 keypair for signing a report. */
export async function generateAttestationKey(): Promise<AttestationKeyPair> {
  const pair = await subtle().generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

function toHex(buffer: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    bytes[i] = byte;
  }
  return bytes;
}

/**
 * Sign the canonical report with WebCrypto ECDSA (P-256 / SHA-256).
 * Returns the raw IEEE P1363 signature as hex.
 *
 * Pass a long-lived private key when the report should be verifiable later;
 * omitting it generates an ephemeral key, which produces a self-contained but
 * unverifiable signature.
 */
export async function signReport(report: PrivacyReport, privateKey?: CryptoKey): Promise<string> {
  const key = privateKey ?? (await generateAttestationKey()).privateKey;
  const data = new TextEncoder().encode(canonicalize(report));
  const signature = await subtle().sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    data as BufferSource,
  );
  return toHex(signature);
}

export async function exportPublicKeyJwk(publicKey: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey('jwk', publicKey) as Promise<JsonWebKey>;
}

export async function importPublicKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
}

async function resolvePublicKey(key: CryptoKey | JsonWebKey): Promise<CryptoKey | null> {
  if (typeof CryptoKey !== 'undefined' && key instanceof CryptoKey) return key;
  if (typeof key === 'object' && key !== null && 'kty' in key) {
    return importPublicKeyJwk(key as JsonWebKey);
  }
  return null;
}

/**
 * Verify a report's signature against an ECDSA P-256 public key (CryptoKey or
 * exported JWK). Any mutation of the canonical fields invalidates it.
 */
export async function verifyReport(
  report: PrivacyReport,
  publicKey: CryptoKey | JsonWebKey,
): Promise<boolean> {
  if (!report.signature) return false;
  const signature = hexToBytes(report.signature);
  if (!signature) return false;

  try {
    const key = await resolvePublicKey(publicKey);
    if (!key) return false;

    const data = new TextEncoder().encode(canonicalize(report));
    return await subtle().verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature as BufferSource,
      data as BufferSource,
    );
  } catch {
    // A malformed JWK or signature must fail closed, never throw.
    return false;
  }
}
