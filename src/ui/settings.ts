import type { AgentConfig, PrivacyReport } from '@/types/index.js';
import { listModels } from '@/core/llm/models.js';
import { readQueryOverrides } from '@/config.js';

/**
 * Settings panel. Binds the model picker, network mode, and agent knobs to the
 * AgentConfig. Emits a change event whenever a value changes.
 */

export interface SettingsHandle {
  get(): AgentConfig;
  onChange(fn: (config: AgentConfig) => void): void;
  dispose(): void;
}

export function createSettings(config: AgentConfig): SettingsHandle {
  const overrides = readQueryOverrides();
  let current: AgentConfig = { ...config, ...overrides };
  const listeners = new Set<(config: AgentConfig) => void>();

  return {
    get: () => current,
    onChange(fn) {
      listeners.add(fn);
    },
    dispose() {
      listeners.clear();
    },
  };
}

export function populateModelSelect(select: HTMLSelectElement): void {
  for (const spec of listModels()) {
    const option = document.createElement('option');
    option.value = spec.id;
    option.textContent = spec.name;
    select.appendChild(option);
  }
}

/** Serialize a privacy report for export. */
export function serializePrivacyReport(report: PrivacyReport): string {
  return JSON.stringify(report, null, 2);
}

function appendRow(list: HTMLElement, term: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  list.appendChild(dt);
  list.appendChild(dd);
}

/** Trigger a browser download of the report as JSON. */
export function downloadPrivacyReport(report: PrivacyReport): void {
  const blob = new Blob([serializePrivacyReport(report)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ghostshell-privacy-report-${report.generatedAt}.json`;
  anchor.textContent = 'Download';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Render a privacy attestation report as plain DOM (no framework) and attach a
 * download button. Pass a container to mount it; the section is always
 * returned so callers can place it themselves.
 */
export function renderPrivacyReport(report: PrivacyReport, container?: HTMLElement): HTMLElement {
  const section = document.createElement('section');
  section.className = 'privacy-report';

  const heading = document.createElement('h2');
  heading.textContent = 'Privacy attestation';
  section.appendChild(heading);

  const summary = document.createElement('dl');
  appendRow(summary, 'HTML sha256', report.htmlSha256);
  appendRow(summary, 'Model sha256', report.modelSha256);
  appendRow(summary, 'VM image sha256', report.vmImageSha256);
  appendRow(summary, 'Dependencies', String(report.dependencies.length));
  appendRow(summary, 'Egress attempts', String(report.egress.length));
  appendRow(summary, 'Generated', new Date(report.generatedAt).toISOString());
  section.appendChild(summary);

  const signature = document.createElement('p');
  signature.className = 'privacy-report__signature';
  signature.textContent = report.signature
    ? `Signature (ECDSA P-256): ${report.signature}`
    : 'Unsigned report — sign it before exporting.';
  section.appendChild(signature);

  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'privacy-report__download';
  download.textContent = 'Download report (JSON)';
  download.addEventListener('click', () => downloadPrivacyReport(report));
  section.appendChild(download);

  if (container) container.appendChild(section);
  return section;
}
