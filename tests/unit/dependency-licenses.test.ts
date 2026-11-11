import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ATTESTATION_CONFIG, DEPENDENCY_LICENSES, dependencyLicense } from '@/config.js';
import { buildReport } from '@/core/security/attestation.js';

/**
 * Issue #98: the attestation report must never render `unknown` for a
 * dependency that ships. package.json is read at test time so a newly added
 * runtime dependency fails here until its license is recorded.
 */
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

const runtimeDependencies = Object.keys(pkg.dependencies);

describe('DEPENDENCY_LICENSES', () => {
  it('has an entry for every runtime dependency in package.json', () => {
    const missing = runtimeDependencies.filter((name) => !(name in DEPENDENCY_LICENSES));
    expect(missing).toEqual([]);
  });

  it('records diff as BSD-3-Clause (issue #98)', () => {
    expect(DEPENDENCY_LICENSES['diff']).toBe('BSD-3-Clause');
  });

  it('falls back to "unknown" for a dependency with no entry', () => {
    expect(dependencyLicense('ghostshell-not-a-real-dependency')).toBe('unknown');
  });

  it('does not list devDependencies, which never ship', () => {
    const devOnly = Object.keys(pkg.devDependencies).filter(
      (name) => !(name in pkg.dependencies) && name in DEPENDENCY_LICENSES,
    );
    expect(devOnly).toEqual([]);
  });
});

describe('ATTESTATION_CONFIG dependencies', () => {
  it('renders a license for every runtime dependency', () => {
    const byName = new Map(ATTESTATION_CONFIG.dependencies.map((dep) => [dep.name, dep.license]));
    const missing = runtimeDependencies.filter((name) => !byName.has(name));
    const unknown = runtimeDependencies.filter((name) => byName.get(name) === 'unknown');
    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('carries the diff license into the built report', async () => {
    const report = await buildReport(ATTESTATION_CONFIG, []);
    const diff = report.dependencies.find((dep) => dep.name === 'diff');
    expect(diff?.version).toBe(pkg.dependencies['diff']);
    expect(diff?.license).toBe('BSD-3-Clause');
  });
});
