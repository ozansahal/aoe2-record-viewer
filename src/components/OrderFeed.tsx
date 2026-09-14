import { useMemo } from "react";
import type { Order, Payload, Player } from "../types";
import { fmt, playerColor } from "../lib/format";
import { latest, ordersByPlayer } from "../lib/orders";
import styles from "./OrderFeed.module.css";

interface Props {
  payload: Payload;
  /** The players this column shows, in order. */
  players: Player[];
  /** The playhead, in seconds. */
  t: number;
  /** Rows per player. */
  rows: number;
  /** Which margin of the map this sits in; the right one aligns its text right. */
  side: "left" | "right";
}

/**
 * Where the feed's rows come from, memoised per payload rather than per
 * column: the two margins would otherwise each walk the whole event list.
 */
const feeds = new WeakMap<Payload, Map<number, Order[]>>();
function feedFor(payload: Payload): Map<number, Order[]> {
  let feed = feeds.get(payload);
  if (!feed) {
    feed = ordersByPlayer(payload);
    feeds.set(payload, feed);
  }
  return feed;
}

/**
 * The last few things each player ordered, as of the playhead, newest at the
 * top. One block per player, and the block slides: a new row enters at the
 * top and pushes the rest down, so on playback the column reads as a ticker
 * of what the player is doing right now.
 *
 * Builds, techs and units are the rows the cards count; deletes are struck
 * through, since they take something off the map; an attack is the size of
 * the selection it was given to. See lib/orders.ts for how those two are
 * derived.
 */
export function OrderFeed({ payload, players, t, rows, side }: Props) {
  const feed = useMemo(() => feedFor(payload), [payload]);
  if (!players.length) return null;
  return (
    <div className={`${styles.feed} ${styles[side]}`} aria-label="Latest orders">
      {players.map((p) => {
        const orders = feed.get(p.number);
        const shown = orders ? latest(orders, t, rows) : [];
        return (
          <section key={p.number} className={styles.player}>
            <h4 className={styles.name} style={{ color: playerColor(p) }}>{p.name}</h4>
            <ol className={styles.rows}>
              {shown.length ? shown.map((o) => (
                <li key={o.id} className={`${styles.row} ${styles[o.kind]}`}>
                  <span className={styles.when}>{fmt(o.t)}</span>
                  <span className={styles.label}>{o.label}</span>
                  {o.kind === "attack"
                    ? (o.qty ? <span className={styles.qty}>{o.qty} {o.qty === 1 ? "unit" : "units"}</span> : null)
                    : o.qty > 1 ? <span className={styles.qty}>×{o.qty}</span> : null}
                </li>
              )) : <li className={`${styles.row} ${styles.none}`}>No orders yet</li>}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
