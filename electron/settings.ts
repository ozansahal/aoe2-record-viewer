/**
 * `settings.json` in the user data folder.
 *
 * One flat object, one file, read and written whole. It holds the little that
 * has to outlive a launch -- the recordings folder, the zoom factor -- and
 * nothing that could be derived again, so losing it costs a folder pick.
 *
 * Every write is best effort: a profile we cannot write to must not break the
 * app, and an unreadable file is treated the same as a missing one.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { app } from "electron";

/* Resolved per call rather than at import: `app.getPath` is only meaningful
   once Electron has worked out where the profile lives. */
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

export async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsFile(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {}; // absent on a first run, and unreadable is the same as absent
  }
}

/*
 * One write at a time, in the order they were asked for.
 *
 * A write is a read, a merge and a write, and two of those overlapping lose
 * the later value: holding the zoom keys down fires one per keypress, and
 * without this the file ends up at whichever of them happened to read last --
 * a factor the window passed through, rather than the one it settled on.
 */
let queue: Promise<void> = Promise.resolve();

/** Merges over what is on disk, so two settings cannot overwrite each other. */
export function writeSettings(patch: Record<string, unknown>): Promise<void> {
  queue = queue.then(async () => {
    try {
      const merged = { ...(await readSettings()), ...patch };
      await mkdir(path.dirname(settingsFile()), { recursive: true });
      await writeFile(settingsFile(), JSON.stringify(merged, null, 2) + "\n");
    } catch (err) {
      console.warn("could not save settings:", (err as Error).message);
    }
  });
  return queue;
}
