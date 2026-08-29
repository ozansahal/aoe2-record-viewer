import { useMemo } from "react";

import { useSeek } from "../hooks/useSeek";
import { fmt, playerColor } from "../lib/format";
import type { ItemTally, Player, SortBy } from "../types";
import styles from "./CategoryColumn.module.css";

interface Props {
  label: string;
  varname: string;
  items: Map<string, ItemTally>;
  sortBy: SortBy;
  /** Opponents who also hold this item by now. Only techs pass one in. */
  alsoHeldBy?: (item: string) => Player[];
}

export function CategoryColumn({ label, varname, items, sortBy, alsoHeldBy }: Props) {
  /* Null outside a match, where the column is drawn with no playhead to move.
     The time is a plain label then rather than a button that does nothing. */
  const seek = useSeek();

  const rows = useMemo(() => {
    const entries = [...items.entries()];
    entries.sort(sortBy === "time"
      ? (a, b) => a[1].first - b[1].first || a[0].localeCompare(b[0])
      : (a, b) => b[1].qty - a[1].qty || a[1].first - b[1].first);
    return entries;
  }, [items, sortBy]);

  const total = rows.reduce((sum, [, v]) => sum + v.qty, 0);

  return (
    <div className={styles.cat} style={{ ["--cc" as string]: `var(${varname})` }}>
      <h3>{label}</h3>
      <div className={styles.total}>{total}</div>
      <div className={styles.distinct}>{rows.length} distinct</div>
      {rows.length ? (
        <ul>
          {rows.map(([item, v]) => {
            const span = v.last !== v.first ? `${fmt(v.first)}–${fmt(v.last)}` : fmt(v.first);
            const also = alsoHeldBy ? alsoHeldBy(item) : [];
            /* The recording named this line after its base unit; say so, and
               say which researches renamed it, so a row of Champions counted
               from before Champion existed still reads honestly. */
            const upgrade = v.base
              ? `; trained as ${v.base}, upgraded via `
                + (v.via || []).map((u) => `${u.name} ${fmt(u.t)}`).join(", ")
              : "";
            /* The bracket beside the count is two characters and a number, so
               the row says what they are: plots this player sowed a second
               time, held apart from the count of the plots themselves.
               Farms only -- `rebuilds` is set nowhere else (see `occupancy()`
               in `src/parser/filter_events.ts`), so there is no "rebuilt"
               wording here any more. It had no true cases: a recording never
               says a building stopped standing, and what the old arm counted
               was a player mashing the placement. */
            const again = v.rebuilds
              ? `; +${v.rebuilds} re-seeded`
                + " — sown again on a plot already used, not counted above"
              : "";
            const tip = `${item} — ${v.qty > 1 ? `${v.qty}× over ${span}` : `at ${span}`}`
              + (also.length ? `; also held by ${also.map((o) => o.name).join(", ")}` : "")
              + upgrade + again;
            return (
              <li key={item} title={tip}>
                {/* The first of them, and where the playhead goes when you
                    click it. No `title` of its own: the row already has one
                    saying what this line is, and a second tooltip over two
                    words of it would replace that with something shorter.
                    The visible text is `8:20`, which reads as four digits
                    with no verb, so the label supplies the verb. */}
                {seek ? (
                  <button
                    type="button"
                    className={styles.tm}
                    aria-label={`Seek to ${fmt(v.first)}`}
                    onClick={() => seek(v.first)}
                  >
                    {fmt(v.first)}
                  </button>
                ) : (
                  <span className={styles.tm}>{fmt(v.first)}</span>
                )}
                <span className={styles.nm}>{item}</span>
                {v.base ? <span className={styles.up}>↑</span> : null}
                {also.length ? (
                  <span className={styles.shared}>
                    {also.map((o) => (
                      <i key={o.number} style={{ background: playerColor(o) }} />
                    ))}
                  </span>
                ) : null}
                {v.qty > 1 ? <b>×{v.qty}</b> : null}
                {v.rebuilds ? <span className={styles.again}>(+{v.rebuilds})</span> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={styles.none}>none</div>
      )}
    </div>
  );
}
