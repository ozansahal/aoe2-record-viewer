import { useMemo, useState } from "react";

import { playerColor } from "../lib/format";
import type { Payload, SeriesRow } from "../types";
import styles from "./Sparkline.module.css";

const SPARK_W = 1000;
const SPARK_H = 44;

interface Props {
  payload: Payload;
  t: number;
  /** Which column of a SYNC sample to draw: 1 resources, 2 objects. */
  col: 1 | 2;
  title: string;
  unit: string;
}

function valueAt(rows: SeriesRow[], t: number): SeriesRow | null {
  let hit: SeriesRow | null = null;
  for (const r of rows) {
    if (r[0] > t) break;
    hit = r;
  }
  return hit;
}

/*
 * Both series come from the SYNC stat samples, and mgz documents those field
 * offsets as guesses -- so these are drawn as trend shapes to compare, with no
 * value axis. `total_resources` is food+wood+gold+stone summed, with no
 * per-resource split; `total_objects` counts everything owned, foundations
 * included, so it tracks army plus buildings rather than army alone. Each
 * sparkline scales to its own peak; the shapes compare, the heights do not.
 *
 * ---- folded by default ----
 *
 * The plots are a second opinion, not the page: what you read off them most of
 * the time is the pair of figures at the playhead, and those stay on the row
 * folded. So the figures sit *in* the heading rather than under it -- folded,
 * the whole thing is one line carrying its own value, which is what makes a
 * fold worth having. Folded, the path geometry is not built either -- the memo
 * below short-circuits, so a closed sparkline costs a heading and two numbers.
 */
export function Sparkline({ payload, t, col, title, unit }: Props) {
  /* Closed to start, and per component rather than per tab: which of the two
     you have unfolded is about the question you are asking right now, not
     something about the recording worth carrying between tabs. Same reasoning
     the map's own fold uses -- see Minimap. */
  const [open, setOpen] = useState(false);

  const series = useMemo(
    () => (payload.series || []).filter((s) => s.rows && s.rows.length),
    [payload],
  );
  const byPlayer = useMemo(
    () => new Map(payload.players.map((p) => [p.number, p])),
    [payload],
  );

  // Path geometry depends only on the recording, so it survives every scrub.
  const paths = useMemo(() => {
    if (!open || !series.length || !payload.duration) return [];
    const peak = Math.max(1, ...series.map((s) => Math.max(...s.rows.map((r) => r[col]))));
    return series.map((s) => {
      const p = byPlayer.get(s.player);
      const d = s.rows
        .map((r, i) =>
          (i ? "L" : "M")
          + (SPARK_W * r[0] / payload.duration).toFixed(1)
          + " "
          + (SPARK_H - SPARK_H * r[col] / peak).toFixed(1))
        .join(" ");
      return { player: s.player, d, stroke: p ? playerColor(p) : "currentColor" };
    });
  }, [open, series, byPlayer, payload.duration, col]);

  const nothing = !series.length || !payload.duration;
  const head = nothing ? "0" : (SPARK_W * t / payload.duration).toFixed(1);

  return (
    <div className={styles.spark}>
      {/* One line: the name, then the figures. */}
      <div className={styles.head}>
        {/* The heading is the fold, exactly as the map's is -- and it keeps the
            heading's type, so the two of them still read as one list. */}
        <button
          type="button"
          className={styles.title}
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
        >
          <span className={open ? styles.caretOpen : styles.caret} aria-hidden="true">▸</span>
          {title}
        </button>
        {/* The figures at the playhead stay whether the plot is drawn or not:
            they are the part of the row you read every scrub, so they belong
            on the line that survives the fold. */}
        {nothing ? null : (
          <span className={styles.vals}>
            {series.map((s) => {
              const p = byPlayer.get(s.player);
              const row = valueAt(s.rows, t);
              const value = row ? row[col] : null;
              return (
                <span
                  key={s.player}
                  style={{ color: p ? playerColor(p) : "inherit" }}
                  title={`${p ? p.name : "?"} — ${(value ?? 0).toLocaleString()} ${unit}`}
                >
                  {value === null ? "—" : value.toLocaleString()}
                </span>
              );
            })}
          </span>
        )}
      </div>
      {open ? (
        <div className={styles.plot}>
          {nothing ? (
            <div className={styles.empty}>no sync samples in this file</div>
          ) : (
            <svg
              viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
              preserveAspectRatio="none"
              height={SPARK_H}
              role="img"
              aria-label={`${title} over time, one line per player`}
            >
              {paths.map((path) => (
                <path
                  key={path.player}
                  d={path.d}
                  fill="none"
                  stroke={path.stroke}
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              <line
                x1={head}
                y1={-2}
                x2={head}
                y2={SPARK_H + 2}
                stroke="var(--ink-dim)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                opacity=".55"
              />
            </svg>
          )}
        </div>
      ) : null}
    </div>
  );
}
