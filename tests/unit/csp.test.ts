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

/**
 * Minimal CSP source-expression matcher for the sources GhostShell loads.
 *
 * This is not a CSP implementation. It parses directive lists and implements
 * only the matching rules this app needs: scheme sources (data:, blob:),
 * 'self', and https host sources with an optional leading `*` subdomain
 * wildcard. Paths, ports, nonces/hashes, redirects, and default-src fallback
 * are ignored.
 *
 * 'self' is modeled as http(s)-only. Headless Chromium does not match
 * 'self' against a same-origin blob: URL (verified with the throwaway probe:
 * `connect-src 'self'` still blocked a blob: fetch with a CSP violation),
 * so keeping blob: out of 'self' is what makes the blob: assertion below
 * depend on the explicit `blob:` source.
 *
 * What this proves: the connect-src directive in index.html names a source
 * expression that matches each URL shape the app fetches at runtime (the
 * inlined v86 wasm data: URL, blob: asset URLs, and the remote boot hosts).
 * What it does not prove: that a browser will actually allow the request.
 * It parses policy text; it does not execute the policy. The browser probe
 * that caught the original regression remains the authoritative check.
 */
type CspSource =
  | { kind: 'scheme'; scheme: string }
  | { kind: 'host'; scheme: string | null; host: string; wildcard: boolean }
  | { kind: 'self' }
  | { kind: 'none' }
  | { kind: 'other'; raw: string };

function parseSources(list: string): CspSource[] {
  const sources: CspSource[] = [];
  for (const raw of list.split(/\s+/).filter(Boolean)) {
    if (raw === "'none'") {
      sources.push({ kind: 'none' });
    } else if (raw === "'self'") {
      sources.push({ kind: 'self' });
    } else if (/^[a-z][a-z0-9+.-]*:$/i.test(raw)) {
      sources.push({ kind: 'scheme', scheme: raw.slice(0, -1).toLowerCase() });
    } else {
      const match = /^([a-z][a-z0-9+.-]*:\/\/)?(\*\.?)?([^:/?#\s]+)/i.exec(raw);
      if (match) {
        const scheme = match[1] ? match[1].slice(0, -3).toLowerCase() : null;
        const hostPart = match[2] ? match[2].replace(/^\*\.?/, '') : '';
        sources.push({
          kind: 'host',
          scheme,
          wildcard: match[2] === '*.',
          host: `${hostPart}${match[3] ?? ''}`.toLowerCase(),
        });
      } else {
        sources.push({ kind: 'other', raw });
      }
    }
  }
  return sources;
}

function matchesSource(source: CspSource, url: URL, selfOrigin: string): boolean {
  switch (source.kind) {
    case 'none':
      return false;
    case 'self':
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === selfOrigin
      );
    case 'scheme':
      return url.protocol === `${source.scheme}:`;
    case 'host': {
      if (source.scheme !== null && url.protocol !== `${source.scheme}:`) return false;
      const host = url.hostname.toLowerCase();
      return source.wildcard
        ? host === source.host || host.endsWith(`.${source.host}`)
        : host === source.host;
    }
    case 'other':
      return false;
  }
}

/** True when the connect-src directive permits `input`, built as a Request. */
function connectSrcPermits(csp: string, input: string, selfOrigin: string): boolean {
  const sources = parseSources(directive(csp, 'connect-src'));
  const url = new URL(new Request(input).url);
  return sources.some((source) => matchesSource(source, url, selfOrigin));
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
      // HF resolve URLs redirect to the Xet CDN (us.aws.cdn.hf.co, and
      // other regional hosts), so the wildcard covers the CDN.
      'https://*.hf.co',
      'https://cdn.jsdelivr.net',
      'https://copy.sh',
    ]) {
      expect(connectSrc).toContain(host);
    }
  });

  it('allows the inlined wasm data: URL and blob: assets in connect-src', () => {
    const connectSrc = directive(csp, 'connect-src');
    expect(connectSrc).toContain('data:');
    expect(connectSrc).toContain('blob:');
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

describe('connect-src source matching', () => {
  const csp = readCsp();
  // The app is a static file, so its origin depends on where it is served.
  // 'self' is origin-relative; this representative origin keeps the test
  // about the source expressions rather than the deployment.
  const selfOrigin = 'https://ghostshell.local';

  // Every URL shape the app loads through fetch/XHR at runtime.
  const runtimeUrls = [
    // The single-file build inlines v86's WASM as a data: URL; v86 loads it
    // with fetch/XHR (src/core/vm/wasm.ts).
    'data:application/wasm;base64,AGFzbQEAAAA=',
    // Blob-loaded assets (artifact images, ONNX/transformers worker pools).
    'blob:https://ghostshell.local/91bf236f-6f28-403a-ad45-95321f462797',
    // v86 boot media (BIOS + VGA BIOS) — src/core/vm/image.ts.
    'https://copy.sh/v86/bios/seabios.bin',
    // Model weights on the HF Hub.
    'https://huggingface.co/onnx-community/Qwen2.5-1.5B-Instruct/resolve/main/onnx/model.onnx',
    // HF resolve URLs redirect to the regional Xet CDN.
    'https://us.aws.cdn.hf.co/resolve/main/onnx/model.onnx',
    // ONNX runtime artifacts fetched by @huggingface/transformers.
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.0/dist/transformers.min.js',
    // Same-origin module/script loads.
    'https://ghostshell.local/src/main.ts',
  ];

  it.each(runtimeUrls)('permits the runtime URL %s', (input) => {
    expect(connectSrcPermits(csp, input, selfOrigin)).toBe(true);
  });

  it('does not permit arbitrary remote hosts', () => {
    expect(connectSrcPermits(csp, 'https://evil.example.com/secret', selfOrigin)).toBe(false);
    expect(connectSrcPermits(csp, 'https://notcopy.sh/secret', selfOrigin)).toBe(false);
    expect(connectSrcPermits(csp, 'https://copy.sh.evil.example.com/secret', selfOrigin)).toBe(
      false,
    );
  });

  it('does not permit a remote URL through a non-matching scheme', () => {
    // The host sources are https-only; http:// must not match them.
    expect(connectSrcPermits(csp, 'http://copy.sh/v86/bios/seabios.bin', selfOrigin)).toBe(false);
  });
});
