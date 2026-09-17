/**
 * Recordings the background scan could not read, remembered between runs.
 *
 * The scan skips anything already parsed by asking the saved store, so a file
 * that reads is read once and never again. A file that *fails* leaves nothing
 * behind to ask about, so without this it was tried again on every launch --
 * a folder like the development one costs twenty seconds of parsing on each
 * start to arrive at the same ninety-three failures.
 *
 * ## Why the key is not the path
 *
 * Age of Empires II writes a replay *while the match is being played*, so a
 * recording of a game still in progress is half a file and fails to parse
 * until the game has finished with it. Remembering "this path failed" would
 * hide that match for good.
 *
 * So the key is path, size and mtime together: the moment the game writes
 * another byte the key stops matching, the file is no longer a known failure,
 * and the next scan tries it again. Nothing has to notice the match ended.
 *
 * localStorage rather than IndexedDB: this is a few hundred short strings that
 * cost nothing to lose -- the worst a cleared list can do is spend one more
 * pass finding out what it already knew.
 */
import type { LibraryEntry } from "../electron";
import { PAYLOAD_V } from "./savedStore";

const KEY = "aoe2:unreadable";

/*
 * The list is only true of the parser that wrote it. A parser that has since
 * learned to read a file must not go on hiding it -- that is what happened to
 * ninety-three single-player recordings, which stayed off the list after the
 * fix until somebody thought to press rescan. So the list carries the payload
 * version, and a bump throws it away: the next scan spends one pass finding
 * out what it now knows, which is the cheap half of being wrong.
 */
interface Stored {
  v: number;
  keys: string[];
}

/** Older entries past this are dropped. Roughly a folder's worth. */
const MAX = 600;

/** Changes whenever the file does, which is the whole point -- see above. */
export function failureKey(entry: LibraryEntry): string {
  return `${entry.root}|${entry.id}|${entry.size}|${entry.modified}`;
}

export function readFailures(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as Partial<Stored> | unknown;
    // An array is the shape before this carried a version: written by an
    // older parser, so it says nothing about what this one can read.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Set();
    const stored = parsed as Partial<Stored>;
    if (stored.v !== PAYLOAD_V || !Array.isArray(stored.keys)) return new Set();
    return new Set(stored.keys.filter((k) => typeof k === "string"));
  } catch {
    return new Set(); // half-written, hand-edited, or no storage at all
  }
}

/**
 * Adds one, oldest-first past the cap. Writes the whole list each time, which
 * is a few hundred short strings and happens once per file the parser refuses.
 */
export function rememberFailure(key: string): void {
  try {
    const kept = [...readFailures()].filter((k) => k !== key);
    kept.push(key);
    const stored: Stored = { v: PAYLOAD_V, keys: kept.slice(-MAX) };
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // A full or blocked store costs a re-scan next run, and nothing else.
  }
}

/** For the rescan button, which means "try all of it again". */
export function clearFailures(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Same: it only ever costs work, never correctness.
  }
}
