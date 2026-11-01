/**
 * src/render/loadCap.ts — small helpers for loads that run behind the loading screen (renderer warm-up, main.ts
 * loadSelection): a wait that can never hang the game, and a yield that keeps the page responsive between slices.
 */

/** Wait for `p`, but at most `ms` (the timer is cleared as soon as `p` settles). Never rejects: a failure or a timeout
 *  both resolve to false (true = `p` fulfilled in time). */
export function capped(p: PromiseLike<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/** Give the browser a turn (input, rAF, network callbacks) between slices of main-thread work. */
export function yieldToBrowser(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
