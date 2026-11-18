/**
 * When text being typed is saved. One policy for every place the app saves
 * as you write: a day's notes, and the morning pages.
 *
 * A save runs a moment after typing stops. Typing that never stops is not
 * allowed to put it off for ever: a save also runs once the oldest unsaved
 * keystroke has waited `maxWaitMs`. And `flush` saves at once, for when the
 * text is about to be left: the field loses focus, the window is hidden or
 * closed, the screen changes.
 */
export interface SavePolicy {
  /** How long after the last keystroke a save runs. */
  idleMs: number;
  /** The longest a keystroke waits to be saved, however long the typing goes on. */
  maxWaitMs: number;
}

export const SAVE_POLICY: SavePolicy = { idleMs: 800, maxWaitMs: 3000 };

export interface Autosave {
  /** Call on every change to the text. */
  touched(): void;
  /** Save now, if anything is waiting to be. */
  flush(): void;
  /** Forget what is waiting, without saving it. */
  cancel(): void;
  /** Whether a change is waiting to be saved. */
  waiting(): boolean;
}

type Timer = ReturnType<typeof setTimeout>;

/** Schedules calls to `save` under a policy. `save` is expected to do nothing if there is nothing new. */
export function autosave(save: () => void, policy: SavePolicy = SAVE_POLICY): Autosave {
  let idle: Timer | undefined;
  let cap: Timer | undefined;
  const cancel = () => {
    clearTimeout(idle);
    clearTimeout(cap);
    idle = cap = undefined;
  };
  const fire = () => {
    cancel();
    save();
  };
  return {
    touched() {
      clearTimeout(idle);
      idle = setTimeout(fire, policy.idleMs);
      cap ??= setTimeout(fire, policy.maxWaitMs);
    },
    flush() {
      if (cap !== undefined) fire();
    },
    cancel,
    waiting: () => cap !== undefined,
  };
}
