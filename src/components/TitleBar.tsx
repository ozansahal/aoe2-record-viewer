import { useEffect, useState } from "react";

import iconUrl from "../../assets/icon.png";
import { usePlatform } from "../platform/context";
import styles from "./TitleBar.module.css";

/*
 * The window's title bar, drawn by the app rather than by Windows.
 *
 * The bar itself is one big drag region -- `-webkit-app-region: drag` in the
 * stylesheet -- which is also what gives it the native double-click to
 * maximize. The buttons opt back out, or they would be draggable instead of
 * clickable.
 */

/** 10x10 glyphs a pixel thick, the metrics Windows draws its own at. */
const MINIMIZE = "M0 5.5h10";
const MAXIMIZE = "M.5.5h9v9h-9z";
/** The restored window: the one behind, then the one in front over it. */
const RESTORE = "M2.5 2.5v-2h7v7h-2M.5 2.5h7v7h-7z";
const CLOSE = "M.5.5l9 9M9.5.5l-9 9";
/** Zoom, in the same 10x10 grid: a bar, and a bar with an upright across it. */
const ZOOM_OUT = "M1.5 5.5h7";
const ZOOM_IN = "M1.5 5.5h7M5 2v7";

function Glyph({ d }: { d: string }) {
  return (
    /* Drawn at 12.5 rather than 10 -- the size the whole interface is set at,
       which is the old 10 at 125%. The grid stays 10 units, so the stroke
       thickens with it the way every hairline in the stylesheet does. */
    <svg viewBox="0 0 10 10" width="12.5" height="12.5" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1">
      <path d={d} />
    </svg>
  );
}

/**
 * Interface zoom, as three small buttons: out, the factor, in.
 *
 * The factor is a button rather than a label because it is also the way back
 * to 100% -- the same click the shortcut Ctrl+0 is. Every change comes back
 * from the main process through `onChange`, the keyboard ones included, so
 * this shows what the window is actually at rather than what it last asked
 * for.
 */
function ZoomControl() {
  const zoom = usePlatform().zoom;
  const [factor, setFactor] = useState(1);

  useEffect(() => {
    if (!zoom) return;
    void zoom.get().then(setFactor);
    return zoom.onChange(setFactor);
  }, [zoom]);

  if (!zoom) return null;

  const percent = Math.round(factor * 100);
  return (
    <div className={styles.zoom}>
      <button
        className={styles.btn}
        onClick={() => void zoom.step(-1).then(setFactor)}
        aria-label="Zoom out"
        title="Zoom out (Ctrl+-)"
      >
        <Glyph d={ZOOM_OUT} />
      </button>
      {/* Fixed width, or stepping past 100% would shuffle the buttons beside it. */}
      <button
        className={`${styles.btn} ${styles.level}`}
        onClick={() => void zoom.reset().then(setFactor)}
        /* At 100% there is nothing to reset, so the label does not offer it --
           the button stays put rather than disappearing, or the two beside it
           would move every time the zoom passed through 100%. */
        aria-label={percent === 100 ? "Zoom 100%" : `Zoom ${percent}%. Reset to 100%`}
        title="Reset zoom (Ctrl+0)"
      >
        {percent}%
      </button>
      <button
        className={styles.btn}
        onClick={() => void zoom.step(1).then(setFactor)}
        aria-label="Zoom in"
        title="Zoom in (Ctrl++)"
      >
        <Glyph d={ZOOM_IN} />
      </button>
    </div>
  );
}

export function TitleBar({ title }: { title: string }) {
  const controls = usePlatform().windowControls;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    void controls.isMaximized().then(setMaximized);
    return controls.onMaximizedChange(setMaximized);
  }, [controls]);

  if (!controls) return null; // a browser: the page keeps its own <h1>

  // macOS puts its traffic lights over the top-left corner of the page.
  const mac = controls.platform === "darwin";

  return (
    <div className={mac ? `${styles.titlebar} ${styles.mac}` : styles.titlebar}>
      {/* Decorative -- the name says it in words. `draggable` off, or the
          browser's own image drag would start instead of the window's. */}
      <img className={styles.icon} src={iconUrl} alt="" draggable={false} />
      <span className={styles.name}>{title}</span>
      <ZoomControl />
      {mac ? null : (
        <div className={styles.controls}>
          <button
            className={styles.btn}
            onClick={() => void controls.minimize()}
            aria-label="Minimize"
            title="Minimize"
          >
            <Glyph d={MINIMIZE} />
          </button>
          <button
            className={styles.btn}
            onClick={() => void controls.toggleMaximize().then(setMaximized)}
            aria-label={maximized ? "Restore" : "Maximize"}
            title={maximized ? "Restore" : "Maximize"}
          >
            <Glyph d={maximized ? RESTORE : MAXIMIZE} />
          </button>
          <button
            className={`${styles.btn} ${styles.close}`}
            onClick={() => void controls.close()}
            aria-label="Close"
            title="Close"
          >
            <Glyph d={CLOSE} />
          </button>
        </div>
      )}
    </div>
  );
}
