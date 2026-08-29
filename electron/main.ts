import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  net,
  protocol,
  shell,
} from "electron";

import {
  listRecordings,
  PAYLOAD_EXTS,
  RECORDING_EXTS,
  resolveEntry,
  setFolder,
} from "./library";
import { applyZoom, currentZoom, DEFAULT_ZOOM, loadZoom, setZoom, stepZoom } from "./zoom";

/** Bundled to CJS by scripts/build-electron.mjs, so __dirname is dist-electron/. */
const here = __dirname;
const RENDERER_DIST = path.join(here, "..", "dist");
/* Shipped inside the asar as well -- see the `files` list in package.json --
   so the same path works from dist-electron/ in both dev and a packaged app. */
const APP_ICON = path.join(here, "..", "assets", "icon.png");

/** Set by scripts/dev.mjs; absent in a packaged build. */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

/** How long a window may stay hidden waiting to paint before it is shown anyway. */
const SHOW_FALLBACK_MS = 4000;

const RECORDING_FILTERS = [
  { name: "AoE2 recordings", extensions: RECORDING_EXTS },
  { name: "Exported events", extensions: PAYLOAD_EXTS },
  { name: "All files", extensions: ["*"] },
];

/*
 * The renderer is served over app:// rather than file://.
 *
 * Chromium treats file:// as an opaque origin, which blocks module workers --
 * and the parser runs in one. A standard, secure scheme gives the page a real
 * origin and everything behaves as it does under the dev server.
 */
protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

function serveRenderer() {
  protocol.handle("app", async (request) => {
    const { pathname } = new URL(request.url);
    const target = path.join(RENDERER_DIST, decodeURIComponent(pathname));
    // Anything outside dist/ is somebody probing, not a real asset request.
    const relative = path.relative(RENDERER_DIST, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return new Response("not found", { status: 404 });
    }
    const file = pathname === "/" ? path.join(RENDERER_DIST, "index.html") : target;
    return net.fetch(pathToFileURL(file).toString());
  });
}

let mainWindow: BrowserWindow | null = null;
/** A file asked for before the renderer was ready to receive it. */
let queuedRecording: string | null = null;
/** What the last open dialog selected, by token. Cleared by the next dialog. */
const selected = new Map<string, string>();

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#14171b",
    show: false,
    /* Windows takes the taskbar and alt-tab icon from the .exe once packaged,
       but not while running unpackaged, and Linux never does. */
    icon: APP_ICON,
    /* The title bar is the renderer's -- src/components/TitleBar.tsx. "hidden"
       takes away the caption and its buttons but leaves the frame, so resize
       edges, snapping and the rounded corners are still the system's own. On
       macOS the traffic lights stay; the renderer leaves room for them. */
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 13, y: 11 },
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;

  /*
   * Showing the window is not allowed to depend on one event.
   *
   * `ready-to-show` rides on the renderer's first paint, and a window built
   * with `show: false` does not reliably get one on Windows -- measured at
   * roughly one launch in eight here, with the page fully loaded and the DOM
   * complete in every other case. The rest of the time the app sat there as
   * four processes and no window, which is what the installer's "run when
   * finished" produced, and nothing short of Task Manager got it back.
   *
   * So the first of three wakes it: the paint if it comes, the load if it does
   * not, and a timer if neither does -- a window showing an error beats a
   * process with no window. `backgroundColor` above is why the fallbacks are
   * safe: the frame is the app's own dark, not a white flash. Showing is also
   * what makes Chromium composite, so a window revealed on `did-finish-load`
   * paints immediately rather than staying blank.
   */
  let revealTimer: NodeJS.Timeout | undefined;
  let shown = false;
  const reveal = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    clearTimeout(revealTimer);
    win.show();
  };
  win.once("ready-to-show", reveal);
  win.webContents.once("did-finish-load", reveal);
  win.webContents.on("did-fail-load", (_event, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) reveal();
  });
  revealTimer = setTimeout(reveal, SHOW_FALLBACK_MS);
  win.once("closed", () => clearTimeout(revealTimer));

  /* The maximize button has to follow the window, not the other way round:
     double-clicking the drag region, Win+Up and the snap layouts all change
     the state without going through the renderer. */
  const pushMaximized = () => win.webContents.send("aoe2:window-maximized", win.isMaximized());
  win.on("maximize", pushMaximized);
  win.on("unmaximize", pushMaximized);

  /* Without a menu there are no accelerators either, and F12 and the zoom keys
     are the ones worth keeping. The zoom shortcuts are matched on `input.key`
     rather than `code`, so a layout where "+" needs shift still works, and
     both the main row and the numpad land here. */
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const devtools = input.key === "F12"
      || (input.control && input.shift && input.key.toLowerCase() === "i");
    if (devtools) {
      win.webContents.toggleDevTools();
      return;
    }
    // Cmd on macOS, Ctrl everywhere else, same as every other app's zoom.
    const accel = process.platform === "darwin" ? input.meta : input.control;
    if (!accel || input.alt) return;
    const windows = BrowserWindow.getAllWindows();
    if (input.key === "+" || input.key === "=") stepZoom(windows, 1);
    else if (input.key === "-" || input.key === "_") stepZoom(windows, -1);
    else if (input.key === "0") setZoom(windows, DEFAULT_ZOOM);
    else return;
    /* Chromium has its own handling for these, which would zoom a second time
       on top of ours and would not be saved. */
    event.preventDefault();
  });

  // Links open in the user's browser, never inside the app frame.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadURL("app://bundle/index.html");
  }

  win.webContents.on("did-finish-load", () => {
    // A navigation resets the factor, so this is where the saved one is put back.
    applyZoom(win.webContents);
    if (!queuedRecording) return;
    void sendRecording(queuedRecording);
    queuedRecording = null;
  });

  return win;
}

async function readRecording(file: string) {
  const bytes = await readFile(file);
  app.addRecentDocument(file);
  // A Buffer is a Uint8Array view; hand over an exact ArrayBuffer copy so the
  // renderer can transfer it into the parse worker.
  return {
    name: path.basename(file),
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

async function sendRecording(file: string) {
  if (!mainWindow) {
    queuedRecording = file;
    return;
  }
  try {
    const opened = await readRecording(file);
    mainWindow.webContents.send("aoe2:open-recording", opened);
  } catch (err) {
    dialog.showErrorBox("Could not open recording", `${file}\n\n${(err as Error).message}`);
  }
}

/** A recording passed on the command line, e.g. by a file association. */
const OPENABLE = new RegExp(`\\.(${[...RECORDING_EXTS, ...PAYLOAD_EXTS].join("|")})$`, "i");

function recordingFromArgv(argv: string[]): string | null {
  const hit = argv.slice(1).find((arg) => OPENABLE.test(arg));
  return hit ?? null;
}

// Windows and Linux hand a second launch's argv to the running instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const file = recordingFromArgv(argv);
    if (file) void sendRecording(file);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      /* A window that never became visible is the case this has to cover: the
         lock is held, so the second launch quits, and focusing something that
         was never shown does nothing -- the app looks dead to whoever clicked
         the shortcut. `reveal` in createWindow makes that rare; this makes a
         relaunch the way out of it rather than Task Manager. */
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  // macOS delivers file-association opens this way, possibly before app.ready.
  app.on("open-file", (event, file) => {
    event.preventDefault();
    void sendRecording(file);
  });

  void app.whenReady().then(async () => {
    serveRenderer();

    // Before any window, so the first one loads at the saved factor.
    await loadZoom();

    /* No application menu. Nothing in it was ours, and on Windows and Linux it
       drew a strip of chrome directly above the app's own header. macOS keeps
       its menu: that one lives in the system bar rather than in the window, and
       removing it would take Cmd+Q and the editing shortcuts with it. */
    if (process.platform !== "darwin") Menu.setApplicationMenu(null);

    /* The buttons in the renderer's title bar. Each acts on the window the
       call came from rather than on `mainWindow`, so a second window would
       work the same way. */
    const windowFor = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender);

    ipcMain.handle("aoe2:window-minimize", (event) => {
      windowFor(event)?.minimize();
    });

    ipcMain.handle("aoe2:window-maximize", (event) => {
      const win = windowFor(event);
      if (!win) return false;
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return win.isMaximized();
    });

    ipcMain.handle("aoe2:window-close", (event) => {
      windowFor(event)?.close();
    });

    ipcMain.handle("aoe2:window-maximized", (event) => windowFor(event)?.isMaximized() ?? false);

    /* Zoom. It is a window-independent setting -- one factor for the app, kept
       across launches -- so these act on every window rather than the caller's,
       and each answers with the factor that was settled on. */
    ipcMain.handle("aoe2:zoom-get", () => currentZoom());

    ipcMain.handle("aoe2:zoom-set", (_event, value: unknown) => {
      if (typeof value !== "number") throw new Error("zoom must be a number");
      return setZoom(BrowserWindow.getAllWindows(), value);
    });

    ipcMain.handle("aoe2:zoom-step", (_event, direction: unknown) => {
      if (direction !== 1 && direction !== -1) throw new Error("step must be 1 or -1");
      return stepZoom(BrowserWindow.getAllWindows(), direction);
    });

    ipcMain.handle("aoe2:zoom-reset", () => setZoom(BrowserWindow.getAllWindows(), DEFAULT_ZOOM));

    /* The dialog hands back names and tokens, not paths and not bytes: the
       renderer reads them one at a time through `aoe2:read-selected`, so
       picking twenty recordings is not twenty of them in memory at once. Only
       the last pick is redeemable, and a token is the whole handle -- same
       shape as the folder listing's entry ids. */
    ipcMain.handle("aoe2:open-dialog", async () => {
      const result = await dialog.showOpenDialog({
        title: "Open recordings",
        properties: ["openFile", "multiSelections"],
        filters: RECORDING_FILTERS,
      });
      if (result.canceled || !result.filePaths.length) return null;
      selected.clear();
      return result.filePaths.map((file) => {
        const token = randomUUID();
        selected.set(token, file);
        return { token, name: path.basename(file) };
      });
    });

    ipcMain.handle("aoe2:read-selected", async (_event, token: unknown) => {
      const file = typeof token === "string" ? selected.get(token) : undefined;
      if (!file) throw new Error("that file did not come from the open dialog");
      return readRecording(file);
    });

    /* The recordings folder. The renderer never sees or sends a path outside
       it -- it asks for an entry by the id `listRecordings` gave it. */
    ipcMain.handle("aoe2:library-list", () => listRecordings());

    ipcMain.handle("aoe2:library-choose", async () => {
      const result = await dialog.showOpenDialog({
        title: "Choose your recordings folder",
        properties: ["openDirectory"],
        buttonLabel: "Use this folder",
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return setFolder(result.filePaths[0]);
    });

    ipcMain.handle("aoe2:library-open", async (_event, id: unknown) => {
      const file = typeof id === "string" ? await resolveEntry(id) : null;
      if (!file) throw new Error("that recording is not in the chosen folder");
      return readRecording(file);
    });

    ipcMain.handle("aoe2:library-reveal", async (_event, id: unknown) => {
      const file = typeof id === "string" ? await resolveEntry(id) : null;
      if (file) shell.showItemInFolder(file);
    });

    /* The one call here that changes the folder rather than reading it, so it
       is the one that has to be undoable: the OS trash, never unlink. It goes
       through the same `resolveEntry` check as everything else -- a renderer
       cannot name a file outside the chosen folder, and asking to delete one
       is where that matters most. */
    ipcMain.handle("aoe2:library-trash", async (_event, id: unknown) => {
      const file = typeof id === "string" ? await resolveEntry(id) : null;
      if (!file) throw new Error("that recording is not in the chosen folder");
      await shell.trashItem(file);
    });

    const startup = recordingFromArgv(process.argv);
    if (startup) queuedRecording = startup;

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
