/**
 * Where a recording comes from, and the one road it travels afterwards.
 *
 * There are five ways in -- a drop, the file input, the Electron open dialog,
 * a row of the recordings folder, a file association -- and they differ only in
 * how the bytes are fetched. Each becomes a `Source`, and every one of them
 * goes through `openSource`, so "is it saved already?" and "save it" are asked
 * once, in one place, and the answer cannot come out different in a browser
 * than it does in the app.
 */
import { DEDUPE_SECONDS, EVENTS_RULES } from "./format";
import { fingerprint, loadRecordingBytes, type Loaded } from "./loadPayload";
import type { SaveOptions } from "./savedStore";
import type { Payload } from "../types";

/** The bytes are fetched when its turn comes, so a ten-file pick is not ten
 *  recordings in memory at once. */
export interface Source {
  name: string;
  bytes: () => Promise<ArrayBuffer>;
}

export const fromFile = (file: File): Source =>
  ({ name: file.name, bytes: () => file.arrayBuffer() });

/** For bytes somebody else already read -- the Electron main process does. */
export const fromBytes = (name: string, bytes: ArrayBuffer): Source =>
  ({ name, bytes: async () => bytes });

/**
 * What `openSource` needs of the saved recordings, which is very little.
 * `useSaved` satisfies it; so would a stub in a test. Neither this file nor the
 * store below it knows which of the two front ends is running.
 */
export interface Store {
  /** Null when it is not saved, or was saved by an older parser. */
  read(id: string): Promise<Payload | null>;
  /**
   * Whether it is in there, without reading it. `read` counts as opening the
   * recording -- it moves the row's date and takes the scan flag off it -- and
   * the background scan asking "have I done this one?" is not that.
   */
  has(id: string): Promise<boolean>;
  /** Null when it could not be saved -- which is not a reason to fail. */
  remember(
    id: string,
    name: string,
    payload: Payload,
    options?: SaveOptions,
  ): Promise<{ id: string } | null>;
}

/* The dedupe window is part of what a payload *is*, not a detail of how it was
   made: parse the same recording with a different one and the right answer is
   different, so it belongs in the key rather than in a comment. Taken before
   `loadRecordingBytes`, which hands the buffer to the worker by transfer and
   leaves it detached. */
const keyFor = async (name: string, bytes: ArrayBuffer) =>
  `${await fingerprint(name, bytes)}-d${DEDUPE_SECONDS}-r${EVENTS_RULES}`;

/**
 * A saved parse if there is one, otherwise the parser -- and then it is saved.
 *
 * `loaded` is the only thing about the way in that the row keeps: true for the
 * four that arrive from outside the recordings folder -- a drop, the file
 * input, the open dialog, a file association -- and false for a folder row.
 * It is only ever written on the first import, so a recording found again in
 * the folder is not re-labelled by having been opened.
 */
export async function openSource(
  source: Source,
  store: Store,
  /* `modified` is the file's own last-edit time, and only a folder row knows
     it -- a drop hands us bytes and a name and nothing else. It is carried
     because it is the one date that says when the *game* was, rather than when
     this app happened to look at it. */
  { loaded = false, modified, root }: { loaded?: boolean; modified?: number; root?: string } = {},
): Promise<Loaded> {
  const bytes = await source.bytes();
  const id = await keyFor(source.name, bytes);

  const hit = await store.read(id);
  if (hit) return { payload: hit, note: `${source.name} — from saved recordings`, savedId: id };

  const read = await loadRecordingBytes(source.name, bytes);
  const entry = await store.remember(id, source.name, read.payload, { loaded, modified, root });
  return { ...read, savedId: entry?.id };
}

/**
 * Parse a recording nobody asked for, and keep it.
 *
 * The same road as `openSource` minus the destination: no tab, no note, and
 * the row it writes is marked as the scan's rather than something opened. It
 * is what the recordings folder is read with in the background, so a row can
 * say which map and who won before anyone has clicked it -- and so clicking it
 * afterwards is a read rather than a second of parsing.
 *
 * `known` is the common case on every run after the first. `unsaved` means the
 * store refused it -- full, or blocked -- and there is no point scanning on:
 * every file after it would be parsed and thrown away too.
 */
export type ScanResult = "known" | "kept" | "unsaved";

export async function scanSource(
  source: Source,
  store: Store,
  at: number,
  /** Which folder it was found in -- kept on the row, see `SavedEntry.root`. */
  root?: string,
): Promise<ScanResult> {
  const bytes = await source.bytes();
  const id = await keyFor(source.name, bytes);
  if (await store.has(id)) return "known";

  const loaded = await loadRecordingBytes(source.name, bytes);
  const entry = await store.remember(
    id, source.name, loaded.payload, { scanned: true, at, modified: at, root },
  );
  return entry ? "kept" : "unsaved";
}
