import { decideVerbStart, type Verb } from "./verbArbiter";

export interface ActiveVerbLock {
  tryStart(verb: Verb): boolean;
  release(verb: Verb): void;
  activeVerb(): Verb | null;
}

export function createActiveVerbLock(): ActiveVerbLock {
  let activeVerb: Verb | null = null;

  return {
    tryStart(verb: Verb): boolean {
      // Strictly "start" — the lock never knows pickerOpen, so it can never
      // see "switch"; the guard is exact so it never could start on one.
      if (decideVerbStart({ activeVerb }, verb) !== "start") return false;

      activeVerb = verb;
      return true;
    },
    release(verb: Verb): void {
      if (activeVerb === verb) activeVerb = null;
    },
    activeVerb(): Verb | null {
      return activeVerb;
    },
  };
}
