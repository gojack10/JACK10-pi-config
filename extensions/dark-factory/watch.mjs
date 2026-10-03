import { watch } from 'node:fs';

// macOS can drop/coalesce filesystem events. Native events provide fast wakes;
// a one-second durable-state recheck prevents a lost wake from stranding a lane.
const watches = new Map();
export function observe(path, listener, onError) {
  let entry = watches.get(path);
  if (!entry) {
    entry = { listeners: new Map(), watcher: undefined, timer: undefined };
    const inspect = () => { for (const fn of [...entry.listeners.keys()]) fn(); };
    entry.watcher = watch(path, inspect);
    entry.timer = setInterval(inspect, 1000);
    entry.watcher.on('error', error => {
      watches.delete(path);
      entry.watcher.close(); clearInterval(entry.timer);
      for (const fail of entry.listeners.values()) fail(error);
    });
    watches.set(path, entry);
  }
  entry.listeners.set(listener, onError);
  entry.watcher.ref(); entry.timer.ref();
  let closed = false;
  return { close() {
    if (closed) return;
    closed = true;
    entry.listeners.delete(listener);
    if (!entry.listeners.size) { entry.watcher.unref(); entry.timer.unref(); }
  } };
}
export function closeIdleWatches() {
  for (const [path, entry] of watches) if (!entry.listeners.size) {
    entry.watcher.close(); clearInterval(entry.timer); watches.delete(path);
  }
}
