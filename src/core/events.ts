export type EventHandler<E> = (event: E) => void;

export class EventBus<M extends Record<string, unknown>> {
  #handlers = new Map<keyof M, Set<EventHandler<never>>>();

  on<K extends keyof M>(key: K, handler: EventHandler<M[K]>): () => void {
    let set = this.#handlers.get(key);
    if (!set) { set = new Set(); this.#handlers.set(key, set); }
    set.add(handler as EventHandler<never>);
    return () => { set!.delete(handler as EventHandler<never>); };
  }

  emit<K extends keyof M>(key: K, event: M[K]): void {
    const set = this.#handlers.get(key);
    if (!set) return;
    for (const h of set) {
      try { (h as EventHandler<M[K]>)(event); }
      catch (err) { console.error(`[events] handler for "${String(key)}" threw:`, err); }
    }
  }
}
