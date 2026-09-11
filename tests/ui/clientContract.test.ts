import { describe, expectTypeOf, it } from 'vitest';
import type {
  CompareTarget as WorkerCompareTarget,
  TuneOutput as WorkerTuneOutput,
  WorkerClient,
} from '../../src/workers/client';
import type { CompareTarget, TraceClient, TuneOutput } from '../../src/ui/clientContract';

describe('client contract', () => {
  it('the real WorkerClient satisfies the structural TraceClient the UI consumes', () => {
    // Type-level guard (checked by `npm run typecheck`): breaks if either side drifts.
    expectTypeOf<WorkerClient>().toMatchTypeOf<TraceClient>();
    expectTypeOf<Parameters<WorkerClient['tune']>>().toEqualTypeOf<Parameters<TraceClient['tune']>>();
    expectTypeOf<ReturnType<WorkerClient['compare']>>().toEqualTypeOf<ReturnType<TraceClient['compare']>>();
  });

  it('mirrors the tune output (baseline and tuned summaries) and the compare target exactly', () => {
    expectTypeOf<TuneOutput>().toEqualTypeOf<WorkerTuneOutput>();
    expectTypeOf<ReturnType<WorkerClient['tune']>>().toEqualTypeOf<ReturnType<TraceClient['tune']>>();
    expectTypeOf<CompareTarget>().toEqualTypeOf<WorkerCompareTarget>();
    expectTypeOf<Parameters<WorkerClient['compare']>>().toEqualTypeOf<Parameters<TraceClient['compare']>>();
  });
});
