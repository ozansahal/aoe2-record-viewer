import { useMemo } from "react";

import { ago, WHEN } from "../lib/format";
import type { SavedEntry } from "../lib/savedStore";
import { playedAt } from "../lib/summary";
import ui from "../styles/ui.module.css";
import { GameLine, Gutter, roster } from "./GameLine";
import styles from "./RecentGames.module.css";

/*
 * The last few games, on the page you land on.
 *
 * The summary answers "how am I doing" in periods and percentages, which is
 * the right shape for a month and the wrong one for the question you actually
 * arrive with -- which is "what did I just play", and after that, "open it".
 * So the handful of most recent recordings sit under the card, as rows you can
 * click.
 *
 * Deliberately short, and deliberately not the recordings page. There is no
 * filter, no folder, no file name, no size and no menu: those are all about
 * finding a recording among thousands, and this is the end of the list you
 * were already at. `Show all` is the way to the rest of them.
 */

/** How many rows. Long enough to be an evening, short enough not to be a list. */
const RECENT = 8;

interface Props {
  /** Everything kept, in whatever order the store handed it over. */
  entries: SavedEntry[];
  onOpen: (entry: SavedEntry) => void;
  /** The way to the recordings page, which is the whole of the list. */
  onShowAll: () => void;
  /** Recordings already in a tab, by name, so a row can say so. */
  openNames?: Set<string>;
  /** A parse is running; opening another one now would race it. */
  busy?: boolean;
}

export function RecentGames({ entries, onOpen, onShowAll, openNames, busy }: Props) {
  /* By when the game was, not by when it was parsed: the folder scan reads a
     hundred recordings in one pass and would otherwise put them all at the top
     in whatever order it happened to reach them. See `playedAt`. */
  const recent = useMemo(
    () => [...entries].sort((a, b) => playedAt(b) - playedAt(a)).slice(0, RECENT),
    [entries],
  );

  if (!recent.length) return null;

  return (
    <section className={styles.recent} aria-label="Last games">
      <div className={styles.head}>
        <span>Last games</span>
        <span className={ui.spacer} />
        <button className={ui.ghost} onClick={onShowAll}>
          Show all
          {entries.length > recent.length ? (
            <span className={styles.count}>{entries.length}</span>
          ) : null}
        </button>
      </div>
      <ul className={styles.list}>
        {recent.map((entry) => {
          const when = playedAt(entry);
          const open = openNames?.has(entry.name) ?? false;
          return (
            <li key={entry.id} className={styles.item}>
              <button
                className={open ? `${styles.row} ${styles.active}` : styles.row}
                disabled={busy}
                /* The line cuts a long roster off at the width, so the whole
                   of it lives here -- with the civs, and with who won. */
                title={roster(entry)}
                onClick={() => onOpen(entry)}
              >
                <Gutter entry={entry} />
                {/* The roster on a line of its own: this list is narrower
                    than the recordings page and its rows would otherwise
                    break between two players at whatever point the width
                    happened to fall. See `stack` in GameLine.tsx. */}
                <GameLine entry={entry} accent={open} stack />
                {/* How long ago, with the date itself on the tooltip: on this
                    page the answer is always "how recent is this", and the
                    calendar day is a lookup you would rather not do. */}
                <span className={styles.when} title={WHEN.format(new Date(when))}>
                  {ago(when)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
