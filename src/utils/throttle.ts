/** In-memory de-dupe: fires at most once per key within a rolling time window. */
export class Throttle {
  private lastFired = new Map<string, number>();

  shouldFire(key: string, windowMs: number): boolean {
    const now = Date.now();
    const last = this.lastFired.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    this.lastFired.set(key, now);
    return true;
  }
}
