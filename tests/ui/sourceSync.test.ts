import { describe, expect, it } from 'vitest';
import { createSourceSync } from '../../src/ui/sourceSync';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('source sync', () => {
  it('is not busy and settles at once without a pending swap', async () => {
    const sync = createSourceSync<string>();
    expect(sync.busy).toBe(false);
    let done = false;
    void sync.settled().then(() => (done = true));
    await flush();
    expect(done).toBe(true);
  });

  it('waiters resume only when every overlapping swap settled; settle is idempotent', async () => {
    const sync = createSourceSync<string>();
    const settleB = sync.begin('B');
    const settleC = sync.begin('C');
    let resumed = 0;
    void sync.settled().then(() => resumed++);
    void sync.settled().then(() => resumed++);

    settleB();
    settleB(); // a second call must not release C's swap
    await flush();
    expect(sync.busy).toBe(true);
    expect(resumed).toBe(0);

    settleC();
    await flush();
    expect(sync.busy).toBe(false);
    expect(resumed).toBe(2);
  });

  it('restores the image on screen only when the failed attempt was the last image sent', () => {
    const sync = createSourceSync<string>();
    sync.begin('A')();

    // B fails (or is superseded by a load that never reached the worker): A goes back, once.
    sync.begin('B')();
    expect(sync.restore('B', 'A')).toBe('A');
    expect(sync.restore('B', 'A')).toBeNull();

    // C was sent after B: B's failure must not overwrite C.
    sync.begin('B');
    sync.begin('C');
    expect(sync.restore('B', 'A')).toBeNull();
    expect(sync.restore('C', 'A')).toBe('A');

    // Nothing on screen yet (first image), or the attempt itself is on screen: nothing to send.
    const first = createSourceSync<string>();
    first.begin('X');
    expect(first.restore('X', null)).toBeNull();
    expect(first.restore('X', 'X')).toBeNull();
  });

  it('dispose releases the waiters', async () => {
    const sync = createSourceSync<string>();
    sync.begin('A');
    let resumed = false;
    void sync.settled().then(() => (resumed = true));
    sync.dispose();
    await flush();
    expect(resumed).toBe(true);
    expect(sync.busy).toBe(false);
  });
});
