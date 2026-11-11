import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTESTATION_CONFIG, DEPENDENCY_LICENSES } from '@/config.js';
import { buildReport } from '@/core/security/attestation.js';
import {
  createPrivacyReportSection,
  renderPrivacyReport,
  serializePrivacyReport,
} from '@/ui/settings.js';
import type { EgressEvent } from '@/types/index.js';

/**
 * Minimal DOM stub.
 *
 * Vitest runs in the node environment and no DOM implementation is a
 * dependency, so the section builder is exercised against just enough of
 * `document.createElement` to build and query the element tree.
 */
class FakeElement {
  readonly tagName: string;
  className = '';
  disabled = false;
  type = '';
  children: FakeElement[] = [];
  private ownText = '';
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = [...children];
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click(): void {
    for (const listener of this.listeners.get('click') ?? []) listener();
  }

  querySelector(selector: string): FakeElement | undefined {
    const tag = selector.startsWith('.') ? undefined : selector.toUpperCase();
    const className = selector.startsWith('.') ? selector.slice(1) : undefined;
    const visit = (element: FakeElement): FakeElement | undefined => {
      for (const child of element.children) {
        if (tag !== undefined && child.tagName === tag) return child;
        if (className !== undefined && child.className.split(/\s+/).includes(className)) {
          return child;
        }
        const nested = visit(child);
        if (nested) return nested;
      }
      return undefined;
    };
    return visit(this);
  }
}

function installFakeDocument(): void {
  const document = {
    body: new FakeElement('body'),
    createElement: (tagName: string) => new FakeElement(tagName),
  };
  (globalThis as unknown as { document: unknown }).document = document;
}

/** DOM types say Element; the stub returns a FakeElement. */
function asFake(element: unknown): FakeElement | undefined {
  return element as FakeElement | undefined;
}

function collectByTag(root: FakeElement, tagName: string): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (element: FakeElement): void => {
    for (const child of element.children) {
      if (child.tagName === tagName.toUpperCase()) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

interface DependencyRow {
  name: string;
  version: string;
  license: string;
}

/** Read the rendered dependency table, skipping its header row. */
function readDependencyRows(root: unknown): DependencyRow[] {
  const table = (root as FakeElement).querySelector('.privacy-report__dependencies');
  if (!table) return [];
  return collectByTag(table, 'tr')
    .slice(1)
    .map((row) => {
      const cells = collectByTag(row, 'td');
      return {
        name: cells[0]?.textContent ?? '',
        version: cells[1]?.textContent ?? '',
        license: cells[2]?.textContent ?? '',
      };
    });
}

const egress: EgressEvent[] = [
  {
    id: 'event-1',
    timestamp: 1_700_000_000_000,
    url: 'https://example.com',
    method: 'GET',
    blocked: true,
    reason: 'lockdown',
  },
];

describe('createPrivacyReportSection', () => {
  beforeEach(() => installFakeDocument());

  it('returns a section with the expected headings and controls', () => {
    const section = createPrivacyReportSection({ config: ATTESTATION_CONFIG, egress: [] });

    expect(section.className).toBe('privacy-report-section');
    expect(asFake(section.querySelector('h2'))?.textContent).toBe('Privacy report');
    expect(asFake(section.querySelector('.privacy-report-section__generate'))?.textContent).toBe(
      'Generate report',
    );
    expect(asFake(section.querySelector('.privacy-report-section__download'))?.disabled).toBe(
      true,
    );
    expect(asFake(section.querySelector('.privacy-report-section__output'))).toBeDefined();
  });

  it('renders a signed report and enables the download after generating', async () => {
    const section = createPrivacyReportSection({ config: ATTESTATION_CONFIG, egress: [] });

    asFake(section.querySelector('.privacy-report-section__generate'))!.click();
    await vi.waitFor(() => {
      expect(asFake(section.querySelector('.privacy-report-section__download'))?.disabled).toBe(
        false,
      );
    });

    const output = asFake(section.querySelector('.privacy-report-section__output'))!;
    expect(asFake(output.querySelector('h2'))?.textContent).toBe('Privacy attestation');
    expect(output.textContent).toContain('HTML sha256');
    expect(output.textContent).toContain('Model sha256');
    expect(output.textContent).toContain('VM image sha256');
    expect(output.textContent).toContain('Dependencies');
    expect(output.textContent).toContain('Signature (ECDSA P-256)');
    expect(asFake(output.querySelector('h3'))?.textContent).toBe('Verification key (JWK)');
  });

  it('renders one row per runtime dependency with its license (#101)', async () => {
    const section = createPrivacyReportSection({ config: ATTESTATION_CONFIG, egress: [] });

    asFake(section.querySelector('.privacy-report-section__generate'))!.click();
    await vi.waitFor(() => {
      expect(asFake(section.querySelector('.privacy-report-section__download'))?.disabled).toBe(
        false,
      );
    });

    const output = asFake(section.querySelector('.privacy-report-section__output'))!;
    const rows = readDependencyRows(output);
    expect(rows).toHaveLength(ATTESTATION_CONFIG.dependencies.length);
    expect(rows.map((row) => row.name)).toEqual(
      ATTESTATION_CONFIG.dependencies.map((dep) => dep.name),
    );

    for (const row of rows) {
      expect(row.license).toBe(DEPENDENCY_LICENSES[row.name]);
      expect(row.version).toBeTruthy();
    }
  });

  it('downloads the same dependency rows it renders (#101)', async () => {
    const report = await buildReport(ATTESTATION_CONFIG, []);
    const section = renderPrivacyReport(report);

    expect(readDependencyRows(section)).toEqual(
      JSON.parse(serializePrivacyReport(report)).dependencies,
    );
  });

  it('accepts a getter so events logged after mount are included', async () => {
    let events: EgressEvent[] = [];
    const section = createPrivacyReportSection({
      config: ATTESTATION_CONFIG,
      egress: () => events,
    });

    events = [...egress];
    asFake(section.querySelector('.privacy-report-section__generate'))!.click();
    await vi.waitFor(() => {
      expect(asFake(section.querySelector('.privacy-report-section__download'))?.disabled).toBe(
        false,
      );
    });

    const output = asFake(section.querySelector('.privacy-report-section__output'))!;
    const rows = asFake(output.querySelector('dl'))!.children;
    const term = rows.findIndex(
      (cell) => cell.tagName === 'DT' && cell.textContent === 'Egress attempts',
    );
    expect(term).toBeGreaterThanOrEqual(0);
    expect(rows[term + 1]?.textContent).toBe('1');
  });

  it('records the runtime dependencies from the app config', () => {
    expect(ATTESTATION_CONFIG.dependencies.length).toBeGreaterThan(0);
    expect(ATTESTATION_CONFIG.dependencies.map((dep) => dep.name)).toContain('v86');
    for (const dep of ATTESTATION_CONFIG.dependencies) {
      expect(dep.version).toBeTruthy();
    }
  });
});
