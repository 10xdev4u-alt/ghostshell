import { describe, expect, it } from 'vitest';
import {
  assert,
  debounce,
  escapeHtml,
  formatBytes,
  formatDuration,
  truncate,
  uuid,
} from '@/lib/utils.js';

describe('uuid', () => {
  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuid()));
    expect(ids.size).toBe(1000);
  });

  it('uses the v4 shape', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('formatBytes', () => {
  it('formats human-readable sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('formatDuration', () => {
  it('formats ms, s, and m', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(45_000)).toBe('45.0s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});

describe('truncate', () => {
  it('truncates long strings', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello world', 8)).toBe('hello w…');
  });
});

describe('escapeHtml', () => {
  it('escapes dangerous characters', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });
});

describe('assert', () => {
  it('throws on falsy', () => {
    expect(() => assert(false, 'boom')).toThrow('boom');
    expect(() => assert(true, 'boom')).not.toThrow();
  });
});

describe('debounce', () => {
  it('coalesces calls', async () => {
    let calls = 0;
    const fn = debounce(() => {
      calls += 1;
    }, 20);
    fn();
    fn();
    fn();
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(1);
  });
});
