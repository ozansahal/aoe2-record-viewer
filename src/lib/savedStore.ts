/**
 * Recordings kept in the browser.
 *
 * What is kept is the *parse*, not the file. A 10 MB recording turns into a
 * ~95 KB payload, so a hundred matches cost about ten megabytes and re-opening
 * one is a read instead of a second of parsing.
 *
 * IndexedDB rather than localStorage: localStorage caps at ~5 MB and only holds
 * strings, while IndexedDB is handed a share of the disk (Chromium lets one
 * origin use 60% of what is free, Firefox 10%, WebKit around a gigabyte) and
 * stores the payload as an object. `usage()` reports where a profile actually
 * sits.
 *
 * Every function here can throw -- a private window, blocked storage, a full
 * disk -- and `useSaved` is what catches. Loading a recording must not depend
 * on saving one working.
 */
import type { Payload } from "../types";

/* Deliberately still the app's old name. This is the key an existing library
   is stored under, not a label anyone sees: renaming it would not migrate the
   database, it would silently open an empty one and leave every kept parse
   behind. */
const DB_NAME = "aoe2-event-explorer";
const DB_VERSION = 1;
/** Listing rows. Small, so the panel can read every one of them. */
const META = "meta";
/** Payloads, keyed by the same id. Read one at a time, never for the list. */
const PAYLOADS = "payloads";

/**
 * Bump when a parser fix changes what a payload contains, or when the listing
 * row above gains a field the page draws. Older rows stop being listed and are
 * cleared on the next write, so a stale parse is never shown -- re-open the
 * recording and it is parsed again.
 *
 * That retires every saved parse at once, which is the blunt instrument. The
 * files page has the other two: "Re-parse" on a single row, and "Clear saved"
 * for the lot, neither of which needs a release.
 */
export const PAYLOAD_V = 14;

/** What the parser reports as the profile id of an AI seat: 0xFFFFFFFF. */
export const AI_PROFILE = 4294967295;

/** Oldest by last-opened past this are dropped. ~100 payloads is ~10 MB. */
export const MAX_SAVED = 100;

/**
 * The same, for parses nobody asked for -- the background scan of the
 * recordings folder. They are kept apart from the opened ones and dropped
 * first, so a folder full of replays cannot push out the match you were
 * looking at yesterday.
 */
export const MAX_SCANNED = 250;

/** One row of the saved list. Everything here is cheap to read in bulk. */
export interface SavedEntry {
  /** Content fingerprint, so the same recording twice is one row. */
  id: string;
  v: number;
  name: string;
  /** Epoch ms, first import. */
  savedAt: number;
  /** Epoch ms, last opened. Ordering and eviction both read this. */
  openedAt: number;
  /**
   * Epoch ms, the recording file's own last-edit time, when the folder listing
   * knew it. That is when the game finished writing the replay -- which is the
   * honest answer to "when was this game", and the only date here that is
   * about the match rather than about this app. See `playedAt` in lib/summary.ts.
   *
   * Optional like `scanned` and `loaded` below: absent on every row written
   * before this existed, and on anything that came in as bare bytes -- a drop,
   * or a file the system handed us -- where there is no listing to read an
   * mtime off. Those fall back to the timestamp in the filename.
   */
  modified?: number;
  map: string;
  /**
   * The map is a scenario, so `map` above is a scenario's filename -- a
   * campaign mission or an Art of War challenge. The list keeps those out of
   * the way: a folder collects a dozen attempts at one mission, and they
   * crowd out the matches either side of them.
   */
  scenario: boolean;
  duration: number;
  /** As the recording states it -- "Hard", "Standard". Listed beside the map. */
  difficulty: string;
  players: {
    name: string;
    civilization: string;
    color: string;
    winner: boolean;
    /**
     * The DE profile id -- see `Player.profile_id`. It is what "is this
     * player me" is answered by: a name is whatever the lobby showed that
     * game, and can be changed between two of them. Absent on an AI seat's
     * sentinel value and on a payload exported before it was carried.
     */
    profileId?: number;
  }[];
  /**
   * How many of them were at a keyboard. Two or more is a multiplayer game,
   * which is the one thing about a row you cannot read off the rest of it --
   * the players line looks the same whether the other side was a person or
   * the hardest AI. Derived rather than stored by the parser: `is_ai` is per
   * player, and the list only keeps what it draws.
   */
  humans: number;
  /**
   * Which of `players` above is you -- an index into that array, so the row
   * can crown a game you won without carrying a second copy of the name.
   *
   * "You" is the player whose client wrote the recording, which the file
   * states and nothing else here does: a name is whatever the lobby handed
   * out, and the winner is a side rather than a person. Absent when the
   * recording names no owner, and on every row an older parser wrote.
   *
   * It is the recording's owner rather than an account, so a replay somebody
   * sent you crowns *them* -- correct for what the file says, and the reason
   * the tooltip names who won rather than saying "you".
   */
  pov?: number;
  /**
   * Written by the background scan and never opened. Absent on everything the
   * older code wrote, which is why it is optional rather than a `false`: an
   * entry without it is one somebody actually opened, and that is what every
   * row from before this existed was.
   */
  scanned?: boolean;
  /**
   * It came in through "Load recordings" -- a pick, a drop, or a file the
   * system handed us -- rather than off a row of the recordings folder. Set on
   * first import and kept from then on, since it says where the recording came
   * from and not what has happened to it since.
   *
   * The list draws it on rows that are a kept parse and nothing else, where
   * "saved" said only what every such row already says. Optional like
   * `scanned` above: absent means the row predates this or came from the
   * folder, and neither gets the tag.
   */
  loaded?: boolean;
  /**
   * The absolute path of the recordings folder this was found in, when it came
   * off a folder row. It is how the list can ask "which of these did the game
   * itself write" once the folder is no longer being listed -- which is what
   * working out who you are needs. Absent on drops, picks, and anything an
   * older parser wrote.
   */
  root?: string;
}

export interface Usage {
  /** Bytes this origin is charged for, or null when the browser won't say. */
  usage: number | null;
  quota: number | null;
  /** True when the browser promised not to evict us under disk pressure. */
  persisted: boolean;
}

export const savedAvailable = typeof indexedDB !== "undefined";

/**
 * IndexedDB can stall rather than fail, and it does not always say so: a
 * `deleteDatabase` waiting on a connection another tab still holds leaves every
 * later `open` pending with no `error` and no `blocked` event. Opening a
 * recording waits on the store, so a stall there would freeze the parse -- the
 * one thing that must not depend on saving working. Everything gets a deadline
 * instead, and a store that misses it is treated as a store that said no.
 */
const OPEN_MS = 5000;
const OP_MS = 10000;

function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const alarm = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms} ms`)), ms);
  });
  return Promise.race([work, alarm]).finally(() => clearTimeout(timer));
}

let handle: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (handle) return handle;
  if (!savedAvailable) return Promise.reject(new Error("this browser has no IndexedDB"));
  handle = deadline(new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PAYLOADS)) db.createObjectStore(PAYLOADS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open the database"));
    // Another tab holds an older version open. It will close eventually; until
    // then this tab simply has no saved recordings.
    request.onblocked = () => reject(new Error("another tab is using an older database"));
  }), OPEN_MS, "the database");
  // A failed open must not stick: the next call gets to try again.
  handle.catch(() => { handle = null; });
  return handle;
}

function ask<T>(request: IDBRequest<T>): Promise<T> {
  return deadline(new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the request failed"));
  }), OP_MS, "the request");
}

function settled(tx: IDBTransaction): Promise<void> {
  return deadline(new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // Quota lands here rather than on the individual put.
    tx.onerror = () => reject(tx.error ?? new Error("the write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("the write was aborted"));
  }), OP_MS, "the write");
}

/** Newest-opened first. Rows from an older payload version are not listed. */
export async function listSaved(): Promise<SavedEntry[]> {
  const db = await open();
  const rows = await ask(db.transaction(META).objectStore(META).getAll() as IDBRequest<SavedEntry[]>);
  return rows.filter((row) => row.v === PAYLOAD_V).sort((a, b) => b.openedAt - a.openedAt);
}

/** Whether the store holds this parse. Touches nothing -- see `readSaved`. */
export async function hasSaved(id: string): Promise<boolean> {
  const db = await open();
  const meta = await ask(
    db.transaction(META).objectStore(META).get(id) as IDBRequest<SavedEntry | undefined>,
  );
  return Boolean(meta && meta.v === PAYLOAD_V);
}

/**
 * The payload for a saved recording, or null if it is not here (or was saved by
 * an older parser). Touches `openedAt`, which is what keeps a recording you
 * keep coming back to out of reach of the eviction below.
 */
export async function readSaved(id: string): Promise<Payload | null> {
  const db = await open();
  const meta = await ask(db.transaction(META).objectStore(META).get(id) as IDBRequest<SavedEntry | undefined>);
  if (!meta || meta.v !== PAYLOAD_V) return null;
  const payload = await ask(
    db.transaction(PAYLOADS).objectStore(PAYLOADS).get(id) as IDBRequest<Payload | undefined>,
  );
  if (!payload) return null;

  /* Reading it is what makes it an opened recording rather than a scanned one,
     so the flag comes off here: from now on it is evicted with the rest. */
  const { scanned: _wasScanned, ...rest } = meta;
  const tx = db.transaction(META, "readwrite");
  tx.objectStore(META).put({ ...rest, openedAt: Date.now() });
  await settled(tx);
  return payload;
}

export interface SaveOptions {
  /** This parse was nobody's idea -- the background scan made it. */
  scanned?: boolean;
  /** It arrived through "Load recordings", not off a folder row. */
  loaded?: boolean;
  /**
   * What to date the row by, when it is not "just now". The scan passes the
   * recording's own mtime: a row it wrote was never opened, so the honest
   * answer to "when did this last matter" is when the game was played -- and
   * eviction reads the same field, so the newest replays are the ones that
   * survive rather than whichever happened to be scanned last.
   */
  at?: number;
  /**
   * The file's last-edit time, from the folder listing. Kept whether or not it
   * is also `at`: `openedAt` moves the moment somebody opens the row, and this
   * has to survive that -- it is a fact about the file, not about the row.
   */
  modified?: number;
  /** The folder the recording was found in. Kept like `modified` is. */
  root?: string;
}

/** Re-saving the same recording keeps its original `savedAt`. */
export async function saveRecording(
  id: string,
  name: string,
  payload: Payload,
  { scanned = false, loaded = false, at, modified, root }: SaveOptions = {},
): Promise<SavedEntry> {
  const db = await open();
  const now = Date.now();
  const existing = await ask(
    db.transaction(META).objectStore(META).get(id) as IDBRequest<SavedEntry | undefined>,
  );
  /* A scan never demotes a row somebody opened: it would move it in among the
     first things thrown away. */
  const keepOpened = existing !== undefined && !existing.scanned;
  const pov = payload.pov == null
    ? -1
    : payload.players.findIndex((p) => p.number === payload.pov);
  const entry: SavedEntry = {
    id,
    v: PAYLOAD_V,
    name,
    savedAt: existing?.savedAt ?? now,
    /* A scan must not drag an opened row's date backwards to the file's. */
    openedAt: scanned && keepOpened ? existing.openedAt : at ?? now,
    /* Whatever the listing last said, or whatever it said before: a re-parse
       from bytes alone must not lose the date the folder row already gave this
       recording. */
    ...(modified ?? existing?.modified ? { modified: modified ?? existing?.modified } : {}),
    ...(root ?? existing?.root ? { root: root ?? existing?.root } : {}),
    ...(scanned && !keepOpened ? { scanned: true } : {}),
    /* Where it first came from, so opening it a second time -- off a folder
       row, or after a scan has been over it -- does not rewrite its history. */
    ...(loaded || existing?.loaded ? { loaded: true } : {}),
    map: payload.map,
    scenario: Boolean(payload.scenario),
    duration: payload.duration,
    difficulty: payload.difficulty,
    players: payload.players.map((p) => ({
      name: p.name,
      civilization: p.civilization,
      color: p.color,
      winner: p.winner,
      /* The AI sentinel is left out rather than stored: it would otherwise be
         a "profile" that every AI seat in the store shares. */
      ...(p.profile_id !== undefined && p.profile_id !== AI_PROFILE ? { profileId: p.profile_id } : {}),
    })),
    humans: payload.players.filter((p) => !p.is_ai).length,
    /* By player number, because the payload's array is in seat order and a
       missing seat would put the index off by one. Left out entirely when the
       recording has no owner, or names one who is not in the roster. */
    ...(pov >= 0 ? { pov } : {}),
  };

  const tx = db.transaction([META, PAYLOADS], "readwrite");
  tx.objectStore(META).put(entry);
  tx.objectStore(PAYLOADS).put(payload, id);
  await settled(tx);
  await evict(db);
  return entry;
}

export async function deleteSaved(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction([META, PAYLOADS], "readwrite");
  tx.objectStore(META).delete(id);
  tx.objectStore(PAYLOADS).delete(id);
  await settled(tx);
}

export async function clearSaved(): Promise<void> {
  const db = await open();
  const tx = db.transaction([META, PAYLOADS], "readwrite");
  tx.objectStore(META).clear();
  tx.objectStore(PAYLOADS).clear();
  await settled(tx);
}

/**
 * Drops what is past the caps, plus anything an older parser left behind.
 *
 * Two caps rather than one: the scan can fill a folder's worth of rows in a
 * few minutes, and a single list sorted by date would let it push out the
 * matches somebody actually opened. They are counted separately, so a scan can
 * only ever evict its own.
 */
async function evict(db: IDBDatabase): Promise<void> {
  const rows = await ask(db.transaction(META).objectStore(META).getAll() as IDBRequest<SavedEntry[]>);
  const stale = rows.filter((row) => row.v !== PAYLOAD_V);
  const live = rows.filter((row) => row.v === PAYLOAD_V).sort((a, b) => b.openedAt - a.openedAt);
  const doomed = live.filter((row) => !row.scanned).slice(MAX_SAVED)
    .concat(live.filter((row) => row.scanned).slice(MAX_SCANNED))
    .concat(stale);
  if (!doomed.length) return;

  const tx = db.transaction([META, PAYLOADS], "readwrite");
  for (const row of doomed) {
    tx.objectStore(META).delete(row.id);
    tx.objectStore(PAYLOADS).delete(row.id);
  }
  await settled(tx);
}

/** What the browser says about this origin's storage. Never throws. */
export async function usage(): Promise<Usage> {
  const storage = navigator.storage;
  if (!storage?.estimate) return { usage: null, quota: null, persisted: false };
  try {
    const [estimate, persisted] = await Promise.all([
      storage.estimate(),
      storage.persisted ? storage.persisted() : Promise.resolve(false),
    ]);
    return { usage: estimate.usage ?? null, quota: estimate.quota ?? null, persisted };
  } catch {
    return { usage: null, quota: null, persisted: false };
  }
}

/**
 * Ask the browser not to evict this origin. Chromium decides silently from how
 * much the site is used, Firefox prompts, Safari grants it on a bookmark -- so
 * this is a button, not something to do behind the user's back.
 */
export async function requestPersist(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
