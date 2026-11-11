import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_PROGRESS_PHASES, type ModelProgress } from '@/types/index.js';
import { PHASE_LABELS, createModelProgress } from '@/ui/progress.js';
import { FakeElement, findByClass, installFakeDocument } from './helpers/dom.js';

function mount(): { container: FakeElement; handle: ReturnType<typeof createModelProgress> } {
  installFakeDocument();
  const container = new FakeElement('div');
  const handle = createModelProgress(container as unknown as HTMLElement);
  return { container, handle };
}

describe('model progress panel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the phase, bytes, and percent', () => {
    const { container, handle } = mount();
    handle.show({
      phase: 'downloading',
      loaded: 512,
      total: 1024,
      percent: 50,
      message: 'model.onnx',
    });

    const label = findByClass(container, 'gs-model-progress__label');
    const bytes = findByClass(container, 'gs-model-progress__bytes');
    const bar = findByClass(container, 'gs-model-progress__bar');
    const fill = findByClass(container, 'gs-model-progress__fill');

    expect(label?.textContent).toContain('Downloading');
    expect(label?.textContent).toContain('model.onnx');
    expect(bytes?.textContent).toBe('512 B / 1.0 KB');
    expect(fill?.style.width).toBe('50%');
    expect(bar?.classList.contains('is-indeterminate')).toBe(false);
  });

  it('marks an unknown total as indeterminate', () => {
    const { container, handle } = mount();
    handle.update({ phase: 'downloading', loaded: 0, total: 0, percent: null });

    const bar = findByClass(container, 'gs-model-progress__bar');
    const bytes = findByClass(container, 'gs-model-progress__bytes');
    expect(bar?.classList.contains('is-indeterminate')).toBe(true);
    expect(bytes?.textContent).toBe('0 B');
  });

  it('formats generation progress in tokens', () => {
    const { container, handle } = mount();
    handle.update({ phase: 'generating', loaded: 3, total: 12, percent: 25 });

    const label = findByClass(container, 'gs-model-progress__label');
    const bytes = findByClass(container, 'gs-model-progress__bytes');
    expect(label?.textContent).toContain('Generating');
    expect(bytes?.textContent).toBe('3 / 12 tokens');
  });

  it('invokes the cancel handler when the button is clicked', () => {
    const { container, handle } = mount();
    const onCancel = vi.fn();
    handle.onCancel(onCancel);

    const cancel = findByClass(container, 'gs-model-progress__cancel');
    expect(cancel).toBeDefined();
    cancel!.click();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('hides and shows the panel', () => {
    const { container, handle } = mount();
    expect(container.hidden).toBe(true);

    handle.show({ phase: 'loading', loaded: 1, total: 2, percent: 50 });
    expect(container.hidden).toBe(false);

    handle.hide();
    expect(container.hidden).toBe(true);
  });

  it('labels exactly the emitted phases, with no dead entries (#102)', () => {
    const labelled = Object.keys(PHASE_LABELS).sort();
    expect(labelled).toEqual([...MODEL_PROGRESS_PHASES].sort());
    expect(labelled).not.toContain('compiling');
  });

  it('renders the label for every phase in the union (#102)', () => {
    for (const phase of MODEL_PROGRESS_PHASES) {
      const { container, handle } = mount();
      handle.show({ phase, loaded: 0, total: 0, percent: null });
      expect(findByClass(container, 'gs-model-progress__label')?.textContent).toBe(
        PHASE_LABELS[phase],
      );
    }
  });
});
