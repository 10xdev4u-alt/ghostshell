import type { ModelProgress, ModelProgressPhase } from '@/types/index.js';

/**
 * Model progress panel.
 *
 * Shows the current phase, a determinate or indeterminate bar, and a byte or
 * token count, plus a Cancel button wired to the caller's abort path. Built
 * with `createElement`/`textContent` only, like the other panels, so it is
 * safe against model-controlled strings and constructible in tests with the
 * minimal DOM stub.
 */

export interface ModelProgressHandle {
  /** Show the panel, optionally rendering an initial progress value. */
  show(progress?: ModelProgress): void;
  /** Render a progress update and make the panel visible. */
  update(progress: ModelProgress): void;
  /** Hide the panel without destroying it. */
  hide(): void;
  /** Register the cancel handler (called on button click). */
  onCancel(fn: () => void): void;
  /** Remove listeners and clear the panel. */
  dispose(): void;
}

export const PHASE_LABELS: Record<ModelProgressPhase, string> = {
  downloading: 'Downloading',
  loading: 'Loading',
  generating: 'Generating',
};

export function createModelProgress(container: HTMLElement): ModelProgressHandle {
  container.className = 'gs-model-progress';
  container.hidden = true;

  const label = document.createElement('span');
  label.className = 'gs-model-progress__label';

  const bar = document.createElement('div');
  bar.className = 'gs-model-progress__bar';
  const fill = document.createElement('div');
  fill.className = 'gs-model-progress__fill';
  bar.appendChild(fill);

  const bytes = document.createElement('span');
  bytes.className = 'gs-model-progress__bytes';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'gs-model-progress__cancel';
  cancel.textContent = 'Cancel';

  container.append(label, bar, bytes, cancel);

  let cancelHandler: (() => void) | null = null;
  const onCancelClick = (): void => cancelHandler?.();
  cancel.addEventListener('click', onCancelClick);

  const render = (progress: ModelProgress): void => {
    const phase = PHASE_LABELS[progress.phase];
    label.textContent = progress.message ? `${phase}: ${progress.message}` : phase;

    if (progress.percent === null) {
      bar.classList.add('is-indeterminate');
      fill.style.width = '';
    } else {
      bar.classList.remove('is-indeterminate');
      fill.style.width = `${progress.percent}%`;
    }

    bytes.textContent = formatProgress(progress);
  };

  return {
    show(progress) {
      container.hidden = false;
      if (progress) render(progress);
    },

    update(progress) {
      container.hidden = false;
      render(progress);
    },

    hide() {
      container.hidden = true;
    },

    onCancel(fn) {
      cancelHandler = fn;
    },

    dispose() {
      cancel.removeEventListener('click', onCancelClick);
      cancelHandler = null;
      container.replaceChildren();
    },
  };
}

function formatProgress(progress: ModelProgress): string {
  if (progress.phase === 'generating') {
    return `${progress.loaded} / ${progress.total} tokens`;
  }
  if (progress.total > 0) {
    return `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`;
  }
  return formatBytes(progress.loaded);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}
