import { useCallback, useEffect, useMemo, useState } from "react";

import type { LibraryEntry, LibraryState } from "../electron";
import { usePlatform } from "../platform/context";
import type { Source } from "../lib/sources";

export interface Library {
  /** False in a plain browser: there is no folder to read there. */
  available: boolean;
  /** Null until the first scan comes back. */
  state: LibraryState | null;
  scanning: boolean;
  refresh: () => Promise<void>;
  /** The folder picker; a cancelled one changes nothing. */
  add: () => Promise<void>;
  /** Takes a folder off the list. Nothing on disk is touched. */
  remove: (dir: string) => Promise<void>;
  /** Null in a browser, so the panel that needs it is never rendered. */
  source: ((entry: LibraryEntry) => Source) | null;
  reveal: (entry: LibraryEntry) => void;
  /**
   * Moves a file to the OS trash and re-lists, so the row goes with it.
   * Rejects rather than swallowing: this is the one call that destroys
   * something, and the page has to be able to say it did not work.
   */
  trash: (entry: LibraryEntry) => Promise<void>;
}

/**
 * The recordings folders, as the renderer sees them.
 *
 * Scans only while `active` -- the panel being open -- since a folder with a
 * few thousand replays is a few thousand stats. There is no cache on either
 * side: coming back to the window re-scans, so the match you just finished is
 * at the top without anyone pressing anything.
 */
export function useLibrary(active: boolean): Library {
  const api = usePlatform().library;
  const [state, setState] = useState<LibraryState | null>(null);
  const [scanning, setScanning] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    setScanning(true);
    try {
      setState(await api.list());
    } catch (err) {
      console.error("could not list recordings:", err);
    } finally {
      setScanning(false);
    }
  }, [api]);

  const add = useCallback(async () => {
    if (!api) return;
    setScanning(true);
    try {
      const added = await api.add();
      if (added) setState(added); // null means the dialog was cancelled
    } catch (err) {
      console.error("could not add folder:", err);
    } finally {
      setScanning(false);
    }
  }, [api]);

  const remove = useCallback(async (dir: string) => {
    if (!api) return;
    setScanning(true);
    try {
      setState(await api.remove(dir));
    } catch (err) {
      console.error("could not remove folder:", err);
    } finally {
      setScanning(false);
    }
  }, [api]);

  const reveal = useCallback((entry: LibraryEntry) => {
    void api?.reveal(entry);
  }, [api]);

  const trash = useCallback(async (entry: LibraryEntry) => {
    if (!api) return;
    await api.trash(entry);
    /* The listing is the only record of what is in the folder, and it has one
       row too many until this comes back. */
    await refresh();
  }, [api, refresh]);

  /* Null rather than a no-op, so a caller can tell there is no folder to read
     from -- and stable, because the loader hangs effects off it. */
  const source = useMemo(
    () => (api ? (entry: LibraryEntry) => api.source(entry) : null),
    [api],
  );

  useEffect(() => {
    if (!api || !active) return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [api, active, refresh]);

  return useMemo(
    () => ({ available: Boolean(api), state, scanning, refresh, add, remove, source, reveal, trash }),
    [api, state, scanning, refresh, add, remove, source, reveal, trash],
  );
}
