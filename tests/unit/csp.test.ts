import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Read the CSP from the meta tag in index.html.
 *
 * The file is read from disk on every run: a hardcoded copy would keep
 * passing after the real policy regressed, which is exactly what happened
 * with the connect-src 'none' / worker-src 'none' lockdown.
 */
function readCsp(): string {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  const tag = /<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/i.exec(html)?.[0];
  const content = tag ? /content="([^"]*)"/i.exec(tag)?.[1] : undefined;
  if (!content) throw new Error('index.html has no Content-Security-Policy meta tag');
  return content;
}

/** The source list for a directive, or '' when the directive is absent. */
function directive(csp: string, name: string): string {
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (trimmed === name) return '';
    if (trimmed.startsWith(`${name} `)) return trimmed.slice(name.length).trim();
  }
  return '';
}

describe('index.html Content-Security-Policy', () => {
  const csp = readCsp();

  it('allows WebAssembly so v86 and the WASM LLM can instantiate', () => {
    expect(directive(csp, 'script-src')).toContain("'wasm-unsafe-eval'");
  });

  it('allows the inline module script and artifact srcdoc script', () => {
    expect(directive(csp, 'script-src')).toContain("'unsafe-inline'");
    expect(directive(csp, 'style-src')).toContain("'unsafe-inline'");
  });

  it('allows the model download and v86 boot hosts', () => {
    const connectSrc = directive(csp, 'connect-src');
    for (const host of [
      'https://huggingface.co',
      'https://cdn-lfs.huggingface.co',
      'https://cdn.jsdelivr.net',
      'https://copy.sh',
    ]) {
      expect(connectSrc).toContain(host);
    }
  });

  it('allows data: and blob: artifact images', () => {
    const imgSrc = directive(csp, 'img-src');
    expect(imgSrc).toContain('data:');
    expect(imgSrc).toContain('blob:');
  });

  it('allows same-origin and blob workers', () => {
    const workerSrc = directive(csp, 'worker-src');
    expect(workerSrc).toContain("'self'");
    expect(workerSrc).toContain('blob:');
  });

  it('keeps the lockdown defaults for everything else', () => {
    expect(directive(csp, 'default-src')).toBe("'none'");
    expect(directive(csp, 'object-src')).toBe("'none'");
    expect(directive(csp, 'frame-src')).toBe("'none'");
    expect(directive(csp, 'form-action')).toBe("'none'");
    expect(directive(csp, 'base-uri')).toBe("'none'");
  });

  it('does not use connect-src none, which would break the model download', () => {
    expect(directive(csp, 'connect-src')).not.toBe("'none'");
  });
});
