import { describe, expect, it } from 'vitest';
import {
  buildReport,
  canonicalize,
  exportPublicKeyJwk,
  generateAttestationKey,
  importPublicKeyJwk,
  sha256Hex,
  signReport,
  stableStringify,
  verifyReport,
} from '@/core/security/attestation.js';
import type { EgressEvent, PrivacyReport } from '@/types/index.js';

const config = {
  htmlSha256: 'aa'.repeat(32),
  modelSha256: 'bb'.repeat(32),
  vmImageSha256: 'cc'.repeat(32),
  dependencies: [{ name: 'v86', version: '0.5.473', license: 'BSD-2-Clause' }],
};

const egress: EgressEvent[] = [
  {
    id: 'event-1',
    timestamp: 1_700_000_000_000,
    url: 'https://example.com',
    method: 'GET',
    blocked: true,
    reason: 'lockdown',
  },
];

function reportWith(dependencies: PrivacyReport['dependencies']): PrivacyReport {
  return {
    htmlSha256: 'aa'.repeat(32),
    modelSha256: 'bb'.repeat(32),
    vmImageSha256: 'cc'.repeat(32),
    dependencies,
    egress: [],
    generatedAt: 1_700_000_000_000,
  };
}

describe('sha256Hex', () => {
  it('hashes strings with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes bytes identically to their string form', async () => {
    expect(await sha256Hex(new Uint8Array([97, 98, 99]))).toBe(await sha256Hex('abc'));
  });
});

describe('buildReport', () => {
  it('collects hashes, dependencies, egress, and a timestamp', async () => {
    const report = await buildReport(config, egress);
    expect(report.htmlSha256).toBe(config.htmlSha256);
    expect(report.modelSha256).toBe(config.modelSha256);
    expect(report.vmImageSha256).toBe(config.vmImageSha256);
    expect(report.dependencies).toEqual(config.dependencies);
    expect(report.egress).toEqual(egress);
    expect(report.generatedAt).toBeTypeOf('number');
    expect(report.signature).toBeUndefined();
  });

  it('copies caller-owned arrays so later mutation cannot alter the report', async () => {
    const deps = [...config.dependencies];
    const events = [...egress];
    const report = await buildReport({ ...config, dependencies: deps }, events);
    deps.pop();
    events.pop();
    expect(report.dependencies).toHaveLength(1);
    expect(report.egress).toHaveLength(1);
  });
});

describe('stableStringify', () => {
  it('sorts object keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('drops undefined object values and nulls undefined array items', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify([1, undefined, 2])).toBe('[1,null,2]');
  });
});

describe('canonicalize', () => {
  it('is independent of object key order', () => {
    const a = reportWith([{ name: 'v86', version: '0.5.473', license: 'BSD-2-Clause' }]);
    const b = reportWith([{ license: 'BSD-2-Clause', version: '0.5.473', name: 'v86' }]);
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('excludes the signature so signing and verifying use the same bytes', () => {
    const unsigned = reportWith([]);
    const signed: PrivacyReport = { ...unsigned, signature: 'deadbeef' };
    expect(canonicalize(unsigned)).toBe(canonicalize(signed));
  });

  it('drops unknown top-level fields so verifiers cover only canonical fields', () => {
    const report = reportWith([]);
    const withExtra = { ...report, injected: 'not-signed' } as PrivacyReport;
    expect(canonicalize(withExtra)).toBe(canonicalize(report));
  });
});

describe('signReport / verifyReport', () => {
  it('round-trips a signed report', async () => {
    const report = await buildReport(config, egress);
    const { publicKey, privateKey } = await generateAttestationKey();
    const signature = await signReport(report, privateKey);

    expect(signature).toMatch(/^[0-9a-f]+$/);
    await expect(verifyReport({ ...report, signature }, publicKey)).resolves.toBe(true);
  });

  it('rejects a tampered report', async () => {
    const report = await buildReport(config, egress);
    const { publicKey, privateKey } = await generateAttestationKey();
    const signature = await signReport(report, privateKey);

    const tampered: PrivacyReport = { ...report, signature, htmlSha256: '00'.repeat(32) };
    await expect(verifyReport(tampered, publicKey)).resolves.toBe(false);
  });

  it('rejects a report without a signature', async () => {
    const report = await buildReport(config, egress);
    const { publicKey } = await generateAttestationKey();
    await expect(verifyReport(report, publicKey)).resolves.toBe(false);
  });

  it('returns false for a malformed JWK instead of throwing', async () => {
    const report = await buildReport(config, egress);
    const { privateKey } = await generateAttestationKey();
    const signature = await signReport(report, privateKey);

    await expect(
      verifyReport({ ...report, signature }, { kty: 'oct', k: 'AAAA', alg: 'HS256' }),
    ).resolves.toBe(false);
  });

  it('returns false for a signature that is not hex', async () => {
    const report = await buildReport(config, egress);
    const { publicKey } = await generateAttestationKey();
    await expect(verifyReport({ ...report, signature: 'not-hex' }, publicKey)).resolves.toBe(false);
  });

  it('rejects a report signed by a different key', async () => {
    const report = await buildReport(config, egress);
    const { publicKey } = await generateAttestationKey();
    const other = await generateAttestationKey();
    const signature = await signReport(report, other.privateKey);

    await expect(verifyReport({ ...report, signature }, publicKey)).resolves.toBe(false);
  });

  it('verifies against an exported JWK public key', async () => {
    const report = await buildReport(config, egress);
    const { publicKey, privateKey } = await generateAttestationKey();
    const signature = await signReport(report, privateKey);
    const jwk = await exportPublicKeyJwk(publicKey);

    await expect(verifyReport({ ...report, signature }, jwk)).resolves.toBe(true);
    await expect(verifyReport({ ...report, signature }, await importPublicKeyJwk(jwk))).resolves.toBe(
      true,
    );
  });
});
