/**
 * What the app can ask of the thing it is running inside.
 *
 * Under Electron that is the preload bridge on `window.aoe2`, which crosses a
 * process boundary; in a browser it is the DOM. Neither of those is something
 * React can abstract away, but *which one is present* is, and that is all the
 * component tree ever needed to know. Nothing below `src/platform/` touches
 * `window.aoe2` -- the capability is asked for, not looked up.
 *
 * These are plain objects rather than hooks on purpose: they hold no state and
 * survive being built once, at boot, by the shell that matches the host.
 */
import type { LibraryEntry, LibraryState } from "../electron";
import type { Source } from "../lib/sources";

export type PlatformEnv = "electron" | "browser";

/** The recordings folders. Electron only -- a browser cannot read a directory. */
export interface LibraryApi {
  /** Re-scans every time; there is no cache on either side. */
  list(): Promise<LibraryState>;
  /** Native folder picker. Resolves null when cancelled, else the new listing. */
  add(): Promise<LibraryState | null>;
  /** Takes a folder off the list. Deletes nothing; resolves the new listing. */
  remove(dir: string): Promise<LibraryState>;
  /** One entry as a source. The bytes are not read until it is opened. */
  source(entry: LibraryEntry): Source;
  /** Shows the file in the OS file manager. */
  reveal(entry: LibraryEntry): Promise<void>;
  /** Moves the file to the OS trash, so a mis-click can be put back. */
  trash(entry: LibraryEntry): Promise<void>;
}

/**
 * Interface zoom. Electron only -- a browser already has one of its own, on
 * the same keys, and a second would fight it.
 */
export interface ZoomApi {
  /** The factor in force, 1 being 100%. */
  get(): Promise<number>;
  /** One notch up (1) or down (-1). Resolves the factor it settled on. */
  step(direction: 1 | -1): Promise<number>;
  /** Back to 100%. */
  reset(): Promise<number>;
  /** Every change, the keyboard shortcuts included. Returns an unsubscribe. */
  onChange(handler: (factor: number) => void): () => void;
}

/** The window's own buttons, since the native ones are gone. Electron only. */
export interface WindowControls {
  /** `process.platform`. macOS draws its traffic lights itself, so it gets none. */
  platform: string;
  minimize(): Promise<void>;
  /** Maximized becomes restored and back. Resolves the state it ended in. */
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Every change, including ones the app never caused. Returns an unsubscribe. */
  onMaximizedChange(handler: (maximized: boolean) => void): () => void;
}

export interface Platform {
  readonly env: PlatformEnv;
  /**
   * The native open dialog under Electron, a file picker in a browser. Both
   * take more than one file. Resolves null when it is cancelled.
   */
  pickRecordings(): Promise<Source[] | null>;
  /** Null in a browser: there is no folder to read there. */
  readonly library: LibraryApi | null;
  /** Null in a browser: the page keeps its own heading instead. */
  readonly windowControls: WindowControls | null;
  /** Null in a browser, which does its own zooming on the same keys. */
  readonly zoom: ZoomApi | null;
  /**
   * A recording opened from outside the app -- a file association, a
   * command-line argument, macOS's open-file event. Returns an unsubscribe.
   * In a browser nothing can arrive this way, so it subscribes to nothing.
   */
  onExternalOpen(handler: (source: Source) => void): () => void;
}
