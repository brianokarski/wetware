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

/** What a queued task can ask about its own turn. */
export interface Turn {
  /**
   * False once the task has been given up on. From then on its caller has
   * been told it failed, and later tasks are running: it must start no new
   * write, and must not report what it did as the latest thing known.
   */
  live(): boolean;
}

/**
 * Runs `task` once every task queued before it for the same file has
 * finished. If it takes longer than `limitMs` it is given up on: the caller
 * is told (`FileTimeoutError`) and the queue moves on. A task given up on
 * can't be called back. A write it had already asked the shell for may
 * still land; the shell keeps writes to one file in the order they were
 * asked for, so it lands before any later one and never over it. What the
 * task itself does after that point is for it to hold back: see `Turn`.
 */
export function inTurn<T>(fs: object, path: string, task: (turn: Turn) => Promise<T>, limitMs = FILE_TIME_LIMIT_MS): Promise<T> {
  let paths = queues.get(fs);
  if (!paths) queues.set(fs, (paths = new Map()));
  const waiting = paths;

  const bounded = () =>
    new Promise<T>((resolve, reject) => {
      let live = true;
      const timer = setTimeout(() => {
        live = false;
        reject(new FileTimeoutError(path, limitMs));
      }, limitMs);
      task({ live: () => live }).then(resolve, reject).finally(() => clearTimeout(timer));
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

/**
 * Resolves once nothing is queued for this `fs` and nothing more is being
 * queued by what just finished: a save that writes one file and then
 * another has had both land. For the moment before the app closes.
 */
export async function drained(fs: object): Promise<void> {
  for (;;) {
    await settled(fs);
    // Whatever the tasks that just finished go on to queue is queued by now.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if ((queues.get(fs)?.size ?? 0) === 0) return;
  }
}
