/**
 * Application entry: global styles and the self-hosted font, one WorkerClient (the trace worker
 * starts here; the tune worker is spawned lazily) and the UI mounted on #app. The UI only knows the
 * structural TraceClient contract (src/ui/clientContract.ts); WorkerClient satisfies it.
 */
import '@fontsource-variable/manrope';
import './styles/app.css';
import { mountApp } from './ui/app';
import type { TraceClient } from './ui/clientContract';
import { WorkerClient } from './workers/client';

const client: TraceClient = new WorkerClient();
const unmount = mountApp(document.querySelector<HTMLElement>('#app')!, client, {
  devFixtures: import.meta.env.DEV,
});

// Dev only: a hot update re-runs this module; release the old app and its workers first.
import.meta.hot?.dispose(() => {
  unmount();
  client.terminate();
});
