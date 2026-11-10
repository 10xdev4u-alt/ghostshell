import '@/ui/styles.css';
import { App } from '@/app.js';
import { APP_VERSION } from '@/config.js';

/**
 * GhostShell entry point.
 *
 * One file, one app. Everything else is inlined by the single-file build.
 */

async function boot(): Promise<void> {
  const version = document.getElementById('gs-version');
  if (version) version.textContent = `v${APP_VERSION}`;

  const app = new App();
  try {
    await app.init();
  } catch (err) {
    console.error('[ghostshell] init failed', err);
    const welcome = document.querySelector('.gs-welcome');
    if (welcome) {
      const p = document.createElement('p');
      p.className = 'gs-hint';
      p.textContent = `Failed to start: ${(err as Error).message}`;
      welcome.appendChild(p);
    }
  }

  globalThis.addEventListener('beforeunload', () => app.dispose());
}

void boot();
