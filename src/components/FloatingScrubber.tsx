import { useRef, type ReactNode } from "react";

import { PlayButton } from "./PlayButton";
import { useHoldRepeat } from "./useHoldRepeat";
import { useNativeWheel } from "./useNativeWheel";
import { fmt } from "../lib/format";
import styles from "./FloatingScrubber.module.css";

/** A tap steps this far; shift jumps a minute. */
const HUD_STEP = 10;

/* The wheel over the clock is deliberately coarser than the track's 5s / 60s.
   The track is the continuous control and a notch on it is a nudge; a notch
   here is meant to cover ground, which is what you reach for the clock for.
   Half a minute, and five with shift, which puts either end of a match a
   comfortable flick away. */
const WHEEL_STEP = 30;
const WHEEL_STEP_SHIFT = 300;

/*
 * Jump to an end of the match.
 *
 * Drawn rather than typed. U+23EE and U+23ED are *double* triangles with a
 * bar -- three shapes crowded into a 16px box, and beside the single triangle
 * on the step button next to them they read as a different family of control
 * altogether. One triangle and one bar is what the pair actually does.
 *
 * `currentColor`, so it takes the accent fill on hover with everything else.
 */
function Jump({ back }: { back: boolean }) {
  return (
    <svg className={styles.glyph} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {/* The forward one is the same drawing mirrored, which is the only way
          the two are guaranteed to weigh the same on either side of the clock. */}
      <g transform={back ? undefined : "translate(24 0) scale(-1 1)"}>
        <rect x="3.4" y="4.2" width="3.2" height="15.6" rx="1.4" />
        <path d="M20.6 4.2v15.6L8.4 12z" />
      </g>
    </svg>
  );
}

interface Props {
  t: number;
  onNudge: (seconds: number) => void;
  /** Jump to the start of the match. */
  onStart: () => void;
  /** Jump to the end of it. */
  onEnd: () => void;
  playing: boolean;
  onPlayPause: () => void;
  /** Game seconds per real second while playing. */
  speed: number;
  /** Steps to the next speed in the cycle. */
  onSpeed: () => void;
  /** The slider and its age marks, laid into the pill after the buttons. */
  track?: ReactNode;
}

/*
 * The pill, and every control in it.
 *
 * It used to float over the bottom-right corner once the scrubber's track had
 * scrolled out of view. The track does not scroll away any more -- it is in
 * here, docked across the bottom of the window by `Scrubber` -- so this is the
 * transport rather than a stand-in for one. Two pills, one of them a copy of
 * the other's buttons, is what the alternative looked like.
 */
export function FloatingScrubber({
  t, onNudge, onStart, onEnd, playing, onPlayPause, speed, onSpeed, track,
}: Props) {
  const back = useHoldRepeat((shift) => onNudge(-(shift ? 60 : HUD_STEP)));
  const forward = useHoldRepeat((shift) => onNudge(shift ? 60 : HUD_STEP));
  const time = useRef<HTMLSpanElement>(null);

  /* The clock is the one thing in the pill that reads as the playhead itself,
     so it is where a wheel belongs. Sign only, like the track: a trackpad's
     variable deltas would otherwise fling minutes past where the same gesture
     on a mouse steps one notch. Non-passive, or preventDefault is ignored and
     the page scrolls out from under the cursor. */
  useNativeWheel(time, (event) => {
    event.preventDefault();
    onNudge((event.deltaY < 0 ? 1 : -1) * (event.shiftKey ? WHEEL_STEP_SHIFT : WHEEL_STEP));
  });

  return (
    <div className={styles.hud}>
      {/* First, and set off by a rule: play and speed are the two controls here
          that do not move the playhead by a known amount, and play shares an
          arrow with the buttons beside it. */}
      <PlayButton playing={playing} onToggle={onPlayPause} className={styles.play} />
      <button
        type="button"
        className={styles.speed}
        title="Playback speed — game seconds per second"
        aria-label={`Playback speed ${speed} times`}
        onClick={onSpeed}
      >
        {speed}&times;
      </button>
      <span className={styles.rule} />
      {/* The two ends of the match, outside the pair that steps: they are the
          only buttons in the row that go somewhere absolute, so they sit at
          the outside of the group and never repeat on a hold. */}
      <button
        type="button"
        aria-label="Jump to the start"
        title="Start of the match"
        onClick={onStart}
      >
        <Jump back />
      </button>
      <button
        aria-label="Step back"
        title="Back — hold to scrub, shift for minutes"
        {...back}
      >
        ◀
      </button>
      <span
        ref={time}
        className={styles.time}
        title="Scroll to scrub — shift for five-minute jumps"
      >
        {fmt(t)}
      </span>
      <button
        aria-label="Step forward"
        title="Forward — hold to scrub, shift for minutes"
        {...forward}
      >
        ▶
      </button>
      <button
        type="button"
        aria-label="Jump to the end"
        title="End of the match"
        onClick={onEnd}
      >
        <Jump back={false} />
      </button>
      {track ? (
        <>
          <span className={styles.rule} />
          {track}
        </>
      ) : null}
    </div>
  );
}
