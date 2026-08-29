import { useMemo, useRef } from "react";

import { FloatingScrubber } from "./FloatingScrubber";
import { useNativeWheel } from "./useNativeWheel";
import { fmt, playerColor } from "../lib/format";
import type { Payload } from "../types";
import styles from "./Scrubber.module.css";

interface Props {
  payload: Payload;
  t: number;
  onSeek: (t: number) => void;
  onNudge: (seconds: number) => void;
  playing: boolean;
  onPlayPause: () => void;
  /** Game seconds per real second while playing. */
  speed: number;
  /** Steps to the next speed in the cycle. */
  onSpeed: () => void;
}

interface Tick {
  key: string;
  fraction: number;
  color: string;
  title: string;
  t: number;
  /** 0 above the track, 1 below. */
  seat: number;
}

/*
 * The transport, docked across the bottom of the window.
 *
 * The bar itself is `FloatingScrubber`: it draws the pill and owns every
 * button in it -- play, speed, the two nudges and the two jumps. All this adds
 * is the track, handed in as the pill's last item, so there is one pill on
 * screen and one place the controls are written.
 */
export function Scrubber({
  payload, t, onSeek, onNudge, playing, onPlayPause, speed, onSpeed,
}: Props) {
  const track = useRef<HTMLDivElement>(null);

  // Wheel over the scrubber scrubs rather than scrolling the page. Uses the
  // sign only, so a trackpad's variable deltas step as evenly as a mouse notch.
  // Deliberately finer than the clock's own wheel over in FloatingScrubber:
  // the track is the continuous control, so a notch here is a nudge.
  useNativeWheel(track, (event) => {
    event.preventDefault();
    onNudge((event.deltaY < 0 ? 1 : -1) * (event.shiftKey ? 60 : 5));
  });

  const ticks = useMemo<Tick[]>(() => {
    if (!payload.duration) return [];
    const byPlayer = new Map(payload.players.map((p) => [p.number, p]));
    return (payload.ages || []).map((a, i) => {
      const p = byPlayer.get(a.player);
      // Players reach the same age seconds apart, so one shared row would
      // collide. Split by player across the track: first above, second below,
      // alternating beyond that.
      const seat = Math.max(0, payload.players.findIndex((x) => x.number === a.player)) % 2;
      return {
        key: `${a.player}-${a.age}-${a.t}-${i}`,
        fraction: a.t / payload.duration,
        color: p ? playerColor(p) : "var(--ink-faint)",
        title: `${p ? p.name : "?"} reached ${a.age} at ${fmt(a.t)}`,
        t: a.t,
        seat,
      };
    });
  }, [payload]);

  /* A drawn triangle rather than a numeral or a caret glyph. A numeral was
     three monospace glyphs pretending to be one token, and which age a mark is
     is on its tooltip anyway. A caret *character* replaced it and brought the
     problem type always brings to a mark: most of its box is bearing and
     leading, so making the triangle bigger made the strip much bigger than the
     triangle and pushed it out of the bar. Drawn, the box is the shape, and
     the strip is exactly as tall as the mark in it.

     The mark is the button. It points at the track from whichever side its
     player sits on, so the strip reads as marks on a timeline rather than a
     row of labels above one. */
  const strip = (seat: number, side: string) => (
    <div className={`${styles.ticks} ${side}`}>
      {ticks.filter((tick) => tick.seat === seat).map((tick) => (
        /* The mark is also the way to the moment it marks: an age is the one
           time in a match everything else is dated against, so going to it
           should not mean finding it again on the track by hand. Same seek the
           age chip over a player card does. */
        <button
          key={tick.key}
          type="button"
          className={tick.t > t ? `${styles.tick} ${styles.future}` : styles.tick}
          style={{ ["--f" as string]: tick.fraction, color: tick.color }}
          title={tick.title}
          aria-label={`Seek to ${tick.title}`}
          onClick={() => onSeek(tick.t)}
        />
      ))}
    </div>
  );

  return (
    <div className={styles.dock}>
      <FloatingScrubber
        t={t}
        onNudge={onNudge}
        onStart={() => onSeek(0)}
        onEnd={() => onSeek(payload.duration)}
        playing={playing}
        onPlayPause={onPlayPause}
        speed={speed}
        onSpeed={onSpeed}
        track={
          <div className={styles.track} ref={track}>
            {strip(0, styles.above)}
            <input
              type="range"
              min={0}
              max={payload.duration}
              step={1}
              value={t}
              aria-label="Playhead"
              onChange={(e) => onSeek(Number(e.target.value))}
            />
            {strip(1, styles.below)}
          </div>
        }
      />
    </div>
  );
}
