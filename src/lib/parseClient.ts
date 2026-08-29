import type { ParseRequest, ParseResponse } from "../worker/parse.worker";
import type { Payload } from "../types";
import { DEDUPE_SECONDS } from "./format";

/**
 * One long-lived parse worker, created on first use.
 *
 * Requests are tagged with an id and resolved by it, so a second drop while the
 * first is still parsing cannot resolve the wrong promise.
 */
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, {
  resolve: (r: { payload: Payload; ms: number }) => void;
  reject: (e: Error) => void;
}>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("../worker/parse.worker.ts", import.meta.url), {
    type: "module",
    name: "aoe2-parser",
  });
  worker.onmessage = (event: MessageEvent<ParseResponse>) => {
    const message = event.data;
    const slot = pending.get(message.id);
    if (!slot) return;
    pending.delete(message.id);
    if (message.ok) slot.resolve({ payload: message.payload, ms: message.ms });
    else slot.reject(new Error(message.error));
  };
  worker.onerror = (event) => {
    // A worker-level failure kills every request in flight; fail them all
    // rather than leaving the UI on "Parsing..." forever.
    const error = new Error(event.message || "the parser worker failed");
    for (const [, slot] of pending) slot.reject(error);
    pending.clear();
  };
  return worker;
}

/** Parse a recording into the viewer payload. Consumes `bytes` (it is transferred). */
export function parseRecording(
  bytes: ArrayBuffer,
  dedupe: number = DEDUPE_SECONDS,
): Promise<{ payload: Payload; ms: number }> {
  const id = nextId++;
  const request: ParseRequest = { id, bytes, dedupe };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage(request, [bytes]);
  });
}
