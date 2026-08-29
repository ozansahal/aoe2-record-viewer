import { fmt } from "../lib/format";
import type { SortBy } from "../types";
import styles from "./ModeRow.module.css";
import ui from "../styles/ui.module.css";

/*
 * What the cards are counting, and how they are ordered.
 *
 * The cumulative/window pair used to live here too. It governs the map's
 * action overlay now, not the columns, so it sits in the map panel where its
 * effect is -- a control belongs next to the thing it changes.
 */
interface Props {
  sortBy: SortBy;
  onSortBy: (sortBy: SortBy) => void;
  /** The playhead. The cards count from zero to here, always. */
  hi: number;
}

export function ModeRow({ sortBy, onSortBy, hi }: Props) {
  return (
    <div className={styles.row}>
      <div className={styles.seg}>
        <button aria-pressed={sortBy === "time"} onClick={() => onSortBy("time")}>
          By time
        </button>
        <button aria-pressed={sortBy === "count"} onClick={() => onSortBy("count")}>
          By count
        </button>
      </div>

      <div className={ui.hint}>counting 0:00 – {fmt(hi)}</div>
    </div>
  );
}
