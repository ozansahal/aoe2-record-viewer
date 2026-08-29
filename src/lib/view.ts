import type { Mode } from "../types";

/**
 * Defaults for the per-tab view state that more than one place has to agree on.
 *
 * `w` is declared in three: the tab a recording opens into, App's read of the
 * active tab, and the Minimap's own prop default for the standalone case. They
 * are the same number by definition -- written out three times they are three
 * chances to change one and leave two.
 */

/**
 * How far back the map's window mode looks, in seconds.
 *
 * Two minutes rather than one. The window is read as "what has been fought
 * over lately", and a minute of a castle-age fight is a couple of engagements
 * -- short enough that the overlay emptied out between pushes and scrubbing
 * became the only way to find them. Two minutes holds a whole exchange.
 */
export const WINDOW_SECS = 120;

/**
 * The same number for decay mode, which reaches further back.
 *
 * The two modes read one field, but they do not want the same number out of
 * it. Window counts everything in range flat, so its length is the whole of
 * what it says and two minutes of flat counting is already a broad claim.
 * Decay weights by age: the far end of its range is nearly nothing, so most of
 * the extra minute is spent on a tail rather than on more equal-weighted
 * ground. Three minutes there costs about what two costs the flat window and
 * leaves a longer trail behind the fighting.
 */
export const DECAY_SECS = 180;

/** What each mode opens at, and what a mode switch snaps to. */
export const MODE_SECS: Record<Mode, number> = {
  cumulative: DECAY_SECS,
  window: WINDOW_SECS,
  decay: DECAY_SECS,
};

/**
 * The seconds to show after a mode switch, given what is on screen now.
 *
 * A default per mode and a single field to hold it means one of them has to
 * give when the mode changes. Snapping always would throw away a number the
 * user typed; never snapping would leave decay opening at the window's two
 * minutes for anyone who had ever touched window mode. So it snaps only from
 * a default: a value the user chose is theirs and survives the switch, and a
 * value they never touched is the previous mode's opinion and does not.
 */
export const secsForMode = (from: Mode, to: Mode, w: number) =>
  w === MODE_SECS[from] ? MODE_SECS[to] : w;
