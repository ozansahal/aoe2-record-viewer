import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LibraryEntry } from "../electron";
import type { Library } from "./useLibrary";
import type { Saved } from "./useSaved";
import { MAX_SCANNED } from "../lib/savedStore";
import { clearFailures, failureKey, readFailures, rememberFailure } from "../lib/scanFailures";
import { scanSource } from "../lib/sources";

/**
 * Reading the recordings folder in the background.
 *
 * A row of that folder is a filename the game invented -- `MP Replay v101...
 * @2026.08.14 194921` -- and says nothing about the game. Everything worth
 * knowing (which map, who played, who won, how long it went) is inside the
 * file, and until now the only way to get it was to open the recording and
 * wait a second for the parse.
 *
 * So the folder is read through on its own, newest first, and each parse is
 * kept exactly as an opened one is. The list fills in as it goes, and by the
 * time a row is worth clicking, clicking it is a read rather than a parse.
 *
 * Electron only, and not because of a policy: a browser has no folder to walk,
 * so the queue is empty there and none of this runs.
 *
 * ## What it costs, and what stops it running away
 *
 * A 10 MB recording is about a second in the parse worker. That is cheap
 * enough to give away in the background and far too expensive to spend on a
 * folder of four thousand, so:
 *
 * - one at a time, in the same worker the app parses in, which is off the
 *   main thread -- the window stays smooth throughout;
 * - never while a recording somebody asked for is being parsed, so an open
 *   waits for at most the file already in flight rather than the queue;
 * - capped at what the store keeps, since scanning past that would only
 *   evict the scan's own earlier work;
 * - stopped for good on the first file the store will not take.
 *
 * Nothing is ever scanned twice: the second run finds every one of them in the
 * store already, spends the read and the fingerprint, and skips the parse.
 *
 * ## Files the parser cannot read
 *
 * Some recordings do not parse at all -- see the `de_string` gap in the README.
 * The scan is the only thing that knows which, so it says so, and the files
 * page drops those rows rather than listing a name that leads nowhere.
 *
 * That memory outlives the run -- see `scanFailures.ts` -- because otherwise
 * every launch spends a pass re-discovering the same refusals. It is keyed by
 * the file's size and mtime as well as its path, so a replay of a match still
 * being played (half a file, and unreadable until the game has finished
 * writing it) stops matching the moment it grows, and is tried again on its
 * own. Rescan forgets the lot.
 */

/** A recording somebody is waiting for is being parsed; hold the queue. */
const BUSY_MS = 150;

export interface Prescan {
  /** A recording is being read right now. */
  active: boolean;
  /**
   * Recordings the parser would not read, by name. The files page hides them:
   * a row that cannot be opened is worse than no row. Cleared by a rescan.
   */
  failed: ReadonlySet<string>;
  /** How far through this pass, and how long it is. Both 0 when idle. */
  done: number;
  total: number;
  /**
   * Stops the pass, and stays stopped -- the folder is re-listed whenever the
   * window is focused, and that must not undo somebody's decision. Pressing
   * rescan is what starts it again.
   */
  stop: () => void;
  /** Take the stop off, for the button that means "do it again". */
  resume: () => void;
}

interface Options {
  library: Library;
  saved: Saved;
  /** True while a recording somebody asked for is being parsed. */
  busy: boolean;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const NONE: ReadonlySet<string> = new Set();

export function usePrescan({ library, saved, busy }: Options): Prescan {
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [failed, setFailed] = useState(NONE);

  /* Read by the loop rather than closed over: it runs for minutes, across any
     number of renders, and has to see the current answer each time round. */
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const sourceRef = useRef(library.source);
  sourceRef.current = library.source;

  /* What previous runs found unreadable, by `failureKey`. Read once: this is
     the authority on what to skip, and `failed` above is only the names the
     page hides -- two different questions about the same files. */
  const refused = useRef<Set<string> | null>(null);
  refused.current ??= readFailures();

  const queue = useRef<LibraryEntry[]>([]);
  /* Every recording this run has decided about, by name -- the same key the
     files page merges the two lists on. Failures go in too: a file that is not
     a recording, or is half-written, must not be retried on every rescan. */
  const seen = useRef(new Set<string>());
  const running = useRef(false);
  const stopped = useRef(false);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setActive(true);
    try {
      for (;;) {
        if (stopped.current) break;
        const entry = queue.current.shift();
        if (!entry) break;

        // Whoever is waiting for a recording goes first.
        while (busyRef.current && !stopped.current) await sleep(BUSY_MS);
        if (stopped.current) break;

        const source = sourceRef.current?.(entry);
        if (!source) break; // the folder went away with the platform
        try {
          const result = await scanSource(source, savedRef.current, entry.modified);
          if (result === "unsaved") {
            /* The store said no -- it is full, or this profile has no storage.
               `useSaved` has already put the reason on the page; carrying on
               would parse the rest of the folder and drop every one of them. */
            stopped.current = true;
            queue.current = [];
            break;
          }
        } catch (err) {
          console.warn(`could not scan ${entry.name}:`, err);
          const key = failureKey(entry);
          refused.current?.add(key);
          rememberFailure(key); // so the next launch does not find this out again
          setFailed((prev) => new Set(prev).add(entry.name));
        }
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    } finally {
      running.current = false;
      setActive(false);
      setProgress({ done: 0, total: 0 });
      queue.current = [];
    }
  }, []);

  /* A fresh listing: queue whatever it holds that is not parsed already. This
     is the only thing that starts a pass, so the scan follows the folder --
     including the re-list Electron does whenever the window is focused, which
     is how the match you just finished gets read without asking. */
  useEffect(() => {
    const entries = library.state?.entries;
    if (!entries?.length || !saved.ready || !library.source || stopped.current) return;

    const known = new Set(saved.entries.map((row) => row.name));
    const candidates = entries.filter((e) => !known.has(e.name) && !seen.current.has(e.name));

    /* Anything a previous run could not read, and which has not changed since,
       is skipped without being parsed -- but still hidden from the list, which
       is why its name goes to `failed` as though this run had just tried it. */
    const fresh: LibraryEntry[] = [];
    const refusedNow: string[] = [];
    for (const entry of candidates) {
      if (refused.current?.has(failureKey(entry))) {
        seen.current.add(entry.name); // decided; do not weigh it again
        refusedNow.push(entry.name);
      } else {
        fresh.push(entry);
      }
    }
    if (refusedNow.length) {
      setFailed((prev) => {
        const next = new Set(prev);
        for (const name of refusedNow) next.add(name);
        return next;
      });
    }
    if (!fresh.length) return;

    /* `entries` is newest first, so this keeps the recent end of the folder --
       which is the end anybody is looking at. Past the cap the store would
       start evicting what this same pass wrote a minute ago. */
    const room = MAX_SCANNED - queue.current.length;
    const take = fresh.slice(0, Math.max(0, room));
    for (const entry of take) seen.current.add(entry.name);
    queue.current.push(...take);
    setProgress((p) => ({ done: p.done, total: p.total + take.length }));
    void pump();
    /* `saved.entries` changes once per file the pass writes, so this runs again
       and again while it is going. That is only a rebuild of `known`: `seen`
       already holds everything queued, so nothing comes out fresh twice. */
  }, [library.state, library.source, saved.ready, saved.entries, pump]);

  const stop = useCallback(() => {
    stopped.current = true;
    queue.current = [];
  }, []);

  /* The rescan button, which means "do all of it again": the stop comes off,
     and so does the memory of what was tried -- including the files that
     failed, and everything already scanned when the saved parses were
     cleared. The store is still asked about each one before it is parsed, so
     forgetting here costs a read and a fingerprint, not a parse. */
  const resume = useCallback(() => {
    stopped.current = false;
    seen.current.clear();
    /* Including what earlier runs gave up on: this is the button that means
       "try all of it again", and it is the only way back for a file the parser
       has since learned to read. */
    refused.current?.clear();
    clearFailures();
    setFailed(NONE); // they are about to be tried again, so they are listed again
  }, []);

  return useMemo(
    () => ({ active, failed, done: progress.done, total: progress.total, stop, resume }),
    [active, failed, progress, stop, resume],
  );
}
