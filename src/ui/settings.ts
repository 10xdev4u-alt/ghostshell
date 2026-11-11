import type { AgentConfig, EgressEvent, PrivacyReport } from '@/types/index.js';
import { listModels } from '@/core/llm/models.js';
import { isNetworkMode, readQueryOverrides } from '@/config.js';
import {
  buildReport,
  exportPublicKeyJwk,
  generateAttestationKey,
  signReport,
  type AttestationConfig,
  type AttestationKeyPair,
} from '@/core/security/attestation.js';

/**
 * Settings panel. Binds the model picker and network mode to the AgentConfig,
 * persists changes to the settings store, and emits a change event whenever a
 * value changes.
 */

/** IndexedDB key for the persisted AgentConfig (src/core/persistence/db.ts). */
export const SETTINGS_KEY = 'agent-config';

/** The slice of `Database` the settings panel persists through. */
export interface SettingsStore {
  setSetting(key: string, value: unknown): Promise<void>;
}

/** Explicit selects, for tests and for hosts that mount the panel elsewhere. */
export interface SettingsElements {
  modelSelect?: HTMLSelectElement | null | undefined;
  networkSelect?: HTMLSelectElement | null | undefined;
}

export interface CreateSettingsOptions {
  /** Base config: defaults merged with persisted values and query overrides. */
  config: AgentConfig;
  /** Persistence backend. Omit to keep changes in memory only. */
  db?: SettingsStore | undefined;
  /** Select elements. Defaults to `#gs-model-select` / `#gs-network-select`. */
  elements?: SettingsElements | undefined;
}

export interface SettingsHandle {
  get(): AgentConfig;
  onChange(fn: (config: AgentConfig) => void): void;
  dispose(): void;
}

/**
 * Merge persisted settings over defaults, then apply query overrides.
 *
 * Enum fields are validated so a corrupt or stale value in IndexedDB cannot
 * leave the app in a state the UI cannot represent.
 */
export function resolveSettingsConfig(
  base: AgentConfig,
  persisted: Partial<AgentConfig> | undefined,
): AgentConfig {
  const merged: AgentConfig = { ...base, ...persisted };
  if (!isNetworkMode(merged.networkMode)) merged.networkMode = base.networkMode;
  if (!listModels().some((spec) => spec.id === merged.modelId)) {
    merged.modelId = base.modelId;
  }
  return { ...merged, ...readQueryOverrides() };
}

function defaultElements(): SettingsElements {
  if (typeof document === 'undefined') return {};
  return {
    modelSelect:
      (document.getElementById('gs-model-select') as HTMLSelectElement | null) ?? undefined,
    networkSelect:
      (document.getElementById('gs-network-select') as HTMLSelectElement | null) ?? undefined,
  };
}

export function createSettings(options: CreateSettingsOptions): SettingsHandle {
  const overrides = readQueryOverrides();
  let current: AgentConfig = { ...options.config, ...overrides };
  const listeners = new Set<(config: AgentConfig) => void>();
  const elements: SettingsElements = { ...defaultElements(), ...options.elements };
  const modelSelect = elements.modelSelect ?? null;
  const networkSelect = elements.networkSelect ?? null;
  const disposers: Array<() => void> = [];

  const emit = (): void => {
    for (const fn of listeners) fn({ ...current });
  };

  const persist = (): void => {
    if (!options.db) return;
    void Promise.resolve(options.db.setSetting(SETTINGS_KEY, { ...current })).catch((error) => {
      console.error('[ghostshell] could not persist settings', error);
    });
  };

  const update = (next: AgentConfig): void => {
    current = next;
    persist();
    emit();
  };

  if (modelSelect) {
    populateModelSelect(modelSelect);
    modelSelect.value = current.modelId;
    const onChange = (): void => {
      const modelId = modelSelect.value;
      if (modelId && modelId !== current.modelId) update({ ...current, modelId });
    };
    modelSelect.addEventListener('change', onChange);
    disposers.push(() => modelSelect.removeEventListener('change', onChange));
  }

  if (networkSelect) {
    networkSelect.value = current.networkMode;
    const onChange = (): void => {
      const mode = networkSelect.value;
      if (isNetworkMode(mode) && mode !== current.networkMode) {
        update({ ...current, networkMode: mode });
      }
    };
    networkSelect.addEventListener('change', onChange);
    disposers.push(() => networkSelect.removeEventListener('change', onChange));
  }

  return {
    get: () => ({ ...current }),
    onChange(fn) {
      listeners.add(fn);
    },
    dispose() {
      listeners.clear();
      for (const dispose of disposers) dispose();
      disposers.length = 0;
    },
  };
}

export function populateModelSelect(select: HTMLSelectElement): void {
  // The release HTML ships placeholder options; replace them so the registry
  // is the single source of truth.
  select.replaceChildren();
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
  // Revoke well after the click: revoking on the next tick can cancel the
  // download before the browser has consumed the blob in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
  /**
   * Egress events recorded since the app started. Pass a getter so the
   * report includes events logged after the section was mounted.
   */
  egress: EgressEvent[] | (() => EgressEvent[]);
  /** Long-lived keypair; omit to generate a throwaway pair. */
  keyPair?: AttestationKeyPair;
}

/**
 * Build the "Privacy report" section for the settings panel.
 *
 * `App.init` mounts it with:
 *
 *   const mount = document.getElementById('gs-privacy-report');
 *   mount?.appendChild(createPrivacyReportSection({
 *     config: ATTESTATION_CONFIG,
 *     egress: () => this.egress.list(),
 *   }));
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
      const egressEvents =
        typeof options.egress === 'function' ? options.egress() : options.egress;
      const report = await buildReport(options.config, egressEvents);
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
