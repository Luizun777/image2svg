/**
 * Keeps the worker's source image in step with the image on screen while a new one is analysed.
 * Pure and DOM-free (generic over the image type).
 *
 * Loading an image posts setSource and then classify; the app only switches `loaded` once both
 * answered. In that window a debounced trace, a measurement or a tune for the image still on
 * screen would reach the worker AFTER the new setSource and run on the new pixels (the worker is
 * FIFO), and its result would be shown for the old image. So every request that depends on the
 * source waits while a swap is pending (`busy` / `settled()`) and re-checks that its image is
 * still the one on screen. A load attempt that does not end on screen (it failed, or a newer
 * attempt that never reached the worker superseded it) puts the displayed image back when its own
 * image is the last one sent (`restore`).
 */
export interface SourceSync<T> {
  /** True while at least one swap has not settled. */
  readonly busy: boolean;
  /** `image` is about to be posted with setSource. Returns this swap's (idempotent) settle function. */
  begin(image: T): () => void;
  /** Resolves once no swap is pending (at once when none is). */
  settled(): Promise<void>;
  /**
   * For an attempt that did not end on screen: the image to post again so the worker matches
   * `shown`, recorded as sent; null when the worker already has something else (a newer attempt
   * sent its own image) or nothing is shown.
   */
  restore(attempt: T, shown: T | null): T | null;
  /** Releases every waiter (unmount); they must re-check their own state. */
  dispose(): void;
}

export function createSourceSync<T>(): SourceSync<T> {
  let last: T | null = null;
  let pending = 0;
  const waiters: Array<() => void> = [];

  const wake = (): void => {
    for (const resolve of waiters.splice(0)) resolve();
  };

  return {
    get busy() {
      return pending > 0;
    },
    begin(image) {
      last = image;
      pending++;
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        pending--;
        if (pending === 0) wake();
      };
    },
    settled() {
      return pending === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve));
    },
    restore(attempt, shown) {
      if (shown === null || shown === attempt || last !== attempt) return null;
      last = shown;
      return shown;
    },
    dispose() {
      pending = 0;
      wake();
    },
  };
}
