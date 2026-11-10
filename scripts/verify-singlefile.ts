#!/usr/bin/env bun
/**
 * Verify that the single-file build is self-contained.
 *
 * Checks `dist/single/index.html` (or a path passed as the first argument):
 *   1. the file exists and is not empty;
 *   2. it references no external files via `<script src=...>` or
 *      `<link href=...>` (inline `data:` / `blob:` / fragment URLs are fine);
 *   3. its size is under a configurable budget (default 100 MB).
 *
 * Exits non-zero on the first failed check category, so it can gate CI and
 * `bun run build:verify`.
 *
 * Usage:
 *   bun run scripts/verify-singlefile.ts [file] [--max-bytes N]
 *
 * Environment:
 *   SINGLEFILE_MAX_BYTES  default budget in bytes (default 104857600)
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
export const DEFAULT_FILE = 'dist/single/index.html';

export interface VerifyOptions {
  /** Path to the built HTML file. */
  filePath: string;
  /** Maximum allowed size in bytes. Defaults to 100 MB. */
  maxBytes?: number;
}

export interface VerificationResult {
  ok: boolean;
  filePath: string;
  sizeBytes: number;
  maxBytes: number;
  externalAssets: string[];
  errors: string[];
}

/** Tags whose `src`/`href` must not point at a separate file. */
const TAG_RE = /<\s*(script|link)\b[^>]*>/gi;
const ATTR_RE = /(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

/**
 * True when a URL points at something that must be fetched separately.
 * Inline payloads (`data:`, `blob:`) and pure fragments are self-contained.
 */
export function isExternalUrl(url: string): boolean {
  const value = url.trim();
  if (value === '') return false;
  return !/^(?:data:|blob:|#)/i.test(value);
}

/** Collect `<script src=...>` / `<link href=...>` values that leave the file. */
export function findExternalAssets(html: string): string[] {
  const found: string[] = [];
  for (const tag of html.matchAll(TAG_RE)) {
    const markup = tag[0] ?? '';
    const attr = ATTR_RE.exec(markup);
    const value = attr?.[1] ?? attr?.[2] ?? attr?.[3] ?? '';
    if (isExternalUrl(value)) {
      const tagName = (tag[1] ?? '').toLowerCase();
      found.push(`<${tagName} ${attr?.[0] ?? 'src/href'}>`);
    }
  }
  return found;
}

/**
 * Verify a single-file build. Never throws for a missing or oversized file;
 * problems are reported in `errors` / `externalAssets` and `ok` is false.
 */
export function verifySingleFile(options: VerifyOptions): VerificationResult {
  const filePath = resolve(options.filePath);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const errors: string[] = [];
  const externalAssets: string[] = [];
  let sizeBytes = 0;

  if (!existsSync(filePath)) {
    errors.push(`missing: ${filePath} does not exist`);
  } else {
    const stat = statSync(filePath);
    sizeBytes = stat.size;
    if (sizeBytes === 0) {
      errors.push(`empty: ${filePath} is 0 bytes`);
    }
    if (sizeBytes > maxBytes) {
      errors.push(
        `oversized: ${filePath} is ${formatBytes(sizeBytes)}, budget is ${formatBytes(maxBytes)}`,
      );
    }
    const html = readFileSync(filePath, 'utf8');
    externalAssets.push(...findExternalAssets(html));
    if (externalAssets.length > 0) {
      errors.push(
        `external assets: ${externalAssets.length} reference(s) to files outside the build`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    filePath,
    sizeBytes,
    maxBytes,
    externalAssets,
    errors,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

interface CliArgs {
  filePath: string;
  maxBytes: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let filePath = process.env.SINGLEFILE_FILE ?? DEFAULT_FILE;
  const envBudget = Number(process.env.SINGLEFILE_MAX_BYTES);
  let maxBytes = Number.isFinite(envBudget) && envBudget > 0 ? envBudget : DEFAULT_MAX_BYTES;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--max-bytes') {
      const next = argv[i + 1];
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxBytes = parsed;
        i += 1;
      } else {
        throw new Error(`--max-bytes requires a positive number, got "${next}"`);
      }
    } else if (arg.startsWith('--max-bytes=')) {
      const parsed = Number(arg.slice('--max-bytes='.length));
      if (Number.isFinite(parsed) && parsed > 0) {
        maxBytes = parsed;
      } else {
        throw new Error(`--max-bytes requires a positive number, got "${arg}"`);
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      filePath = arg;
    }
  }

  return { filePath, maxBytes, help };
}

function printHelp(): void {
  process.stdout.write(`Verify the single-file build is self-contained.

Usage: bun run scripts/verify-singlefile.ts [file] [options]

Options:
  --max-bytes <n>   Size budget in bytes (default 104857600, env SINGLEFILE_MAX_BYTES)
  -h, --help        Show this help

Environment:
  SINGLEFILE_FILE       File to verify (default dist/single/index.html)
  SINGLEFILE_MAX_BYTES  Default size budget in bytes

The file must exist, be non-empty, reference no external <script src> or
<link href> files, and be under the size budget. Exits non-zero on failure.
`);
}

function report(result: VerificationResult): void {
  if (result.ok) {
    process.stdout.write(
      `✓ ${result.filePath} is self-contained (${formatBytes(result.sizeBytes)}, ` +
        `budget ${formatBytes(result.maxBytes)})\n`,
    );
    return;
  }
  process.stderr.write(`✗ ${result.filePath}: ${result.errors.length} problem(s)\n`);
  for (const error of result.errors) {
    process.stderr.write(`  - ${error}\n`);
  }
  for (const asset of result.externalAssets) {
    process.stderr.write(`  - external reference: ${asset}\n`);
  }
}

const invokedDirectly = (import.meta as ImportMeta & { main?: boolean }).main === true;

if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
    } else {
      const result = verifySingleFile({ filePath: args.filePath, maxBytes: args.maxBytes });
      report(result);
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
