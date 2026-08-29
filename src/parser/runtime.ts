/**
 * The Node bits the parser needs (fs, path, zlib), injected rather than
 * imported.
 *
 * Everything under src/parser is bundled for the renderer and for a Web Worker,
 * so a literal `import "node:zlib"` anywhere in this module graph would make
 * Vite fail the build. The CLIs in ../../cli call `setNodeRuntime()` before
 * doing any work; in the browser these stay null and the parser takes its
 * async path (DecompressionStream) with reference data passed in.
 *
 * The three modules are described structurally rather than as
 * `typeof import("node:fs")`: the renderer's `types` deliberately leaves
 * @types/node out, so those names do not resolve here -- which is the same
 * seam, enforced by the type checker as well as by the bundler. Only the calls
 * the parser actually makes are described; the real modules satisfy them.
 */

export interface RuntimeFs {
  readFileSync(path: string): Uint8Array;
  readFileSync(path: string, encoding: string): string;
}

export interface RuntimePath {
  join(...parts: string[]): string;
}

export interface RuntimeZlib {
  inflateRawSync(data: Uint8Array): Uint8Array;
}

export interface NodeRuntime {
  /** node:fs, or null outside Node. */
  fs: RuntimeFs | null;
  /** node:path, or null outside Node. */
  path: RuntimePath | null;
  /** node:zlib -- the only synchronous inflate; without it use parseMatchAsync. */
  zlib: RuntimeZlib | null;
  /** Directory holding constants.json and datasets/, read lazily by the CLIs. */
  referenceDir: string | null;
}

export const runtime: NodeRuntime = {
  fs: null,
  path: null,
  zlib: null,
  referenceDir: null,
};

export function setNodeRuntime(next: Partial<NodeRuntime>): void {
  Object.assign(runtime, next);
}

/* Node's `process`, declared rather than imported, for the same reason. */
declare const process: { versions?: { node?: string } } | undefined;

/** True in Node, false in a renderer or worker. */
export const IS_NODE: boolean =
  typeof process !== "undefined" && !!(process.versions && process.versions.node);
