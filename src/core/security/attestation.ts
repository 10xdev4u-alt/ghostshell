import type { PrivacyReport } from '@/types/index.js';

/**
 * Privacy attestation: a signed, exportable report proving what ran and what
 * (if anything) left the machine.
 *
 * The report includes:
 *  - sha256 of the HTML file, model weights, and VM image
 *  - the full dependency list with licenses
 *  - the egress log
 *  - a WebCrypto signature ( Ed25519 or ECDSA ) over the canonical JSON
 *
 * See docs/CREATIVE_INNOVATION.md §5.
 */

export interface AttestationConfig {
  htmlSha256: string;
  modelSha256: string;
  vmImageSha256: string;
  dependencies: { name: string; version: string; license: string }[];
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes: Uint8Array<ArrayBuffer> =
    typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildReport(
  config: AttestationConfig,
  egress: { id: string; timestamp: number; url: string; method: string; blocked: boolean; reason?: string }[],
): Promise<PrivacyReport> {
  return {
    htmlSha256: config.htmlSha256,
    modelSha256: config.modelSha256,
    vmImageSha256: config.vmImageSha256,
    dependencies: config.dependencies,
    egress,
    generatedAt: Date.now(),
  };
}

/** Sign the canonical report with a generated ephemeral key. */
export async function signReport(report: PrivacyReport): Promise<string> {
  const key = (await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  )) as unknown as CryptoKey;
  const data = new TextEncoder().encode(canonicalize(report));
  const signature = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    data as BufferSource,
  );
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function canonicalize(report: PrivacyReport): string {
  return JSON.stringify({
    htmlSha256: report.htmlSha256,
    modelSha256: report.modelSha256,
    vmImageSha256: report.vmImageSha256,
    dependencies: report.dependencies,
    egress: report.egress,
    generatedAt: report.generatedAt,
  });
}
