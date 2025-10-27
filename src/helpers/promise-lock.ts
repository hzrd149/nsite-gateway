/**
 * Creates a promise lock wrapper for async functions
 * Prevents duplicate concurrent calls with the same key
 *
 * @param fn - The async function to wrap
 * @param getKey - Function that generates a unique key from the arguments
 * @returns Wrapped function that deduplicates concurrent calls
 *
 * @example
 * ```ts
 * const loadData = createPromiseLock(
 *   async (id: string, type: string) => fetchFromAPI(id, type),
 *   (id, type) => `${id}:${type}`
 * );
 * ```
 */
export function createPromiseLock<Args extends any[], Result>(
  fn: (...args: Args) => Promise<Result>,
  getKey: (...args: Args) => string,
): (...args: Args) => Promise<Result> {
  const locks = new Map<string, Promise<Result>>();

  return async (...args: Args): Promise<Result> => {
    const key = getKey(...args);

    // Return existing promise if already loading
    const existingPromise = locks.get(key);
    if (existingPromise) {
      return existingPromise;
    }

    // Create new promise with cleanup
    const promise = (async () => {
      try {
        return await fn(...args);
      } finally {
        locks.delete(key);
      }
    })();

    locks.set(key, promise);
    return promise;
  };
}
