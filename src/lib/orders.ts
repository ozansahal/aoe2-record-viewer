import type { Minimap, MinimapBuild, Order, OrderKind, Payload } from "../types";
import { KIND } from "./minimap";

/**
 * Two attack marks by the same player closer together than this are one
 * burst -- one push, re-aimed as it goes -- and the feed shows them as one
 * row. Eight seconds is about how long a human leaves a selection alone
 * before clicking again on the same fight.
 */
const BURST_GAP = 8;

/**
 * Unit orders for the same unit closer together than this are one row. A
 * player filling a queue clicks five times in two seconds, and the recording
 * holds five orders; the feed says "Militia ×25" once. Builds and techs are
 * already folded by the exporter's dedupe window, so this is units only.
 */
const QUEUE_GAP = 5;

/**
 * Everything each player ordered, as one list per player sorted by time.
 *
 * The viewer's `events` are three of the five kinds already -- builds, techs
 * and units -- and the other two are taken off the minimap: a building
 * deletion, named by the last order the player placed on that anchor, and a
 * military order, with the size of the selection it was given to. Neither is
 * in `events` because neither counts towards anything; they are in the feed
 * because "what did they just do" includes them.
 *
 * `id` is the row's place in this list, and it is what a rendered row is keyed
 * by: it never changes while the payload is the one on screen, so a row that
 * stays in the window across a seek stays the same element.
 */
export function ordersByPlayer(payload: Payload): Map<number, Order[]> {
  const all: Order[] = [];
  const queued = new Map<number, Order>();
  for (const e of payload.events) {
    const last = e.cat === "unit" ? queued.get(e.player) : undefined;
    if (last && last.label === e.item && e.t - last.t <= QUEUE_GAP) {
      last.qty += e.qty;
      last.t = e.t;
      continue;
    }
    const row: Order = { id: 0, t: e.t, player: e.player, kind: e.cat, label: e.item, qty: e.qty };
    all.push(row);
    if (e.cat === "unit") queued.set(e.player, row);
  }
  const map = payload.minimap;
  if (map) {
    for (const d of map.deletes ?? []) {
      all.push({ id: 0, t: d.t, player: d.player, kind: "delete", label: nameAt(map, d), qty: 1 });
    }
    all.push(...attackBursts(map));
  }
  all.sort((a, b) => a.t - b.t);
  const out = new Map<number, Order[]>();
  all.forEach((order, i) => {
    order.id = i;
    const list = out.get(order.player);
    if (list) list.push(order);
    else out.set(order.player, [order]);
  });
  return out;
}

/**
 * What stood on the anchor a delete resolved to: the latest build order the
 * same player placed there before the delete, else the starting building the
 * anchor belongs to. The starting set carries a kind and not a name, so those
 * come out generic -- except the Town Centre, whose anchor `starts` names.
 */
function nameAt(map: Minimap, at: { t: number; player: number; x: number; y: number }): string {
  let last: MinimapBuild | undefined;
  for (const b of map.builds) {
    if (b.t > at.t) break;
    if (b.player === at.player && b.x === at.x && b.y === at.y) last = b;
  }
  if (last) return last.item;
  for (const s of map.starts) {
    if (s.player !== at.player) continue;
    if (s.x === at.x && s.y === at.y) return "Town Center";
    const kinds = s.kinds;
    if (!kinds) continue;
    for (let i = 0; i + 1 < s.buildings.length; i += 2) {
      if (s.buildings[i] !== at.x || s.buildings[i + 1] !== at.y) continue;
      const kind = kinds[i / 2];
      if (kind === KIND.farm) return "Farm";
      if (kind === KIND.castle) return "Castle";
      if (kind === KIND.keep) return "Tower";
    }
  }
  return "Building";
}

/**
 * The military orders, grouped into bursts per player.
 *
 * The count is the most units under orders at any one second of the burst:
 * the AI's one-unit orders in the same second add up to the group they were
 * given to, while a human re-aiming the same forty units every few seconds is
 * still forty, not forty times the clicks. A payload parsed before the count
 * was carried has no `n`, and the row says "Attack" with no figure.
 */
function attackBursts(map: Minimap): Order[] {
  const a = map.attacks;
  if (!a) return [];
  const order: number[] = Array.from(a.t.keys()).sort((i, j) => a.t[i]! - a.t[j]!);
  const open = new Map<number, { row: Order; last: number; second: number; inSecond: number }>();
  const out: Order[] = [];
  for (const i of order) {
    const t = a.t[i]!;
    const player = a.player[i]!;
    const units = a.n ? a.n[i]! : 0;
    const burst = open.get(player);
    if (burst && t - burst.last <= BURST_GAP) {
      burst.last = t;
      if (t === burst.second) burst.inSecond += units;
      else { burst.second = t; burst.inSecond = units; }
      burst.row.qty = Math.max(burst.row.qty, burst.inSecond);
      continue;
    }
    const row: Order = { id: 0, t, player, kind: "attack", label: "Attack", qty: units };
    out.push(row);
    open.set(player, { row, last: t, second: t, inSecond: units });
  }
  return out;
}

/**
 * The last `n` orders at or before `t`, newest first. A binary search for the
 * edge, since this runs on every playhead move for every player.
 */
export function latest(orders: Order[], t: number, n: number): Order[] {
  let lo = 0;
  let hi = orders.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (orders[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  const out: Order[] = [];
  for (let i = lo - 1; i >= 0 && out.length < n; i--) out.push(orders[i]!);
  return out;
}

export type { Order, OrderKind };
