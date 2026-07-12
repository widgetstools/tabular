/**
 * Shared FinOS Perspective bootstrap: the WASM engines load once per session
 * (pages remount on every nav), and both Perspective pages get their worker
 * client from here.
 */
import perspective from '@finos/perspective';
import type { Client } from '@finos/perspective';
import perspective_viewer from '@finos/perspective-viewer';
import '@finos/perspective-viewer-datagrid';
import '@finos/perspective-viewer/dist/css/themes.css';
import SERVER_WASM from '@finos/perspective/dist/wasm/perspective-server.wasm?url';
import CLIENT_WASM from '@finos/perspective-viewer/dist/wasm/perspective-viewer.wasm?url';

let clientPromise: Promise<Client> | null = null;

export function ensurePerspective(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      await Promise.all([
        perspective.init_server(fetch(SERVER_WASM)),
        perspective_viewer.init_client(fetch(CLIENT_WASM)),
      ]);
      return perspective.worker();
    })();
  }
  return clientPromise;
}

/** Matches the app's body.light convention (see Theming page). */
export function perspectiveTheme(): string {
  return document.body.classList.contains('light') ? 'Pro' : 'Pro Dark';
}
