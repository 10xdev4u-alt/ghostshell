import { describe, expect, it } from 'vitest';
import { V86_WASM_URL } from '@/core/vm/wasm.js';

/**
 * The single-file release must carry the v86 emulator WASM as an inlined data
 * URL, not a fetch to `build/v86.wasm` (which does not exist in the release).
 * See issue #87.
 */
describe('V86_WASM_URL', () => {
  it('is an inlined base64 data URL', () => {
    expect(V86_WASM_URL.startsWith('data:')).toBe(true);
    expect(V86_WASM_URL).toContain(';base64,');
  });

  it('decodes to the real v86.wasm module', () => {
    const separator = V86_WASM_URL.indexOf(',');
    expect(separator).toBeGreaterThan(0);
    const bytes = Uint8Array.from(atob(V86_WASM_URL.slice(separator + 1)), (ch) =>
      ch.charCodeAt(0),
    );

    // WebAssembly magic number (\0asm) and version 1.
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    // The real module is ~2 MB; a stub or empty payload must fail here.
    expect(bytes.byteLength).toBeGreaterThan(1_000_000);
  });
});
