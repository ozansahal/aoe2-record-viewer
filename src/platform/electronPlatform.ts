import type { Aoe2Bridge } from "../electron";
import { fromBytes } from "../lib/sources";
import type { Platform } from "./types";

/**
 * The preload bridge, as the app asks for it.
 *
 * Every call here is an IPC round trip to the main process. Nothing forwards a
 * path: `library.source` carries a folder and entry id from a previous listing and
 * `pickRecordings` a token from the last dialog, and the main process resolves
 * both back to a file itself.
 */
export function electronPlatform(bridge: Aoe2Bridge): Platform {
  return {
    env: "electron",

    async pickRecordings() {
      const picked = await bridge.openRecording();
      if (!picked?.length) return null; // the dialog was cancelled
      /* One token at a time, read when its turn comes -- a ten-file pick is
         not ten recordings sitting in memory at once. */
      return picked.map((file) => ({
        name: file.name,
        bytes: async () => (await bridge.readSelected(file.token)).bytes,
      }));
    },

    library: {
      list: () => bridge.library.list(),
      add: () => bridge.library.add(),
      remove: (dir) => bridge.library.remove(dir),
      source: (entry) => ({
        name: entry.name,
        bytes: async () => (await bridge.library.open(entry.root, entry.id)).bytes,
      }),
      reveal: (entry) => bridge.library.reveal(entry.root, entry.id),
      trash: (entry) => bridge.library.trash(entry.root, entry.id),
    },

    zoom: bridge.zoom,

    windowControls: bridge.window,

    onExternalOpen: (handler) =>
      bridge.onOpenRecording((opened) => handler(fromBytes(opened.name, opened.bytes))),
  };
}
