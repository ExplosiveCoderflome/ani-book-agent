import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

const queues = new Map<string, Promise<void>>();
const ownership = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

// ponytail: one server process owns the workspace; multiple server processes need a filesystem lock.
export async function withNovelLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(directory);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const inherited = ownership.getStore();
  if (inherited?.get(key)?.active) return operation();

  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  queues.set(key, tail);
  await previous;
  const lease = { active: true };
  try {
    return await ownership.run(new Map([...inherited ?? [], [key, lease]]), operation);
  } finally {
    lease.active = false;
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
