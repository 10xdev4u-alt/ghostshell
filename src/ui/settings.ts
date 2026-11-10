import type { AgentConfig, EgressEvent, PrivacyReport } from '@/types/index.js';
import { listModels } from '@/core/llm/models.js';
import { readQueryOverrides } from '@/config.js';
import {
  buildReport,
  exportPublicKeyJwk,
  generateAttestationKey,
  signReport,
  type AttestationConfig,
  type AttestationKeyPair,
} from '@/core/security/attestation.js';

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

export interface PrivacyReportSectionOptions {
  /** Hashes and dependency list captured at build time. */
  config: AttestationConfig;
  /** Egress events recorded since the app started. */
  egress: EgressEvent[];
  /** Long-lived keypair; omit to generate a throwaway pair. */
  keyPair?: AttestationKeyPair;
}

/**
 * Build the "Privacy report" section for the settings panel.
 *
 * `App` mounts it with:
 *
 *   const section = createPrivacyReportSection({
 *     config: ATTESTATION_CONFIG,
 *     egress: this.egress.list(),
 *   });
 *   document.getElementById('gs-settings')!.appendChild(section);
 *
 * "Generate report" calls `buildReport`, signs it, renders it with
 * `renderPrivacyReport`, and shows the public key that verifies the
 * signature. "Download report (JSON)" calls `downloadPrivacyReport`.
 */
export function createPrivacyReportSection(options: PrivacyReportSectionOptions): HTMLElement {
  const section = document.createElement('section');
  section.className = 'privacy-report-section';

  const heading = document.createElement('h2');
  heading.textContent = 'Privacy report';
  section.appendChild(heading);

  const description = document.createElement('p');
  description.textContent =
    'Build a signed report of what ran and what (if anything) left this machine.';
  section.appendChild(description);

  const generate = document.createElement('button');
  generate.type = 'button';
  generate.className = 'privacy-report-section__generate';
  generate.textContent = 'Generate report';
  section.appendChild(generate);

  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'privacy-report-section__download';
  download.textContent = 'Download report (JSON)';
  download.disabled = true;
  section.appendChild(download);

  const output = document.createElement('div');
  output.className = 'privacy-report-section__output';
  section.appendChild(output);

  let current: PrivacyReport | null = null;

  generate.addEventListener('click', () => {
    void buildAndRender();
  });

  download.addEventListener('click', () => {
    if (current) downloadPrivacyReport(current);
  });

  async function buildAndRender(): Promise<void> {
    generate.disabled = true;
    output.textContent = 'Building report…';
    try {
      const report = await buildReport(options.config, options.egress);
      const keyPair = options.keyPair ?? (await generateAttestationKey());
      current = { ...report, signature: await signReport(report, keyPair.privateKey) };

      output.replaceChildren();
      renderPrivacyReport(current, output);
      renderVerificationKey(output, await exportPublicKeyJwk(keyPair.publicKey));
      download.disabled = false;
    } catch (error) {
      current = null;
      download.disabled = true;
      output.replaceChildren();
      const message = document.createElement('p');
      message.className = 'privacy-report-section__error';
      message.textContent = `Could not build the privacy report: ${String(error)}`;
      output.appendChild(message);
    } finally {
      generate.disabled = false;
    }
  }

  return section;
}

function renderVerificationKey(container: HTMLElement, jwk: JsonWebKey): void {
  const heading = document.createElement('h3');
  heading.textContent = 'Verification key (JWK)';
  const pre = document.createElement('pre');
  pre.className = 'privacy-report-section__key';
  pre.textContent = JSON.stringify(jwk, null, 2);
  const note = document.createElement('p');
  note.className = 'privacy-report-section__note';
  note.textContent = 'Save this public key with the report: it is what verifies the signature.';
  container.append(heading, pre, note);
}
