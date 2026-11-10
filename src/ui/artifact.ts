import type { Artifact } from '@/types/index.js';
import { artifactSrcDoc, ARTIFACT_SANDBOX } from '@/core/security/sandbox.js';
import DOMPurify from 'dompurify';

/**
 * Artifact panel. Renders HTML/SVG/Markdown artifacts the agent produced in a
 * sandboxed iframe.
 *
 * Security:
 *  - iframe has `sandbox="allow-scripts"` (no same-origin, no forms, no popups)
 *  - CSP blocks all network
 *  - HTML is sanitized with DOMPurify before inlining
 */

export interface ArtifactHandle {
  show(artifact: Artifact): void;
  clear(): void;
  dispose(): void;
}

export function createArtifactPanel(container: HTMLElement): ArtifactHandle {
  const iframe = document.createElement('iframe');
  iframe.className = 'gs-artifact-frame';
  iframe.setAttribute('sandbox', ARTIFACT_SANDBOX);
  iframe.setAttribute('title', 'Rendered artifact');
  container.appendChild(iframe);

  return {
    show(artifact) {
      const sanitized =
        artifact.kind === 'html' ? DOMPurify.sanitize(artifact.content, { FORBID_TAGS: ['form'] }) : artifact.content;
      const srcdoc =
        artifact.kind === 'html' || artifact.kind === 'svg'
          ? artifactSrcDoc(sanitized)
          : `<pre>${sanitized}</pre>`;
      iframe.srcdoc = srcdoc;
    },
    clear() {
      iframe.removeAttribute('srcdoc');
    },
    dispose() {
      iframe.remove();
    },
  };
}
