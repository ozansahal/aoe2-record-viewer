import type { Aoe2Bridge } from "../electron";
import { fromBytes } from "../lib/sources";
import type { Platform } from "./types";

/**
 * The preload bridge, as the app asks for it.
 *
 * Every call here is an IPC round trip to the main process. Nothing forwards a
 * path: `library.source` carries an entry id from a previous listing and
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
      choose: () => bridge.library.choose(),
      source: (entry) => ({
        name: entry.name,
        bytes: async () => (await bridge.library.open(entry.id)).bytes,
      }),
      reveal: (id) => bridge.library.reveal(id),
      trash: (id) => bridge.library.trash(id),
    },

    zoom: bridge.zoom,

    windowControls: bridge.window,

    onExternalOpen: (handler) =>
      bridge.onOpenRecording((opened) => handler(fromBytes(opened.name, opened.bytes))),
  };
}
