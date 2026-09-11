/// <reference lib="webworker" />
/**
 * Trace worker entry: a thin wrapper around createHandler (all the logic lives in handler.ts, which
 * Node tests exercise directly). This is the only module that pulls in the wasm tracers:
 * esm-potrace-wasm patches TextDecoder globally, so it must stay out of the main thread, and
 * vtracer-web's default lookup of `vtracer_bg.wasm` does not exist, so its wasm URL comes from Vite
 * and reaches the adapter's init({ module_or_path }).
 */
import vtracerWasmUrl from 'vtracer-web/vtracer.wasm?url';
import { createPotraceTracer } from '../tracers/potrace';
import { createVtracerTracer } from '../tracers/vtracer';
import { createHandler } from './handler';
import { responseTransferables, type WorkerRequest, type WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const handler = createHandler({
  tracers: { potrace: createPotraceTracer(), vtracer: createVtracerTracer() },
  now: () => performance.now(),
  yieldToEvents: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
});

function post(res: WorkerResponse): void {
  self.postMessage(res, responseTransferables(res));
}

self.onmessage = (ev: MessageEvent<WorkerRequest>): void => {
  const req = ev.data;
  handler.handle(req.type === 'init' ? { ...req, vtracerWasmUrl: req.vtracerWasmUrl ?? vtracerWasmUrl } : req, post);
};
