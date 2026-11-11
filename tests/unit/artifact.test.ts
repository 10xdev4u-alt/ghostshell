import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  artifactToHtml,
  buildArtifactSrcDoc,
  createArtifactPanel,
} from '@/ui/artifact.js';
import { FakeElement, installFakeDocument } from './helpers/dom.js';

/** Test sanitizer that removes script elements, standing in for DOMPurify. */
function stripScripts(dirty: string): string {
  return dirty.replace(/<script[\s\S]*?<\/script>/gi, '');
}

describe('artifact panel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('escapes non-HTML artifact content', () => {
    const html = artifactToHtml({ kind: 'text', content: '<script>alert(1)</script>' });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('passes HTML artifacts through the sanitizer', () => {
    const html = artifactToHtml(
      { kind: 'html', content: '<p>hello</p><script>alert(1)</script>' },
      stripScripts,
    );
    expect(html).toContain('<p>hello</p>');
    expect(html).not.toContain('<script>');
  });

  it('wraps the artifact in the strict CSP document', () => {
    const srcdoc = buildArtifactSrcDoc({ kind: 'html', content: '<p>hello</p>' }, (dirty) => dirty);
    expect(srcdoc).toContain('Content-Security-Policy');
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("script-src 'unsafe-inline'");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain('<p>hello</p>');
  });

  it('renders a sandboxed iframe without allow-same-origin', () => {
    installFakeDocument();
    const container = new FakeElement('div');
    const panel = createArtifactPanel(container as unknown as HTMLElement, {
      sanitize: (dirty) => dirty,
    });

    panel.show({ kind: 'html', content: '<p>hello</p>' });

    expect(container.style.display).toBe('flex');
    const iframe = container.children[0] as FakeElement;
    expect(iframe).toBeDefined();
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.srcdoc).toContain('<p>hello</p>');
    expect(iframe.srcdoc).toContain('Content-Security-Policy');
  });

  it('hides and removes the iframe', () => {
    installFakeDocument();
    const container = new FakeElement('div');
    const panel = createArtifactPanel(container as unknown as HTMLElement);

    panel.show({ kind: 'text', content: 'plain' });
    panel.hide();

    expect(container.style.display).toBe('none');
    expect(container.children).toHaveLength(0);
  });

  it('replaces the previous artifact when shown again', () => {
    installFakeDocument();
    const container = new FakeElement('div');
    const panel = createArtifactPanel(container as unknown as HTMLElement);

    panel.show({ kind: 'text', content: 'first' });
    panel.show({ kind: 'text', content: 'second' });

    expect(container.children).toHaveLength(1);
    expect((container.children[0] as FakeElement).srcdoc).toContain('second');
  });
});
