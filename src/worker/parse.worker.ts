/// <reference lib="webworker" />
/**
 * Parsing off the main thread.
 *
 * A 10 MB recording is ~93k actions and blocks for about a second, which is
 * long enough to eat the click that started it. The renderer transfers the
 * ArrayBuffer in, so there is no copy on the way here.
 */
import { buildMinimap } from "../lib/minimap";
import { fromMatch } from "../parser/filter_events.ts";
import { parseMatchAsync, type ReferenceData } from "../parser/parse_rec.ts";
import type { Payload } from "../types";

import constants from "../parser/aocref-data/constants.json";
import dataset100 from "../parser/aocref-data/datasets/100.json";
import dataset101 from "../parser/aocref-data/datasets/101.json";

/* Bundled rather than fetched: 100 is Definitive Edition, 101 the AoE1 mod. */
const reference = {
  constants,
  datasets: { 100: dataset100, 101: dataset101 },
} as unknown as ReferenceData;

export interface ParseRequest {
  id: number;
  bytes: ArrayBuffer;
  dedupe: number;
}

export type ParseResponse =
  | { id: number; ok: true; payload: Payload; ms: number }
  | { id: number; ok: false; error: string };

self.onmessage = async (event: MessageEvent<ParseRequest>) => {
  const { id, bytes, dedupe } = event.data;
  const started = performance.now();
  try {
    /* The same calls the CLI makes, so `payload` is what
       `filter_events --json` writes -- and what the Python prints, byte for
       byte. */
    const match = await parseMatchAsync(new Uint8Array(bytes), { reference });
    const payload: Payload = fromMatch(match, { dedupe }).payload;
    /* The map, which `fromMatch` does not carry: its output is the on-disk
       `events.json` contract and this is not part of it. The tiles and the
       gaia objects are only in `match`, which is discarded on the next line,
       so the minimap is built here or it is re-parsed later for nothing.
       Failing to is not worth failing the parse over -- the component draws
       nothing when the field is missing, which is also what an older payload
       and an imported events.json get. */
    try {
      const dataset = (reference.datasets as Record<number, unknown>)[match?.dataset_id];
      const minimap = buildMinimap(match, dataset ?? dataset100);
      if (minimap) payload.minimap = minimap;
    } catch { /* no map; the rest of the payload is still good */ }
    const done: ParseResponse = { id, ok: true, payload, ms: performance.now() - started };
    self.postMessage(done);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed: ParseResponse = { id, ok: false, error: message };
    self.postMessage(failed);
  }
};
