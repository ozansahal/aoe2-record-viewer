import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { LibraryState } from "./library";

interface OpenedRecording {
  name: string;
  bytes: ArrayBuffer;
}

/** One file the open dialog returned. `token` is the only handle on it. */
interface SelectedRecording {
  token: string;
  name: string;
}

/*
 * The whole main-process surface: open files, hear about files opened from
 * outside, browse the recordings folder, and work the window buttons the
 * renderer draws in place of the native ones. Nothing here forwards arbitrary
 * paths or IPC channels from the page -- `library.open` takes a folder and an
 * entry id from a previous listing and `readSelected` a token from the last
 * dialog, all of which the main process resolves back to a path itself. The
 * one path the page sends as such is `library.remove`'s, and that only ever
 * takes a folder off the list.
 */
contextBridge.exposeInMainWorld("aoe2", {
  openRecording: (): Promise<SelectedRecording[] | null> =>
    ipcRenderer.invoke("aoe2:open-dialog"),

  readSelected: (token: string): Promise<OpenedRecording> =>
    ipcRenderer.invoke("aoe2:read-selected", token),

  onOpenRecording: (handler: (file: OpenedRecording) => void) => {
    const listener = (_event: IpcRendererEvent, file: OpenedRecording) => handler(file);
    ipcRenderer.on("aoe2:open-recording", listener);
    return () => ipcRenderer.off("aoe2:open-recording", listener);
  },

  library: {
    list: (): Promise<LibraryState> => ipcRenderer.invoke("aoe2:library-list"),
    add: (): Promise<LibraryState | null> => ipcRenderer.invoke("aoe2:library-add"),
    remove: (dir: string): Promise<LibraryState> => ipcRenderer.invoke("aoe2:library-remove", dir),
    open: (root: string, id: string): Promise<OpenedRecording> =>
      ipcRenderer.invoke("aoe2:library-open", root, id),
    reveal: (root: string, id: string): Promise<void> =>
      ipcRenderer.invoke("aoe2:library-reveal", root, id),
    trash: (root: string, id: string): Promise<void> =>
      ipcRenderer.invoke("aoe2:library-trash", root, id),
  },

  /* Interface zoom. One factor for the app rather than per window, so `set`
     and the keyboard shortcuts both come back through `onChange`. */
  zoom: {
    get: (): Promise<number> => ipcRenderer.invoke("aoe2:zoom-get"),
    set: (factor: number): Promise<number> => ipcRenderer.invoke("aoe2:zoom-set", factor),
    step: (direction: 1 | -1): Promise<number> => ipcRenderer.invoke("aoe2:zoom-step", direction),
    reset: (): Promise<number> => ipcRenderer.invoke("aoe2:zoom-reset"),
    onChange: (handler: (factor: number) => void) => {
      const listener = (_event: IpcRendererEvent, factor: number) => handler(factor);
      ipcRenderer.on("aoe2:zoom-changed", listener);
      return () => ipcRenderer.off("aoe2:zoom-changed", listener);
    },
  },

  /* Its presence is also the renderer's test for "am I in a window of my own":
     in a browser there is no `aoe2` at all, and the page keeps its <h1>. */
  window: {
    // A sandboxed preload still gets this much of `process`.
    platform: process.platform,
    minimize: (): Promise<void> => ipcRenderer.invoke("aoe2:window-minimize"),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke("aoe2:window-maximize"),
    close: (): Promise<void> => ipcRenderer.invoke("aoe2:window-close"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("aoe2:window-maximized"),
    onMaximizedChange: (handler: (maximized: boolean) => void) => {
      const listener = (_event: IpcRendererEvent, maximized: boolean) => handler(maximized);
      ipcRenderer.on("aoe2:window-maximized", listener);
      return () => ipcRenderer.off("aoe2:window-maximized", listener);
    },
  },
});
