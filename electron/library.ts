/**
 * The recordings folder.
 *
 * Age of Empires II: DE drops every replay into one directory and names them
 * all `MP Replay v101.103.48987.0 @2026.08.14 194921`, so finding the one you
 * just played through a file dialog is miserable. This scans that folder once
 * and hands the renderer a list.
 *
 * Nothing here trusts the renderer with a path: it asks for an entry by its id,
 * which is a path relative to the chosen folder, and `resolveEntry` refuses
 * anything that escapes the folder or is not a recording.
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
  /** Path relative to the folder, POSIX-separated. What the renderer sends back. */
  id: string;
  name: string;
  /** Sub-directory it was found in, "" at the top. */
  folder: string;
  size: number;
  /** Epoch ms. */
  modified: number;
}

export interface LibraryState {
  /** Absolute, or null when nothing is set and nothing was found. */
  folder: string | null;
  /** True when the folder came from the game's install location, not a choice. */
  detected: boolean;
  entries: LibraryEntry[];
  /** The scan stopped at its cap, so the list is partial. */
  truncated: boolean;
  /** Set when the folder could not be read at all. */
  error: string | null;
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

/* ---- the chosen folder, remembered across launches ---- */

const SETTING = "libraryFolder";

/** undefined until resolved once; null means "none set and none found". */
let folder: string | null | undefined;
let detected = false;

async function currentFolder(): Promise<string | null> {
  if (folder !== undefined) return folder;
  const saved = (await readSettings())[SETTING];
  if (typeof saved === "string" && saved) {
    folder = saved;
    detected = false;
  } else {
    // Re-detected every launch rather than saved, so installing the game later
    // is enough to make the list appear.
    folder = await detectFolder();
    detected = folder !== null;
  }
  return folder;
}

export async function setFolder(dir: string): Promise<LibraryState> {
  folder = dir;
  detected = false;
  await writeSettings({ [SETTING]: dir });
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

export async function listRecordings(): Promise<LibraryState> {
  const root = await currentFolder();
  if (!root) return { folder: null, detected: false, entries: [], truncated: false, error: null };

  try {
    if (!(await stat(root)).isDirectory()) throw new Error("not a folder");
  } catch (err) {
    return {
      folder: root,
      detected,
      entries: [],
      truncated: false,
      error: `Cannot read this folder: ${(err as Error).message}`,
    };
  }

  const entries: LibraryEntry[] = [];
  await walk(root, 0, entries, root);
  entries.sort((a, b) => b.modified - a.modified);
  return {
    folder: root,
    detected,
    entries,
    truncated: entries.length >= MAX_ENTRIES,
    error: null,
  };
}

/** An absolute path for an entry id, or null if the id is not one of ours. */
export async function resolveEntry(id: string): Promise<string | null> {
  const root = await currentFolder();
  if (!root || typeof id !== "string" || !id) return null;
  if (!LISTED.has(path.extname(id).slice(1).toLowerCase())) return null;
  const target = path.resolve(root, id);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}
