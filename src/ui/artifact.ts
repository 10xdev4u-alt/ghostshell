import DOMPurify from 'dompurify';
import { artifactSrcDoc } from '@/core/security/sandbox.js';

/**
 * Sanitizer used before inlining untrusted HTML artifacts.
 * Injectable so tests can force sanitization in non-DOM environments.
 */
export type Sanitizer = (dirty: string) => string;

/** Escape text for safe inclusion in an HTML document. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render an artifact as an HTML document string.
 *
 * - HTML artifacts are sanitized with DOMPurify (unless a custom sanitizer is
 *   provided), with forms removed so artifacts cannot submit to the app.
 * - Non-HTML artifacts are escaped and shown in a plain `<pre>`.
 */
export function artifactToHtml(
  artifact: { kind: 'html' | 'text'; content: string },
  sanitize: Sanitizer = (dirty) => DOMPurify.sanitize(dirty, { FORBID_TAGS: ['form'] }),
): string {
  if (artifact.kind === 'html') {
    return sanitize(artifact.content);
  }
  return `<!doctype html><html><body style="margin:0;padding:1rem;background:#111827;color:#d1d5db;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(artifact.content)}</body></html>`;
}

/**
 * Build the full sandboxed iframe srcdoc for an artifact.
 * `buildArtifactSrcDoc` already applies the restrictive artifact CSP and
 * `allow-scripts` sandbox tokens.
 */
export function buildArtifactSrcDoc(
  artifact: { kind: 'html' | 'text'; content: string },
  sanitize: Sanitizer = (dirty) => DOMPurify.sanitize(dirty, { FORBID_TAGS: ['form'] }),
): string {
  return artifactSrcDoc(artifactToHtml(artifact, sanitize));
}

/**
 * A panel that renders artifact content in a sandboxed iframe.
 *
 * The iframe uses `sandbox="allow-scripts"` and the artifact CSP from
 * `src/core/security/sandbox.ts` (no `allow-same-origin`, no network
 * directives, `unsafe-inline` allowed because srcdoc content is inlined).
 */
export function createArtifactPanel(
  container: HTMLElement,
  options: { sanitize?: Sanitizer } = {},
) {
  let iframe: HTMLIFrameElement | null = null;

  function show(artifact: { kind: 'html' | 'text'; content: string }) {
    container.style.display = 'flex';
    iframe?.remove();
    iframe = null;
    container.replaceChildren();

    iframe = document.createElement('iframe');
    iframe.className = 'gs-artifact-frame';
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('csp', artifactSrcDoc('').match(/content="([^"]+)"/)?.[1] ?? '');
    iframe.srcdoc = buildArtifactSrcDoc(artifact, options.sanitize);
    container.appendChild(iframe);
  }

  function hide() {
    container.style.display = 'none';
    iframe?.remove();
    iframe = null;
  }

  function dispose() {
    hide();
  }

  return { show, hide, dispose };
}
