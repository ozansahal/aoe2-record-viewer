/**
 * The recordings folder.
 *
 * Age of Empires II: DE drops every replay into one directory and names them
 * all `MP Replay v101.103.48987.0 @2026.08.14 194921`, so finding the one you
 * just played through a file dialog is miserable. This scans that folder once
 * and hands the renderer a list.
 *
 * Nothing here trusts the renderer with a path: it asks for an entry by the
 * folder it was listed under and its id, a path relative to that folder, and
 * `resolveEntry` refuses a folder that is not on the list and an id that
 * escapes it or is not a recording.
 */
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readSettings, writeSettings } from "./settings";

export const RECORDING_EXTS = ["aoe2record", "aoe2rec", "mgz", "mgx"];
/** The CLIs' exported events.json. The dialog and drag-drop take these; the
 *  folder listing does not -- DE keeps telemetry and mod manifests as .json
 *  right next to the replays, and they are newer than any of them. */
export const PAYLOAD_EXTS = ["json"];
const LISTED = new Set(RECORDING_EXTS);

/** DE keeps replays at `<root>/<steam id>/savegame/`, so two is the useful
 *  depth; three lets someone point at the folder above it and still get a list.
 *  The cap is there so picking a home directory by mistake cannot hang. */
const MAX_DEPTH = 3;
const MAX_ENTRIES = 4000;

export interface LibraryEntry {
  /** Path relative to `root`, POSIX-separated. What the renderer sends back. */
  id: string;
  /** The folder it was found under -- one of `LibraryState.folders`. */
  root: string;
  name: string;
  /** Sub-directory it was found in, "" at the top. */
  folder: string;
  size: number;
  /** Epoch ms. */
  modified: number;
}

export interface LibraryFolder {
  /** Absolute. */
  path: string;
  /** True when it is the game's own savegame folder, found rather than chosen. */
  detected: boolean;
  /** Set when this folder could not be read at all. The others still list. */
  error: string | null;
  /** This folder's walk stopped at its cap, so its part of the list is partial. */
  truncated: boolean;
}

export interface LibraryState {
  /** In the order they were added. Empty when nothing is set and nothing was found. */
  folders: LibraryFolder[];
  /** Every folder's recordings together, newest first. */
  entries: LibraryEntry[];
}

/* ---- where the game puts them ---- */

const STEAM_APP_ID = "813780";

function candidates(): string[] {
  const home = os.homedir();
  const underWine = (prefix: string) =>
    path.join(prefix, "drive_c", "users", "steamuser", "Games", "Age of Empires 2 DE");
  if (process.platform === "win32") {
    return [path.join(home, "Games", "Age of Empires 2 DE")];
  }
  // Proton keeps the same layout inside its prefix.
  return [
    path.join(home, ".steam", "steam", "steamapps", "compatdata", STEAM_APP_ID, "pfx"),
    path.join(home, ".local", "share", "Steam", "steamapps", "compatdata", STEAM_APP_ID, "pfx"),
  ].map(underWine);
}

async function detectFolder(): Promise<string | null> {
  for (const dir of candidates()) {
    try {
      if ((await stat(dir)).isDirectory()) return dir;
    } catch {
      // Not installed there. Try the next one.
    }
  }
  return null;
}

/* ---- the chosen folders, remembered across launches ---- */

/*
 * A list rather than one folder. The game writes into one place, and that one
 * is found on its own; recordings other people sent are wherever they were
 * saved to, and the list is how both are read at once. The game's folder is
 * always the first entry unless it was removed, and it is what tells the
 * renderer which recordings the game itself wrote -- see `detected`.
 */
const SETTING = "libraryFolders";
/** The one-folder setting this replaced. Read once, for the migration. */
const OLD_SETTING = "libraryFolder";
/** Folders the user took off the list. Kept so a re-detect does not put the
 *  game's own folder straight back. */
const HIDDEN = "libraryHidden";

/** undefined until resolved once. */
let folders: string[] | undefined;
let detectedFolder: string | null = null;

function readList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v) : [];
}

async function currentFolders(): Promise<string[]> {
  if (folders !== undefined) return folders;
  const settings = await readSettings();
  let list = readList(settings[SETTING]);
  /* The single-folder setting becomes a one-entry list. Written straight back,
     so the next launch does not migrate again. */
  const old = settings[OLD_SETTING];
  if (!list.length && typeof old === "string" && old) {
    list = [old];
    await writeSettings({ [SETTING]: list, [OLD_SETTING]: undefined });
  }
  /* Re-detected every launch rather than saved, so installing the game later
     is enough to make it appear -- and put first, since it is the folder the
     list is for. Unless it was removed on purpose. */
  detectedFolder = await detectFolder();
  const hidden = new Set(readList(settings[HIDDEN]));
  if (detectedFolder && !list.includes(detectedFolder) && !hidden.has(detectedFolder)) {
    list = [detectedFolder, ...list];
  }
  folders = list;
  return folders;
}

export async function addFolder(dir: string): Promise<LibraryState> {
  const list = await currentFolders();
  if (!list.includes(dir)) {
    folders = [...list, dir];
    await writeSettings({ [SETTING]: folders });
  }
  return listRecordings();
}

/** Only ever a folder from the list; anything else is a no-op. */
export async function removeFolder(dir: string): Promise<LibraryState> {
  const list = await currentFolders();
  if (list.includes(dir)) {
    folders = list.filter((f) => f !== dir);
    const patch: Record<string, unknown> = { [SETTING]: folders };
    if (dir === detectedFolder) {
      const hidden = readList((await readSettings())[HIDDEN]);
      patch[HIDDEN] = [...new Set([...hidden, dir])];
    }
    await writeSettings(patch);
  }
  return listRecordings();
}

/* ---- scanning ---- */

async function walk(dir: string, depth: number, out: LibraryEntry[], root: string) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // a folder we cannot read is not a reason to abandon the rest
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) return;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    // Symlinks report neither, which also keeps the walk out of cycles.
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) dirs.push(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!LISTED.has(path.extname(entry.name).slice(1).toLowerCase())) continue;
    let info;
    try {
      info = await stat(full);
    } catch {
      continue; // deleted between the readdir and here
    }
    const relative = path.relative(root, full);
    out.push({
      id: relative.split(path.sep).join("/"),
      root,
      name: entry.name,
      folder: path.dirname(relative) === "." ? "" : path.dirname(relative).split(path.sep).join("/"),
      size: info.size,
      modified: info.mtimeMs,
    });
  }
  // Files first, then descend: a shallow folder should not be cut off by the
  // cap while a deep one is still being walked.
  for (const child of dirs) {
    if (out.length >= MAX_ENTRIES) return;
    await walk(child, depth + 1, out, root);
  }
}

async function scanFolder(root: string): Promise<{ folder: LibraryFolder; entries: LibraryEntry[] }> {
  const folder: LibraryFolder = {
    path: root, detected: root === detectedFolder, error: null, truncated: false,
  };
  try {
    if (!(await stat(root)).isDirectory()) throw new Error("not a folder");
  } catch (err) {
    folder.error = `Cannot read this folder: ${(err as Error).message}`;
    return { folder, entries: [] };
  }
  const entries: LibraryEntry[] = [];
  await walk(root, 0, entries, root);
  folder.truncated = entries.length >= MAX_ENTRIES;
  return { folder, entries };
}

export async function listRecordings(): Promise<LibraryState> {
  const roots = await currentFolders();
  const scanned = await Promise.all(roots.map(scanFolder));
  const entries = scanned.flatMap((s) => s.entries);
  entries.sort((a, b) => b.modified - a.modified);
  return { folders: scanned.map((s) => s.folder), entries };
}

/**
 * An absolute path for an entry, or null if it is not one of ours: `root` has
 * to be a folder on the list, exactly as the listing gave it, and `id` a
 * recording inside it.
 */
export async function resolveEntry(root: unknown, id: unknown): Promise<string | null> {
  if (typeof root !== "string" || typeof id !== "string" || !id) return null;
  if (!(await currentFolders()).includes(root)) return null;
  if (!LISTED.has(path.extname(id).slice(1).toLowerCase())) return null;
  const target = path.resolve(root, id);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}
