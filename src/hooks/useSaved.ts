import { useCallback, useEffect, useMemo, useState } from "react";

import type { Payload } from "../types";
import {
  clearSaved,
  deleteSaved,
  hasSaved,
  listSaved,
  readSaved,
  requestPersist,
  savedAvailable,
  saveRecording,
  usage as readUsage,
  type SaveOptions,
  type SavedEntry,
  type Usage,
} from "../lib/savedStore";

export interface Saved {
  /** False where there is no IndexedDB at all. */
  available: boolean;
  /**
   * The first listing has come back, so `entries` is the store rather than the
   * empty array it starts as. The background scan waits for this: starting
   * before it would queue every recording that is already parsed.
   */
  ready: boolean;
  entries: SavedEntry[];
  /** Whatever went wrong last, for the panel to show. Storage is optional. */
  error: string | null;
  usage: Usage;
  /** Null when it is not saved here, or was saved by an older parser. */
  read: (id: string) => Promise<Payload | null>;
  /** Whether it is in there, without counting as having opened it. */
  has: (id: string) => Promise<boolean>;
  remember: (
    id: string,
    name: string,
    payload: Payload,
    options?: SaveOptions,
  ) => Promise<SavedEntry | null>;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
  persist: () => Promise<void>;
}

const NO_USAGE: Usage = { usage: null, quota: null, persisted: false };

/**
 * The saved recordings, as the renderer sees them.
 *
 * Nothing here rejects: a browser that will not give us storage has to leave
 * dropping a recording working, so failures land in `error` and the caller
 * carries on with a null.
 */
export function useSaved(): Saved {
  const [entries, setEntries] = useState<SavedEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage>(NO_USAGE);
  /* Nothing to wait for where there is no store: an empty list is the whole
     truth there, and it is true immediately. */
  const [ready, setReady] = useState(!savedAvailable);

  const refresh = useCallback(async () => {
    if (!savedAvailable) return;
    try {
      setEntries(await listSaved());
      setError(null);
    } catch (err) {
      console.warn("could not list saved recordings:", err);
      setError(`Saved recordings are unavailable: ${(err as Error).message}`);
    }
    setReady(true); // a store that will not answer is still an answer
    setUsage(await readUsage());
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const read = useCallback(async (id: string) => {
    if (!savedAvailable) return null;
    try {
      const payload = await readSaved(id);
      if (payload) void refresh(); // openedAt moved, so the order did too
      return payload;
    } catch (err) {
      console.warn("could not read a saved recording:", err);
      return null; // a miss, not a failure: it gets parsed instead
    }
  }, [refresh]);

  const has = useCallback(async (id: string) => {
    if (!savedAvailable) return false;
    try {
      return await hasSaved(id);
    } catch (err) {
      console.warn("could not check the saved recordings:", err);
      return false; // treat it as a miss: the worst of it is one wasted parse
    }
  }, []);

  const remember = useCallback(async (
    id: string,
    name: string,
    payload: Payload,
    options?: SaveOptions,
  ) => {
    if (!savedAvailable) return null;
    try {
      const entry = await saveRecording(id, name, payload, options);
      setError(null);
      void refresh();
      return entry;
    } catch (err) {
      console.warn("could not save a recording:", err);
      const quota = (err as Error)?.name === "QuotaExceededError";
      setError(quota
        ? `${name} was parsed but not saved: this browser's storage for the app is full. Remove a few saved recordings.`
        : `${name} was parsed but not saved: ${(err as Error).message}`);
      return null;
    }
  }, [refresh]);

  const wrap = useCallback(async (work: () => Promise<void>, what: string) => {
    try {
      await work();
      setError(null);
    } catch (err) {
      console.warn(`could not ${what}:`, err);
      setError(`Could not ${what}: ${(err as Error).message}`);
    }
    void refresh();
  }, [refresh]);

  const remove = useCallback(
    (id: string) => wrap(() => deleteSaved(id), "remove that recording"),
    [wrap],
  );
  const clear = useCallback(
    () => wrap(() => clearSaved(), "clear the saved recordings"),
    [wrap],
  );

  const persist = useCallback(async () => {
    await requestPersist();
    setUsage(await readUsage()); // granted or refused, show what it is now
  }, []);

  return useMemo(
    () => ({
      available: savedAvailable, ready, entries, error, usage,
      read, has, remember, remove, clear, persist,
    }),
    [ready, entries, error, usage, read, has, remember, remove, clear, persist],
  );
}
