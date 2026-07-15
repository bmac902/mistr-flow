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
      if (decideVerbStart({ activeVerb }, verb) === "refuse") return false;

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
