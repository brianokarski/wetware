/**
 * Read-modify-write helpers must not interleave on one file: the second edit
 * would read the file before the first had written it, and the first edit
 * would be lost. `inTurn` runs tasks for the same file one after another.
 */
const queues = new WeakMap<object, Map<string, Promise<void>>>();

export function inTurn<T>(fs: object, path: string, task: () => Promise<T>): Promise<T> {
  let paths = queues.get(fs);
  if (!paths) queues.set(fs, (paths = new Map()));
  const waiting = paths;

  const result = (waiting.get(path) ?? Promise.resolve()).then(task);
  // The next task runs whether or not this one failed.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  waiting.set(path, tail);
  void tail.then(() => {
    if (waiting.get(path) === tail) waiting.delete(path);
  });
  return result;
}

/**
 * Resolves once everything queued so far for this `fs` has run, whatever
 * came of it. For a reader that must not miss a write asked for a moment
 * before it: a listing of a folder, say, taken as a new file is being made.
 */
export function settled(fs: object): Promise<void> {
  const waiting = queues.get(fs);
  return waiting ? Promise.all([...waiting.values()]).then(() => undefined) : Promise.resolve();
}
