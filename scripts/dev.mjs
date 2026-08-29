/**
 * Development: Vite dev server + Electron, both watching.
 *
 * The renderer hot-reloads through Vite as usual. Editing electron/ rebuilds
 * the CJS bundles and restarts Electron, which reconnects to the same dev
 * server, so the URL never changes.
 *
 *   npm run dev        this
 *   npm run dev:web    just the dev server, for a plain browser
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";
import { context } from "esbuild";
import { createServer } from "vite";

import { options } from "./build-electron.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const server = await createServer({ configFile: path.join(root, "vite.config.ts") });
await server.listen();
server.printUrls();

const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error("the dev server reported no local URL");

let child = null;
let restarting = false;
let shuttingDown = false;

function startElectron() {
  child = spawn(electronPath, [path.join(root, "dist-electron", "main.cjs")], {
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });
  child.on("exit", (code) => {
    child = null;
    // A restart kills the old process; only a real exit should end the session.
    if (restarting || shuttingDown) return;
    void shutdown(code ?? 0);
  });
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  child?.kill();
  await ctx.dispose();
  await server.close();
  process.exit(code);
}

function restartElectron() {
  if (restarting) return;
  restarting = true;
  const previous = child;
  child = null;
  previous?.kill();
  // Let the old process release the window before the new one claims it.
  setTimeout(() => {
    restarting = false;
    startElectron();
  }, 120);
}

/* Rebuilding main or preload means the running Electron is stale. */
const ctx = await context({
  ...options,
  logLevel: "warning",
  plugins: [{
    name: "restart-electron",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length) return;
        // The builds that happen before Electron is up are the initial ones.
        if (!child && !restarting) return;
        console.log("[electron] main changed — restarting");
        restartElectron();
      });
    },
  }],
});

await ctx.rebuild();
await ctx.watch();
startElectron();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(0));
}
