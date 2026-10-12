/**
 * Limits how many async tasks run at once. Tasks over the limit wait in FIFO order.
 */
export function createSemaphore(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`Semaphore size must be a positive integer, got ${max}`);
  }

  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < max) {
      active++;
      return;
    }
    await new Promise<void>(resolve => waiting.push(resolve));
  };

  // A finishing task hands its slot straight to the next waiter, so `active` only
  // drops when nobody is queued.
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
