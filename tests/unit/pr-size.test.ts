import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildReport,
  formatReport,
  isOverLimit,
  parsePrViewJson,
  shouldSkip,
  sortBreakdown,
  totalChangedLines,
} from '../../scripts/pr-size.js';

const sampleJson = JSON.stringify({
  additions: 250,
  deletions: 100,
  state: 'OPEN',
  files: [
    { path: 'src/big.ts', additions: 200, deletions: 50 },
    { path: 'src/small.ts', additions: 50, deletions: 50 },
    { path: 'README.md', additions: 0, deletions: 0 },
  ],
});

describe('pr-size', () => {
  describe('parsePrViewJson', () => {
    it('parses additions, deletions, and the per-file breakdown', () => {
      const parsed = parsePrViewJson(sampleJson);
      expect(parsed.additions).toBe(250);
      expect(parsed.deletions).toBe(100);
      expect(parsed.merged).toBe(false);
      expect(parsed.files).toEqual([
        { path: 'src/big.ts', additions: 200, deletions: 50 },
        { path: 'src/small.ts', additions: 50, deletions: 50 },
        { path: 'README.md', additions: 0, deletions: 0 },
      ]);
    });

    it('derives merged from state for OPEN, MERGED, and CLOSED', () => {
      const base = { additions: 1, deletions: 2, files: [] };
      expect(parsePrViewJson(JSON.stringify({ ...base, state: 'OPEN' })).merged).toBe(false);
      expect(parsePrViewJson(JSON.stringify({ ...base, state: 'MERGED' })).merged).toBe(true);
      expect(parsePrViewJson(JSON.stringify({ ...base, state: 'CLOSED' })).merged).toBe(false);
    });

    it('rejects an unknown state', () => {
      const raw = JSON.stringify({ additions: 1, deletions: 2, files: [], state: 'DRAFT' });
      expect(() => parsePrViewJson(raw)).toThrow('invalid state');
    });

    it('rejects a missing state', () => {
      expect(() => parsePrViewJson('{"additions":1,"deletions":2,"files":[]}')).toThrow(
        'invalid state',
      );
    });

    it('rejects invalid JSON', () => {
      expect(() => parsePrViewJson('not json')).toThrow('invalid JSON');
    });

    it('rejects a missing files array', () => {
      expect(() =>
        parsePrViewJson('{"additions":1,"deletions":2,"state":"OPEN"}'),
      ).toThrow('missing the files array');
    });

    it('rejects negative counts', () => {
      const raw = JSON.stringify({
        additions: -1,
        deletions: 0,
        state: 'OPEN',
        files: [{ path: 'a.ts', additions: 0, deletions: 0 }],
      });
      expect(() => parsePrViewJson(raw)).toThrow('invalid additions');
    });
  });

  describe('totalChangedLines', () => {
    it('adds additions and deletions', () => {
      expect(totalChangedLines(250, 100)).toBe(350);
    });
  });

  describe('isOverLimit', () => {
    it('is not over at exactly the limit', () => {
      expect(isOverLimit(400, 400)).toBe(false);
    });

    it('is over one line past the limit', () => {
      expect(isOverLimit(401, 400)).toBe(true);
    });
  });

  describe('sortBreakdown', () => {
    it('puts the largest file first and breaks ties by path', () => {
      const sorted = sortBreakdown([
        { path: 'b.ts', additions: 5, deletions: 5 },
        { path: 'a.ts', additions: 20, deletions: 0 },
        { path: 'c.ts', additions: 20, deletions: 0 },
      ]);
      expect(sorted.map((file) => file.path)).toEqual(['a.ts', 'c.ts', 'b.ts']);
    });

    it('does not mutate the input', () => {
      const input = [
        { path: 'a.ts', additions: 1, deletions: 0 },
        { path: 'b.ts', additions: 2, deletions: 0 },
      ];
      sortBreakdown(input);
      expect(input.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    });
  });

  describe('shouldSkip', () => {
    it('skips push events (merges to main)', () => {
      const result = shouldSkip('push', false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toContain('push');
    });

    it('skips already-merged PRs', () => {
      expect(shouldSkip('pull_request', true).skipped).toBe(true);
    });

    it('runs on open pull_request events', () => {
      const result = shouldSkip('pull_request', false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toBeNull();
    });
  });

  describe('buildReport', () => {
    it('computes the total and flags an over-limit PR', () => {
      const report = buildReport({
        number: 42,
        data: parsePrViewJson(sampleJson),
        limit: 300,
        eventName: 'pull_request',
      });
      expect(report.total).toBe(350);
      expect(report.overLimit).toBe(true);
      expect(report.skipped).toBe(false);
      expect(report.files[0]?.path).toBe('src/big.ts');
    });

    it('reports a within-limit PR', () => {
      const report = buildReport({
        number: 42,
        data: parsePrViewJson(sampleJson),
        limit: 400,
        eventName: 'pull_request',
      });
      expect(report.overLimit).toBe(false);
    });

    it('marks push events as skipped', () => {
      const report = buildReport({
        number: 42,
        data: parsePrViewJson(sampleJson),
        limit: 300,
        eventName: 'push',
      });
      expect(report.skipped).toBe(true);
      expect(report.overLimit).toBe(true);
    });
  });

  describe('formatReport', () => {
    it('prints the per-file breakdown and the over-limit message', () => {
      const report = buildReport({
        number: 42,
        data: parsePrViewJson(sampleJson),
        limit: 300,
        eventName: 'pull_request',
      });
      const text = formatReport(report);
      expect(text).toContain('PR #42: +250 / -100 = 350 changed lines (limit 300)');
      expect(text).toContain('src/big.ts');
      expect(text).toContain('src/small.ts');
      expect(text).toContain('50 lines over the 300-line limit');
    });

    it('prints a within-limit message', () => {
      const report = buildReport({
        number: 7,
        data: parsePrViewJson(sampleJson),
        limit: 400,
        eventName: 'pull_request',
      });
      expect(formatReport(report)).toContain('within the 400-line limit');
    });

    it('prints a skip message instead of a breakdown', () => {
      const report = buildReport({
        number: 42,
        data: parsePrViewJson(sampleJson),
        limit: 400,
        eventName: 'push',
      });
      const text = formatReport(report);
      expect(text).toContain('skipped');
      expect(text).not.toContain('Per-file breakdown');
    });
  });
});

function canRunGh(): boolean {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function findBun(): string | null {
  const bunVersion = (process.versions as unknown as Record<string, unknown>).bun;
  if (typeof bunVersion === 'string') return process.execPath;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, 'bun');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe('pr-size real gh regression', () => {
  const scriptPath = fileURLToPath(new URL('../../scripts/pr-size.ts', import.meta.url));
  const ghReady = canRunGh();
  const bunPath = findBun();

  if (!ghReady || bunPath === null) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping the real-gh pr-size regression test: ' +
        `${ghReady ? '' : 'gh is missing or not authenticated (`gh auth status` failed). '}` +
        `${bunPath === null ? 'bun was not found on PATH.' : ''}`,
    );
  }

  it.skipIf(!ghReady || bunPath === null)(
    'runs against PR #107 and exits 0',
    () => {
      const result = spawnSync(
        bunPath ?? 'bun',
        ['run', scriptPath, '--pr', '107', '--limit', '100000'],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('skipped');
      expect(result.stderr).not.toContain('Unknown JSON field');
    },
    60_000,
  );
});
