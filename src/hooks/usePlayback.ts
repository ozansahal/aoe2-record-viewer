import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Playback for the scrubber: the playhead walking forward on a timer.
 *
 * It lives beside the playhead rather than owning it -- the tab's `t` is still
 * the one truth, and this only seeks it like a drag or an arrow key would, so
 * everything downstream (the cards, the map, the sparklines) needs to know
 * nothing about playback at all.
 *
 * A timer and a wall-clock delta rather than requestAnimationFrame: the rate
 * that matters is game seconds per real second, so a missed or throttled frame
 * has to leave the playhead where the clock says it is, not where the frame
 * count does.
 */

/** How often the playhead is advanced. Fine enough to look continuous. */
const TICK_MS = 80;

/** Game seconds per real second, in the order the button cycles them. */
export const SPEEDS: number[] = [1, 2, 4, 8, 16, 32];

/* A match runs the better part of an hour, and the cards move in minutes
   rather than seconds, so real time is a poor place to start watching from. */
export const DEFAULT_SPEED = 8;

/** The next speed in the cycle, wrapping at the top. */
export function nextSpeed(speed: number): number {
  const i = SPEEDS.indexOf(speed);
  return SPEEDS[(i + 1) % SPEEDS.length];
}

export interface Playback {
  playing: boolean;
  /** Play, pause, or -- at the end of the match -- start again from zero. */
  toggle: () => void;
  pause: () => void;
}

interface Options {
  /** The playhead, in game seconds. Whole seconds: the slider steps by one. */
  t: number;
  duration: number;
  speed: number;
  onSeek: (t: number) => void;
}

export function usePlayback({ t, duration, speed, onSeek }: Options): Playback {
  const [playing, setPlaying] = useState(false);

  /* Where playback has actually got to, at sub-second resolution. `t` is whole
     seconds, so at 1x a tick's worth of movement would round straight back to
     where it started and the playhead would never leave. */
  const pos = useRef(t);
  /* The last value this hook seeked to. Anything else in `t` came from
     somewhere else -- a drag, an arrow key, the HUD -- and playback follows it
     rather than dragging the playhead back to its own idea of now. */
  const written = useRef(t);
  if (t !== written.current) {
    written.current = t;
    pos.current = t;
  }

  /* Read inside the timer, so changing the speed or seeking does not restart
     it -- a restarted interval is a dropped tick, and at 32x that is visible. */
  const latest = useRef({ duration, speed, onSeek });
  latest.current = { duration, speed, onSeek };

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const elapsed = (now - last) / 1000;
      last = now;
      const { duration: end, speed: rate, onSeek: seek } = latest.current;
      pos.current = Math.min(end, pos.current + elapsed * rate);
      const next = Math.floor(pos.current);
      if (next !== written.current) {
        written.current = next;
        seek(next);
      }
      if (pos.current >= end) setPlaying(false);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing]);

  const pause = useCallback(() => setPlaying(false), []);

  const toggle = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    /* Pressing play at the end of the match replays it, rather than being a
       button that does nothing. */
    if (pos.current >= duration) {
      pos.current = 0;
      written.current = 0;
      onSeek(0);
    }
    setPlaying(true);
  }, [playing, duration, onSeek]);

  return { playing, toggle, pause };
}
