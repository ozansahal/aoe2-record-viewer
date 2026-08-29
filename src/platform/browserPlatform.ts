import { fromFile } from "../lib/sources";
import type { Platform } from "./types";

const FILE_ACCEPT = ".aoe2record,.aoe2rec,.mgz,.mgx,.json,application/json";

/**
 * A plain browser: a file picker and nothing else.
 *
 * The input is built here rather than rendered by a component. Picking a file
 * is an action with an answer, so it reads as one -- the old hidden `<input>`
 * lived in the app's markup and delivered its files through a `change` handler
 * a hundred lines away from the button that opened it.
 */
function pickWithInput(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = FILE_ACCEPT;
    input.multiple = true;
    input.hidden = true;

    const done = (files: File[] | null) => {
      input.remove();
      resolve(files);
    };

    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      done(files.length ? files : null);
    }, { once: true });
    /* Not every browser fires this. The one that does not simply leaves the
       promise pending, which is what the old fire-and-forget input did too. */
    input.addEventListener("cancel", () => done(null), { once: true });

    // Safari will not open a picker for an input that is not in the document.
    document.body.append(input);
    input.click();
  });
}

export function browserPlatform(): Platform {
  return {
    env: "browser",

    async pickRecordings() {
      const files = await pickWithInput();
      return files && files.map(fromFile);
    },

    /* No folder to read and no window of our own: the page keeps its heading,
       and the files page shows saved recordings alone. */
    library: null,
    windowControls: null,
    // The browser's own zoom is already on Ctrl +/-; a second one would fight it.
    zoom: null,

    // Nothing can arrive from outside a tab, so there is nothing to unsubscribe.
    onExternalOpen: () => () => {},
  };
}
