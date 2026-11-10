import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  findExternalAssets,
  isExternalUrl,
  verifySingleFile,
} from '../../scripts/verify-singlefile.js';

const tmpDirs: string[] = [];

function makeFixture(name: string, html: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostshell-singlefile-'));
  tmpDirs.push(dir);
  const filePath = join(dir, name);
  writeFileSync(filePath, html);
  return filePath;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const VALID_HTML = `<!doctype html>
<html>
  <head>
    <script>console.log("inline");</script>
    <link rel="icon" href="data:image/png;base64,AAAA">
  </head>
  <body>GhostShell</body>
</html>
`;

describe('isExternalUrl', () => {
  it('treats inline and runtime URLs as self-contained', () => {
    expect(isExternalUrl('data:text/javascript;base64,AAAA')).toBe(false);
    expect(isExternalUrl('blob:https://example.com/uuid')).toBe(false);
    expect(isExternalUrl('#fragment')).toBe(false);
    expect(isExternalUrl('')).toBe(false);
  });

  it('treats separate files as external', () => {
    expect(isExternalUrl('./app.js')).toBe(true);
    expect(isExternalUrl('/assets/app.js')).toBe(true);
    expect(isExternalUrl('https://cdn.example.com/app.js')).toBe(true);
    expect(isExternalUrl('//cdn.example.com/app.js')).toBe(true);
  });
});

describe('findExternalAssets', () => {
  it('finds external script and link references', () => {
    const html =
      '<script src="./app.js"></script>' +
      "<link rel='stylesheet' href=\"/styles.css\">" +
      '<script src=https://cdn.example.com/x.js></script>';
    expect(findExternalAssets(html)).toHaveLength(3);
  });

  it('ignores inline scripts and data URLs', () => {
    const html =
      '<script>const x = 1;</script>' +
      '<script src="data:text/javascript;base64,AAAA"></script>' +
      '<link rel="icon" href="data:image/png;base64,AAAA">';
    expect(findExternalAssets(html)).toHaveLength(0);
  });
});

describe('verifySingleFile', () => {
  it('accepts a valid self-contained build', () => {
    const filePath = makeFixture('index.html', VALID_HTML);
    const result = verifySingleFile({ filePath });
    expect(result.errors).toEqual([]);
    expect(result.externalAssets).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('rejects an external script src', () => {
    const filePath = makeFixture(
      'index.html',
      '<html><head><script src="./app.js"></script></head></html>',
    );
    const result = verifySingleFile({ filePath });
    expect(result.ok).toBe(false);
    expect(result.externalAssets).toHaveLength(1);
    expect(result.errors[0]).toContain('external assets');
  });

  it('rejects an external link href', () => {
    const filePath = makeFixture(
      'index.html',
      '<html><head><link rel="stylesheet" href="/styles.css"></head></html>',
    );
    const result = verifySingleFile({ filePath });
    expect(result.ok).toBe(false);
    expect(result.externalAssets).toHaveLength(1);
  });

  it('rejects a build over the configurable budget', () => {
    const filePath = makeFixture('index.html', VALID_HTML);
    const result = verifySingleFile({ filePath, maxBytes: 16 });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('oversized');
  });

  it('rejects a missing build', () => {
    const result = verifySingleFile({ filePath: resolve(tmpdir(), 'ghostshell-does-not-exist.html') });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('does not exist');
  });

  it('rejects an empty build', () => {
    const filePath = makeFixture('index.html', '');
    const result = verifySingleFile({ filePath });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('0 bytes');
  });

  it('defaults to a 100 MB budget', () => {
    expect(DEFAULT_MAX_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe('dist/index.html', () => {
  const distPath = resolve(process.cwd(), 'dist/index.html');
  const distAvailable = existsSync(distPath);
  // In CI the artifact must exist; locally the check is skipped when the build
  // has not been produced yet.
  const checkDist = distAvailable || process.env.CI === '1';

  it.runIf(checkDist)('is self-contained and under budget', () => {
    const result = verifySingleFile({ filePath: distPath });
    if (!distAvailable) {
      expect(result.ok).toBe(false);
      expect(result.errors.some((error) => error.includes('does not exist'))).toBe(true);
      return;
    }
    expect(result.errors).toEqual([]);
    expect(result.externalAssets).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.sizeBytes).toBeLessThanOrEqual(result.maxBytes);
  });
});
