/** The preload bridge. Undefined in a plain browser, so every use is guarded. */
export interface OpenedRecording {
  name: string;
  bytes: ArrayBuffer;
}

/** One file the open dialog returned. `token` is the only handle on it. */
export interface SelectedRecording {
  token: string;
  name: string;
}

/** One file in a recordings folder. Mirrors `electron/library.ts`. */
export interface LibraryEntry {
  /** Path relative to `root`. With it, the only handle the renderer has on a file. */
  id: string;
  /** The folder it was listed under -- one of `LibraryState.folders`. */
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
  /** It is the game's own savegame folder, found rather than chosen. */
  detected: boolean;
  /** Set when this folder could not be read at all. The others still list. */
  error: string | null;
  /** This folder's scan stopped at its cap, so its rows are partial. */
  truncated: boolean;
}

export interface LibraryState {
  /** In the order they were added; empty when none is set and none was found. */
  folders: LibraryFolder[];
  /** Every folder's recordings together, newest first. */
  entries: LibraryEntry[];
}

export interface Aoe2Library {
  /** Re-scans every time; there is no cache on either side. */
  list(): Promise<LibraryState>;
  /** Native folder picker. Resolves null when cancelled, else the new listing. */
  add(): Promise<LibraryState | null>;
  /** Takes a folder off the list. Deletes nothing; resolves the new listing. */
  remove(dir: string): Promise<LibraryState>;
  /** Reads one entry. Rejects if the folder is not listed or the id escapes it. */
  open(root: string, id: string): Promise<OpenedRecording>;
  /** Shows the file in the OS file manager. */
  reveal(root: string, id: string): Promise<void>;
  /** Moves the file to the OS trash. Rejects if the entry is not one of ours. */
  trash(root: string, id: string): Promise<void>;
}

/** The window's own buttons, since the native ones are gone. */
export interface Aoe2Window {
  /** `process.platform`. macOS draws its traffic lights itself, so it gets none. */
  platform: string;
  minimize(): Promise<void>;
  /** Maximized becomes restored and back. Resolves the state it ended in. */
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /**
   * Every change, including the ones the app never sees -- a double-click on
   * the drag region, Win+Up, a snap layout. Returns an unsubscribe.
   */
  onMaximizedChange(handler: (maximized: boolean) => void): () => void;
}

/** Interface zoom: one factor for the whole app, kept across launches. */
export interface Aoe2Zoom {
  /** The factor in force, 1 being 100%. */
  get(): Promise<number>;
  /** Sets it, clamped to what the app allows. Resolves the factor it settled on. */
  set(factor: number): Promise<number>;
  /** One notch up (1) or down (-1) the preset ladder. */
  step(direction: 1 | -1): Promise<number>;
  /** Back to 100%. */
  reset(): Promise<number>;
  /**
   * Every change, the keyboard shortcuts included -- Ctrl/Cmd with +, - or 0
   * are handled in the main process, so this is how the UI hears about them.
   * Returns an unsubscribe.
   */
  onChange(handler: (factor: number) => void): () => void;
}

export interface Aoe2Bridge {
  /**
   * Native open dialog, multi-select. Resolves null when it is cancelled, else
   * one entry per file -- read them with `readSelected`, one at a time.
   */
  openRecording(): Promise<SelectedRecording[] | null>;
  /** Reads one file from the last dialog. Rejects on any other token. */
  readSelected(token: string): Promise<OpenedRecording>;
  /**
   * A recording opened from outside the app -- a file association, a
   * command-line argument, or macOS's open-file event. Returns an unsubscribe.
   */
  onOpenRecording(handler: (file: OpenedRecording) => void): () => void;
  library: Aoe2Library;
  zoom: Aoe2Zoom;
  window: Aoe2Window;
}

declare global {
  interface Window {
    aoe2?: Aoe2Bridge;
  }
}

export {};
