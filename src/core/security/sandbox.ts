/**
 * Sandbox / isolation rules.
 *
 * GhostShell is a single HTML file, so the main risks are:
 *  - XSS from model output or artifact content
 *  - Unexpected network egress
 *  - Artifact scripts escaping their iframe
 *
 * The artifact panel renders in a sandboxed iframe with no `allow-same-origin`
 * and a strict CSP. All user/assistant content is rendered with textContent,
 * never innerHTML (except sanitized artifacts).
 */

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "connect-src 'none'",
].join('; ');

export const ARTIFACT_SANDBOX = 'allow-scripts';

/**
 * Wrap sanitized HTML in the artifact document.
 *
 * Callers must sanitize untrusted HTML before inlining; `src/ui/artifact.ts`
 * does this with DOMPurify before calling here.
 */
export function artifactSrcDoc(html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"></head><body>${html}</body></html>`;
}

export function isSafeOrigin(url: string): boolean {
  try {
    const parsed = new URL(url, globalThis.location?.href);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}
