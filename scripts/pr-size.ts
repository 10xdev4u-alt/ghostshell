#!/usr/bin/env bun
/**
 * Check that a pull request stays reviewable.
 *
 * Fails when the PR's total changed lines (additions + deletions) exceed a
 * limit (default 400) and prints a per-file breakdown so reviewers can see
 * what is big. The check is skipped for merges to main (push events) and for
 * PRs that are already merged.
 *
 * Usage:
 *   bun run scripts/pr-size.ts --pr 42 [--limit 400] [--warn]
 *
 * Environment:
 *   PR_SIZE_LIMIT  default changed-line limit (default 400)
 *   PR_NUMBER      PR number when --pr is omitted (gh infers from the branch)
 *   GITHUB_EVENT_NAME  event name; a `push` value skips the check
 *   GH_TOKEN       token for `gh pr view` (set automatically in Actions)
 */

import { execFileSync } from 'node:child_process';

export const DEFAULT_LIMIT = 400;

export interface PrFileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrSizeInput {
  additions: number;
  deletions: number;
  files: PrFileChange[];
  merged: boolean | undefined;
}

export interface PrSizeReport {
  number: number | null;
  additions: number;
  deletions: number;
  total: number;
  limit: number;
  overLimit: boolean;
  files: PrFileChange[];
  skipped: boolean;
  skipReason: string | null;
}

/** The reviewable diff size is additions plus deletions. */
export function totalChangedLines(additions: number, deletions: number): number {
  return additions + deletions;
}

/** At the limit is fine; one line over is not. */
export function isOverLimit(total: number, limit: number): boolean {
  return total > limit;
}

/** Largest files first so the big ones stand out; ties break by path. */
export function sortBreakdown(files: PrFileChange[]): PrFileChange[] {
  return [...files].sort((a, b) => {
    const bySize =
      totalChangedLines(b.additions, b.deletions) -
      totalChangedLines(a.additions, a.deletions);
    if (bySize !== 0) return bySize;
    return a.path.localeCompare(b.path);
  });
}

function readCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`gh pr view returned an invalid ${field}: ${String(value)}`);
  }
  return value;
}

/** Parse the JSON payload from `gh pr view --json additions,deletions,files,merged`. */
export function parsePrViewJson(raw: string): PrSizeInput {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('gh pr view returned invalid JSON');
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error('gh pr view returned a non-object payload');
  }
  const record = data as Record<string, unknown>;
  const rawFiles = record.files;
  if (!Array.isArray(rawFiles)) {
    throw new Error('gh pr view payload is missing the files array');
  }
  const files = rawFiles.map((entry: unknown, index: number): PrFileChange => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`files[${index}] is not an object`);
    }
    const file = entry as Record<string, unknown>;
    return {
      path: typeof file.path === 'string' ? file.path : `unknown-${index}`,
      additions: readCount(file.additions, `files[${index}].additions`),
      deletions: readCount(file.deletions, `files[${index}].deletions`),
    };
  });
  return {
    additions: readCount(record.additions, 'additions'),
    deletions: readCount(record.deletions, 'deletions'),
    files,
    merged: typeof record.merged === 'boolean' ? record.merged : undefined,
  };
}

/** Merges to main are not reviewable PRs; skip them. */
export function shouldSkip(
  eventName: string | undefined,
  merged: boolean | undefined,
): { skipped: boolean; reason: string | null } {
  if (eventName === 'push') {
    return {
      skipped: true,
      reason: 'push event (merge to main) — size check only runs on pull_request',
    };
  }
  if (merged === true) {
    return { skipped: true, reason: 'pull request is already merged into main' };
  }
  return { skipped: false, reason: null };
}

export function buildReport(input: {
  number: number | null;
  data: PrSizeInput;
  limit: number;
  eventName?: string | undefined;
}): PrSizeReport {
  const { skipped, reason } = shouldSkip(input.eventName, input.data.merged);
  const total = totalChangedLines(input.data.additions, input.data.deletions);
  return {
    number: input.number,
    additions: input.data.additions,
    deletions: input.data.deletions,
    total,
    limit: input.limit,
    overLimit: isOverLimit(total, input.limit),
    files: sortBreakdown(input.data.files),
    skipped,
    skipReason: reason,
  };
}

export function formatReport(report: PrSizeReport): string {
  if (report.skipped) {
    return `⊘ PR size check skipped: ${report.skipReason}`;
  }
  const label = report.number === null ? 'PR' : `PR #${report.number}`;
  const lines = [
    `${label}: +${report.additions} / -${report.deletions} = ${report.total} changed lines (limit ${report.limit})`,
    '',
    'Per-file breakdown (changed lines, largest first):',
    ...report.files.map((file) => {
      const total = totalChangedLines(file.additions, file.deletions);
      return `  ${String(total).padStart(5)}  +${file.additions} -${file.deletions}  ${file.path}`;
    }),
    '',
    report.overLimit
      ? `✗ ${label} is ${report.total - report.limit} lines over the ${report.limit}-line limit`
      : `✓ ${label} is within the ${report.limit}-line limit`,
  ];
  return lines.join('\n');
}

/** Run `gh pr view` and return the parsed payload. `null` lets gh infer the PR. */
export function fetchPrSize(prNumber: number | null): PrSizeInput {
  const args = ['pr', 'view'];
  if (prNumber !== null) args.push(String(prNumber));
  args.push('--json', 'additions,deletions,files,merged');
  const raw = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return parsePrViewJson(raw);
}

interface CliArgs {
  prNumber: number | null;
  limit: number;
  warnOnly: boolean;
  help: boolean;
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer, got "${String(value)}"`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliArgs {
  const envLimit = Number(process.env.PR_SIZE_LIMIT);
  const envPr = Number(process.env.PR_NUMBER);
  let limit = Number.isFinite(envLimit) && envLimit > 0 ? envLimit : DEFAULT_LIMIT;
  let prNumber =
    Number.isInteger(envPr) && envPr > 0 ? envPr : null;
  let warnOnly = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--warn') {
      warnOnly = true;
    } else if (arg === '--pr' || arg === '--limit') {
      const parsed = parsePositiveInteger(argv[i + 1], arg);
      if (arg === '--pr') prNumber = parsed;
      else limit = parsed;
      i += 1;
    } else if (arg.startsWith('--pr=')) {
      prNumber = parsePositiveInteger(arg.slice('--pr='.length), '--pr');
    } else if (arg.startsWith('--limit=')) {
      limit = parsePositiveInteger(arg.slice('--limit='.length), '--limit');
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      prNumber = parsePositiveInteger(arg, 'PR number');
    }
  }

  return { prNumber, limit, warnOnly, help };
}

function printHelp(): void {
  process.stdout.write(`Check that a pull request stays reviewable.

Usage: bun run scripts/pr-size.ts [--pr <number>] [options]

Options:
  --pr <number>    PR number (default: $PR_NUMBER, or gh infers from the branch)
  --limit <n>      Changed-line limit (default: 400, env PR_SIZE_LIMIT)
  --warn           Warn when over the limit instead of failing
  -h, --help       Show this help

Environment:
  PR_SIZE_LIMIT      Default changed-line limit
  PR_NUMBER          PR number when --pr is omitted
  GITHUB_EVENT_NAME  A "push" value skips the check (merges to main)
  GH_TOKEN           Token for gh pr view

Exits non-zero when the PR is over the limit and --warn is not set.
`);
}

const invokedDirectly = (import.meta as ImportMeta & { main?: boolean }).main === true;

if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
    } else {
      const data = fetchPrSize(args.prNumber);
      const report = buildReport({
        number: args.prNumber,
        data,
        limit: args.limit,
        eventName: process.env.GITHUB_EVENT_NAME,
      });
      process.stdout.write(`${formatReport(report)}\n`);
      if (!report.skipped && report.overLimit && !args.warnOnly) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
