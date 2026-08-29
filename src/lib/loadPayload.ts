import type { Payload } from "../types";
import { parseRecording } from "./parseClient";

const EXPORT_HINT =
  "node cli/filter_events.js rec.aoe2record --json --dedupe -o events.json";

/** Rejects anything that is not a viewer payload, and sorts events by time. */
function adopt(value: unknown): Payload {
  const d = value as Payload | null;
  if (!d || !Array.isArray(d.events) || !Array.isArray(d.players)) {
    throw new Error(
      `missing \`events\` or \`players\`. Drop an .aoe2record instead, or generate it with: ${EXPORT_HINT}`);
  }
  // Several consumers walk events in order and stop early -- techsHeldBy relies
  // on it -- and an events.json edited by hand may not be sorted.
  d.events.sort((a, b) => a.t - b.t);
  return d;
}

export interface Loaded {
  payload: Payload;
  /** Where it came from, for the console and the header line. */
  note: string;
  /** Key in the saved store, when it is kept there. */
  savedId?: string;
}

/**
 * Accepts either a recording or an events.json, picked by extension. Anything
 * that isn't .json goes to the parser, so .aoe2record, .mgz and friends all
 * land in the same place.
 *
 * Consumes `bytes`: the parser worker takes it by transfer. Fingerprint before
 * calling this, not after.
 */
export async function loadRecordingBytes(name: string, bytes: ArrayBuffer): Promise<Loaded> {
  if (/\.json$/i.test(name)) {
    const text = new TextDecoder().decode(bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${name} is not valid JSON: ${(err as Error).message}`);
    }
    return { payload: adopt(parsed), note: name };
  }
  const { payload, ms } = await parseRecording(bytes);
  return { payload: adopt(payload), note: `${name} — parsed in ${Math.round(ms)} ms` };
}

/**
 * A stable id for a file's contents, so the same recording opened twice -- from
 * the folder, from a drop, renamed -- is one saved entry and one parse.
 *
 * `crypto.subtle` needs a secure context: the dev server on localhost and the
 * packaged app's `app://` both qualify, plain http on a LAN address does not.
 * There the name and length have to do, which is weaker but only ever costs a
 * duplicate row.
 */
export async function fingerprint(name: string, bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return `n:${name}:${bytes.byteLength}`;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest, 0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
