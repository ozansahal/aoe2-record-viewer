import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/*
 * Nothing in this app talks to the network -- parser, reference data and UI are
 * all bundled -- so the shipped page says so. Build only: the dev server needs
 * inline scripts for React Fast Refresh.
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' blob: data:",
    "worker-src 'self' blob:",
  ].join("; ");
  return {
    name: "aoe2:csp",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: () => [{
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: policy },
        injectTo: "head-prepend",
      }],
    },
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  /* Relative asset URLs, so one build works behind the dev server and behind
     Electron's app:// protocol. */
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    /* Only ever runs in Chromium: a dev browser or Electron's renderer. */
    target: "chrome126",
    sourcemap: true,
  },
  /* The parser runs in a module worker; classic workers cannot import. */
  worker: { format: "es" },
  server: { port: 5173, strictPort: true },
});
