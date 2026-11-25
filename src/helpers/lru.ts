/** Minimal bounded least-recently-used map */
export class LruCache<K, V> {
  #map = new Map<K, V>();

  constructor(readonly maxSize: number) {
    if (maxSize < 1) throw new Error("LruCache maxSize must be at least 1");
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value === undefined) return undefined;
    // Move to the most recently used position
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.maxSize) {
      const oldest = this.#map.keys().next().value as K;
      this.#map.delete(oldest);
    }
  }

  clear(): void {
    this.#map.clear();
  }
}
