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
  merged: false,
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

    it('defaults merged to undefined when gh omits it', () => {
      const parsed = parsePrViewJson('{"additions":1,"deletions":2,"files":[]}');
      expect(parsed.merged).toBeUndefined();
    });

    it('rejects invalid JSON', () => {
      expect(() => parsePrViewJson('not json')).toThrow('invalid JSON');
    });

    it('rejects a missing files array', () => {
      expect(() => parsePrViewJson('{"additions":1,"deletions":2}')).toThrow(
        'missing the files array',
      );
    });

    it('rejects negative counts', () => {
      const raw = JSON.stringify({
        additions: -1,
        deletions: 0,
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
