/**
 * Read-modify-write helpers must not interleave on one file: the second edit
 * would read the file before the first had written it, and the first edit
 * would be lost. `inTurn` runs tasks for the same file one after another.
 */
const queues = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * How long one queued file operation may take. The shell answers in
 * milliseconds; this is for a call that never comes back at all, which would
 * otherwise hold up every later read and write of that file, and every
 * reading of the folder that waits for them, for good.
 */
export const FILE_TIME_LIMIT_MS = 30_000;

/** A queued file operation that was given up on because the data folder didn't answer in time. */
export class FileTimeoutError extends Error {
  constructor(path: string, limitMs: number) {
    super(`No answer from the data folder for ${path} after ${Math.round(limitMs / 1000)} seconds`);
    this.name = "FileTimeoutError";
  }
}

/**
 * Runs `task` once every task queued before it for the same file has
 * finished. If it takes longer than `limitMs` it is given up on: the caller
 * is told (`FileTimeoutError`) and the queue moves on. A task given up on
 * can't be called back, so if the shell does answer in the end, what it
 * wrote may land after a later write: the limit is long so that this only
 * happens to a call that was never going to return.
 */
export function inTurn<T>(fs: object, path: string, task: () => Promise<T>, limitMs = FILE_TIME_LIMIT_MS): Promise<T> {
  let paths = queues.get(fs);
  if (!paths) queues.set(fs, (paths = new Map()));
  const waiting = paths;

  const bounded = () =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new FileTimeoutError(path, limitMs)), limitMs);
      task().then(resolve, reject).finally(() => clearTimeout(timer));
    });
  const result = (waiting.get(path) ?? Promise.resolve()).then(bounded);
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
