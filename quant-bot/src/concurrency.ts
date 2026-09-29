/**
 * Maps `items` through `fn` with at most `limit` calls in flight, returning
 * results in input order. For I/O-bound fan-out — fetching hundreds of
 * markets — where one-at-a-time wastes most of the time waiting on the
 * network and all-at-once gets rate limited.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`concurrency must be an integer >= 1, got ${limit}`);
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
