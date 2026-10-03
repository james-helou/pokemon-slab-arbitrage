import type { Log } from './log.js';

/**
 * Runs `task` on a timer, re-reading `intervalMs()` before each tick. A tick that fires while the previous
 * run is still in flight is skipped, so runs never overlap. Errors are logged (message only) and never stop the loop.
 */
export function every(intervalMs: () => Promise<number>, task: () => Promise<void>, log: Log, name: string): () => void {
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    let ms = 60_000;
    try {
      ms = await intervalMs();
    } catch (err) {
      log('warn', `${name} interval lookup failed`, { err: err instanceof Error ? err.message : String(err) });
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    if (running) {
      log('warn', `${name} tick skipped: previous run still in progress`);
      return;
    }
    running = true;
    try {
      await task();
    } catch (err) {
      log('error', `${name} failed`, { err: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
