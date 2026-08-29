/**
 * Bundle the Electron main process and preload script.
 *
 * esbuild rather than Vite: these are two small Node entry points with no
 * assets, and the renderer's build config has nothing useful to say about them.
 * Output is CommonJS -- a sandboxed preload must be CJS, and package.json says
 * "type": "module", so the .cjs extension is what makes Node agree.
 */
import { build, context } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {import("esbuild").BuildOptions} */
export const options = {
  entryPoints: {
    main: path.join(root, "electron", "main.ts"),
    preload: path.join(root, "electron", "preload.ts"),
  },
  outdir: path.join(root, "dist-electron"),
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  /* Provided by the runtime, not bundled. */
  external: ["electron"],
  logLevel: "info",
};

export async function buildElectron({ watch = false } = {}) {
  if (!watch) return build(options);
  const ctx = await context(options);
  await ctx.watch();
  return ctx;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildElectron({ watch: process.argv.includes("--watch") });
}
