/* global document, window */
import { createTauriSessionDeckHost } from './tauri-host.js';

const MISSING_SHARED_UI_MESSAGE =
  'Session Deck desktop could not load the shared session-deck-ui.js asset.';
const NEXT_STEP_MESSAGE =
  'Rebuild the desktop web assets with `pnpm --filter ./apps/session-deck-desktop sync:web`, then relaunch the app.';

/**
 * @param {{
 *   document?: Document,
 *   host?: ReturnType<typeof createTauriSessionDeckHost>,
 *   sessionDeckUi?: { mount: (options: { host: unknown, document: Document, window: Window & typeof globalThis }) => unknown } | null,
 *   window?: Window & typeof globalThis,
 * }} [options]
 * @returns {{ mode: 'shared-ui' | 'placeholder', host: ReturnType<typeof createTauriSessionDeckHost> }}
 */
export function mountDesktopApp(options = {}) {
  const windowLike = options.window ?? globalThis.window;
  const documentLike = options.document ?? globalThis.document;
  const host = options.host ?? createTauriSessionDeckHost({ window: windowLike });
  const sessionDeckUi =
    options.sessionDeckUi ??
    /** @type {{ SessionDeckUI?: { mount: (options: { host: unknown, document: Document, window: Window & typeof globalThis }) => unknown } | null }} */ (
      windowLike ?? {}
    ).SessionDeckUI ??
    null;

  if (sessionDeckUi && typeof sessionDeckUi.mount === 'function') {
    sessionDeckUi.mount({
      host,
      document: documentLike,
      window: windowLike,
    });
    return { mode: 'shared-ui', host };
  }

  renderPlaceholder(documentLike, host.doctorCommand);
  return { mode: 'placeholder', host };
}

/**
 * @param {Document} documentLike
 * @param {string} doctorCommand
 */
export function renderPlaceholder(documentLike, doctorCommand) {
  const summary = documentLike.getElementById('summary');
  const banner = documentLike.getElementById('banner');
  const list = documentLike.getElementById('list');
  const empty = documentLike.getElementById('empty');
  const diagnosticsPanel = documentLike.getElementById('diagnostics-panel');
  const diagnostics = documentLike.getElementById('diagnostics');

  summary?.replaceChildren(documentLike.createTextNode('Desktop shell ready'));

  if (banner) {
    banner.classList.remove('hidden');
    banner.replaceChildren(documentLike.createTextNode(MISSING_SHARED_UI_MESSAGE));
  }

  list?.replaceChildren();

  if (empty) {
    empty.classList.remove('hidden');
    empty.replaceChildren(documentLike.createTextNode(NEXT_STEP_MESSAGE));
  }

  if (diagnosticsPanel) {
    diagnosticsPanel.classList.remove('hidden');
  }

  if (diagnostics) {
    diagnostics.replaceChildren();
    const firstLine = documentLike.createElement('li');
    firstLine.className = 'diag-line';
    firstLine.textContent = 'Desktop bootstrap could not find the shared Session Deck UI asset.';

    const secondLine = documentLike.createElement('li');
    secondLine.className = 'diag-line';
    secondLine.textContent = doctorCommand;

    diagnostics.append(firstLine, secondLine);
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  mountDesktopApp();
}
