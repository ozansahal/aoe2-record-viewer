/**
 * Interface zoom.
 *
 * `webContents.setZoomFactor` scales the whole renderer, title bar included,
 * which is what the setting is for: the tables of units and techs are dense,
 * and the answer on a 4K panel is "make it all bigger", not a font size
 * somewhere in the app.
 *
 * The factor is remembered across launches and applied to every window, so a
 * second one does not open at 100% next to a first one at 150%.
 *
 * Chromium resets the factor on a navigation, so it is re-applied on every
 * `did-finish-load` rather than once when the window is built -- otherwise a
 * dev-server reload would silently drop back to 100%.
 */
import type { BrowserWindow, WebContents } from "electron";

import { readSettings, writeSettings } from "./settings";

const SETTING = "zoomFactor";

/** Chromium's own ladder, which is what Ctrl+= steps through in a browser. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const DEFAULT_ZOOM = 1;
const MIN = ZOOM_STEPS[0];
const MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** The live value. Read from disk once, at startup, by `loadZoom`. */
let factor: number = DEFAULT_ZOOM;

const clamp = (value: number) => Math.min(MAX, Math.max(MIN, value));

/** Anything that is not a usable factor becomes the default rather than an error. */
function sane(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? clamp(value)
    : DEFAULT_ZOOM;
}

export function currentZoom(): number {
  return factor;
}

/** Once, before the first window: `app.whenReady` is early enough. */
export async function loadZoom(): Promise<number> {
  factor = sane((await readSettings())[SETTING]);
  return factor;
}

/** Chromium drops the factor on every navigation, so re-apply it after each. */
export function applyZoom(contents: WebContents): void {
  contents.setZoomFactor(factor);
}

/**
 * The new factor, applied to every open window and saved. Returns what it
 * settled on, which is the clamped value and not necessarily what was asked
 * for -- callers show that rather than what they sent.
 */
export function setZoom(windows: BrowserWindow[], value: number): number {
  const next = sane(value);
  if (next === factor) return factor;
  factor = next;
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    win.webContents.setZoomFactor(factor);
    win.webContents.send("aoe2:zoom-changed", factor);
  }
  void writeSettings({ [SETTING]: factor });
  return factor;
}

/**
 * One notch up or down the ladder. Nudges rather than snapping: from a factor
 * between two steps, the next step in that direction is the one past it.
 */
export function stepZoom(windows: BrowserWindow[], direction: 1 | -1): number {
  const epsilon = 1e-6;
  const next = direction === 1
    ? ZOOM_STEPS.find((step) => step > factor + epsilon)
    : [...ZOOM_STEPS].reverse().find((step) => step < factor - epsilon);
  return setZoom(windows, next ?? factor);
}
