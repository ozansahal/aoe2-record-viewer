import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LibraryEntry } from "./electron";
import type { Library } from "./hooks/useLibrary";
import type { Saved } from "./hooks/useSaved";
import type { Loaded } from "./lib/loadPayload";
import type { SavedEntry } from "./lib/savedStore";
import { fromFile, openSource, type Source } from "./lib/sources";
import { DECAY_SECS } from "./lib/view";
import { usePlatform } from "./platform/context";
import type { Mode, Payload, SortBy } from "./types";

/**
 * The open recordings, and how a file becomes one.
 *
 * Five ways in -- a drop, the picker, a row of the recordings folder, a row of
 * the saved list, a file opened from outside -- and one road afterwards, so
 * "parse it", "save it" and "say what went wrong" are answered once rather
 * than once per entry point.
 *
 * Every recording that lands opens a tab. A five-file drop was always parsed
 * and saved in full and then showed one of them; now there is somewhere to put
 * the other four. Only the first takes the screen.
 *
 * What it deliberately does not do is decide what the app looks like. Opening
 * from a panel resolves true or false and the caller closes the panel, or does
 * not.
 */

/** Where the open tabs are remembered between runs. */
const TABS_KEY = "aoe2:tabs";
/** The playhead moves on every drag frame; the write waits for it to settle. */
const PERSIST_MS = 500;

export interface Tab {
  /** The content fingerprint when the recording is saved, else a local id. */
  id: string;
  /** The file it came from. What the tab is labelled with. */
  name: string;
  payload: Payload;
  /** Its key in the saved store, when it is kept there. */
  savedId: string | null;
  /** The recordings-folder entry it came from, if any. */
  entryId: string | null;
  /* The view state, per tab, so coming back lands where you left rather than
     at the end of a match you were already partway through. */
  t: number;
  mode: Mode;
  sortBy: SortBy;
  /** Window half-width in seconds. */
  w: number;
}

/** What survives a restart. The payload itself is read back from the store. */
type StoredTab = Pick<Tab, "id" | "name" | "savedId" | "t" | "mode" | "sortBy" | "w">;

interface Stored {
  tabs: StoredTab[];
  activeId: string | null;
}

/** The part of a tab the view is allowed to change. */
export type TabView = Partial<Pick<Tab, "t" | "mode" | "sortBy" | "w">>;

interface LoadOptions {
  entryId?: string | null;
  status?: string;
  /** False for the rest of a batch: open a tab, but leave the screen be. */
  activate?: boolean;
}

export interface RecordingTabs {
  tabs: Tab[];
  active: Tab | null;
  status: string;
  error: boolean;
  busy: boolean;
  select: (id: string) => void;
  close: (id: string) => void;
  /** Patches the active tab's view state. */
  patch: (view: TabView) => void;
  /* Each resolves false when nothing was opened -- a failed parse, or a
     cancelled dialog -- so the files page can stay put and show why. */
  openPicked: () => Promise<boolean>;
  openFiles: (files: File[]) => Promise<boolean>;
  openFromLibrary: (entry: LibraryEntry) => Promise<boolean>;
  openSaved: (entry: SavedEntry) => Promise<boolean>;
  /** Throw the kept parse away and read the file again -- see below. */
  reparse: (entry: LibraryEntry, savedId: string) => Promise<boolean>;
}

interface Options {
  saved: Saved;
  library: Library;
}

// The end of the match, which is the whole of it: everything that happened is
// behind the scrubber, so a tab opens on the finished game rather than on a
// half of it. Dragging back is how you get to the middle; there is no drag
// that gets you to the end you were not shown.
const start = (payload: Payload) => payload.duration;

function readStored(): Stored | null {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    return Array.isArray(parsed?.tabs) ? parsed : null;
  } catch {
    return null; // a half-written or hand-edited entry is not worth failing over
  }
}

export function useRecordingTabs({ saved, library }: Options): RecordingTabs {
  const platform = usePlatform();

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Only for recordings the store would not take; everything else is keyed
   *  by its fingerprint, so the same file twice is the same tab. */
  const locals = useRef(0);

  const active = useMemo(
    () => tabs.find((tab) => tab.id === activeId) ?? null,
    [tabs, activeId],
  );

  const open = useCallback((name: string, loaded: Loaded, entryId: string | null, activate: boolean) => {
    const id = loaded.savedId ?? `local:${++locals.current}`;
    setTabs((prev) => {
      // Already open: the tab is the recording, so there is only ever one.
      if (prev.some((tab) => tab.id === id)) return prev;
      return [...prev, {
        id,
        name,
        payload: loaded.payload,
        savedId: loaded.savedId ?? null,
        entryId,
        t: start(loaded.payload),
        mode: "decay",
        sortBy: "time",
        w: DECAY_SECS,
      }];
    });
    if (activate) setActiveId(id);
    console.log(loaded.note);
  }, []);

  const fail = useCallback((message: string) => {
    setStatus(message);
    setError(true);
  }, []);

  /** Resolves null on success, else the message to report. */
  const load = useCallback(async (
    name: string,
    read: () => Promise<Loaded>,
    { entryId = null, status: line, activate = true }: LoadOptions = {},
  ): Promise<string | null> => {
    setBusy(true);
    setError(false);
    setStatus(line ?? `Parsing ${name} — this takes a moment...`);
    try {
      open(name, await read(), entryId, activate);
      setStatus("");
      return null;
    } catch (err) {
      console.error(err);
      return `${name}: ${(err as Error).message}`;
    } finally {
      setBusy(false);
    }
  }, [open]);

  /**
   * A whole drop, or a whole pick. Every file opens a tab and the first one
   * takes the screen, so a five-file drop is one redraw and five tabs.
   * Resolves false if anything failed.
   */
  const loadAll = useCallback(async (
    sources: Source[],
    /* The folder row this came off, when it did. Only a listing knows the
       file's mtime and which folder it sits in, and both go on the saved row
       afterwards -- see `modified` and `root` on `SavedEntry`. */
    entry: LibraryEntry | null = null,
  ): Promise<boolean> => {
    const entryId = entry?.id ?? null;
    if (!sources.length) return false;
    const failures: string[] = [];
    let shown = false;
    for (const [i, source] of sources.entries()) {
      const of = sources.length > 1 ? ` (${i + 1} of ${sources.length})` : "";
      /* Only `openFromLibrary` has an entry id, so its absence is exactly
         "this did not come off a row of the recordings folder" -- which is
         what the list tags as loaded. */
      const message = await load(source.name, () => openSource(source, saved, {
        loaded: !entry,
        modified: entry?.modified,
        root: entry?.root,
      }), {
        entryId,
        status: `Parsing ${source.name}${of} — this takes a moment...`,
        activate: !shown,
      });
      if (message) failures.push(message);
      else shown = true;
    }
    if (failures.length) fail(`Could not load ${failures.join("; ")}`);
    else setStatus("");
    return !failures.length;
  }, [load, saved, fail]);

  const openFiles = useCallback(
    (files: File[]) => loadAll(files.map(fromFile)),
    [loadAll],
  );

  const openPicked = useCallback(async () => {
    const picked = await platform.pickRecordings();
    return picked ? loadAll(picked) : false; // false: the dialog was cancelled
  }, [platform, loadAll]);

  const openFromLibrary = useCallback(async (entry: LibraryEntry) => {
    if (!library.source) return false;
    return loadAll([library.source(entry)], entry);
  }, [loadAll, library]);

  /* One row of the saved list: nothing is read off disk and nothing is parsed. */
  const openSaved = useCallback(async (entry: SavedEntry) => {
    const message = await load(entry.name, async () => {
      const found = await saved.read(entry.id);
      if (!found) throw new Error("it is not saved any more — open the file again");
      return { payload: found, note: `${entry.name} — from saved recordings`, savedId: entry.id };
    }, { status: `Opening ${entry.name}...` });
    if (message) fail(`Could not open ${message}`);
    return message === null;
  }, [load, saved, fail]);

  const select = useCallback((id: string) => setActiveId(id), []);

  const close = useCallback((id: string) => {
    setTabs((prev) => {
      const at = prev.findIndex((tab) => tab.id === id);
      if (at < 0) return prev;
      const left = prev.filter((tab) => tab.id !== id);
      /* Closing the tab you are looking at lands on its neighbour, the way an
         editor does -- the one to the right, or the last one if there is none. */
      setActiveId((current) => {
        if (current !== id) return current;
        return left[at]?.id ?? left[at - 1]?.id ?? null;
      });
      return left;
    });
  }, []);

  /**
   * Read a recording again from scratch.
   *
   * `openSource` prefers the kept parse, which is the whole point of keeping
   * it -- and exactly wrong once the parser has changed underneath it. So the
   * parse goes first, and then the same road as any other open. The tab has to
   * close too: it holds the stale payload in memory, and `open` treats a
   * fingerprint that is already on screen as nothing to do.
   *
   * Only offered where the file is still in the folder. A row that is nothing
   * but a saved parse has no bytes left to read.
   */
  const reparse = useCallback(async (entry: LibraryEntry, savedId: string) => {
    close(savedId);
    await saved.remove(savedId);
    return openFromLibrary(entry);
  }, [close, saved, openFromLibrary]);

  const patch = useCallback((view: TabView) => {
    setTabs((prev) => prev.map((tab) => (tab.id === activeId ? { ...tab, ...view } : tab)));
  }, [activeId]);

  /* A file association, a command-line argument, or macOS's open-file event.
     In a browser nothing arrives this way and this subscribes to nothing. */
  useEffect(
    () => platform.onExternalOpen((source) => void loadAll([source])),
    [platform, loadAll],
  );

  /* What was open last time, reopened from the store -- no re-parse, since the
     payload is already there. A tab whose payload has since been evicted, or
     was written by an older parser, is simply dropped. */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !saved.available) return;
    restored.current = true;
    const stored = readStored();
    if (!stored?.tabs.length) return;

    void (async () => {
      const found: Tab[] = [];
      for (const it of stored.tabs) {
        if (!it.savedId) continue; // never saved, so there is nothing to read
        const payload = await saved.read(it.savedId);
        if (payload) found.push({ ...it, payload, entryId: null });
      }
      if (!found.length) return;
      /* Anything opened while the store was being read wins: the person is
         already looking at it. */
      setTabs((prev) => [...found.filter((f) => !prev.some((p) => p.id === f.id)), ...prev]);
      setActiveId((current) => current
        ?? (found.some((f) => f.id === stored.activeId) ? stored.activeId : found[0].id));
    })();
  }, [saved]);

  /* Remembered on a delay, because the playhead writes on every drag frame. */
  useEffect(() => {
    if (!restored.current) return; // do not blank the store before it is read
    const timer = setTimeout(() => {
      const stored: Stored = {
        tabs: tabs.map(({ id, name, savedId, t, mode, sortBy, w }) =>
          ({ id, name, savedId, t, mode, sortBy, w })),
        activeId,
      };
      try {
        localStorage.setItem(TABS_KEY, JSON.stringify(stored));
      } catch {
        // A full or blocked store is not a reason to stop working.
      }
    }, PERSIST_MS);
    return () => clearTimeout(timer);
  }, [tabs, activeId]);

  /* Stable, because callers subscribe window events to these -- a fresh object
     every render would tear the drop listener down and put it back each time. */
  return useMemo(() => ({
    tabs, active, status, error, busy,
    select, close, patch,
    openPicked, openFiles, openFromLibrary, openSaved, reparse,
  }), [
    tabs, active, status, error, busy,
    select, close, patch,
    openPicked, openFiles, openFromLibrary, openSaved, reparse,
  ]);
}
