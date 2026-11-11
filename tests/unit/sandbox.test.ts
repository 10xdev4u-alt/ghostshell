import { describe, expect, it } from 'vitest';
import { ARTIFACT_CSP, ARTIFACT_SANDBOX, artifactSrcDoc, isSafeOrigin } from '@/core/security/sandbox.js';

/**
 * Artifact sandbox rules. The srcdoc must carry the restrictive CSP, and the
 * origin check must only admit http(s) URLs — `javascript:`, `data:`, and
 * malformed URLs are refused.
 */

describe('artifact sandbox', () => {
  it('wraps sanitized HTML in a document with the restrictive CSP', () => {
    const srcdoc = artifactSrcDoc('<p>hello</p>');
    expect(srcdoc).toContain('<p>hello</p>');
    expect(srcdoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcdoc).toContain(ARTIFACT_CSP);
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).toContain("connect-src 'none'");
  });

  it('declares the allow-scripts sandbox token', () => {
    expect(ARTIFACT_SANDBOX).toBe('allow-scripts');
  });

  it('admits http and https origins', () => {
    expect(isSafeOrigin('https://example.com/app')).toBe(true);
    expect(isSafeOrigin('http://localhost:8080/x')).toBe(true);
  });

  it('rejects non-network and malformed origins', () => {
    expect(isSafeOrigin('javascript:alert(1)')).toBe(false);
    expect(isSafeOrigin('data:text/html,<script>1</script>')).toBe(false);
    expect(isSafeOrigin('not a url')).toBe(false);
  });
});
