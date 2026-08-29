import type { CategoryTally, Payload, Player } from "../types";
import { currentUnit } from "./unitLines";

/**
 * Count every event inside [lo, hi] per player and category.
 *
 * Keeping first/last alongside the quantity lets rows sort chronologically and
 * show a time, so the list stays put while scrubbing instead of reshuffling
 * whenever two items tie on count.
 *
 * Trained units are counted under whatever their line had been upgraded to by
 * `hi`, not under the base name the recording uses -- see ./unitLines.ts. That
 * horizon is the same one `techsHeld` was built against, and it matches the
 * game: an upgrade converts the units already on the map, so a player holding
 * Champion has no Militia left to show.
 */
export function tallyEvents(
  payload: Payload,
  lo: number,
  hi: number,
  techsHeld: Map<number, Map<string, number>>,
): Map<number, CategoryTally> {
  const tally = new Map<number, CategoryTally>();
  for (const p of payload.players) {
    tally.set(p.number, { build: new Map(), tech: new Map(), unit: new Map() });
  }
  for (const e of payload.events) {
    if (e.t < lo || e.t > hi) continue;
    const bucket = tally.get(e.player);
    if (!bucket || !bucket[e.cat]) continue;
    const items = bucket[e.cat];
    const now = e.cat === "unit" ? currentUnit(e.item, techsHeld.get(e.player)) : null;
    const key = now ? now.name : e.item;
    /* A re-seed rides on the Farm row rather than opening one of its own: it
       is the same plot sown again, so it is not another farm, and the row is
       the count of them. Held in its own field so the two never add together
       -- how many farms a player had going and how many times they re-sowed
       one are different questions, and a sum answers neither.
       Farms are the only thing that ever carries the flag; `filter_events.ts`
       sets it nowhere else, because outside a re-seed a second Build order at
       an anchor is a re-send and not a rebuilt building. So `rebuilds` here is
       a farm count, whatever the field is called.
       The times still take it in. A row's span is when this player was placing
       this building, and re-seeding a plot is placing one. */
    const n = e.qty || 1;
    const cur = items.get(key);
    if (cur) {
      if (e.rebuild) cur.rebuilds = (cur.rebuilds ?? 0) + n;
      else cur.qty += n;
      if (e.t < cur.first) cur.first = e.t;
      if (e.t > cur.last) cur.last = e.t;
    } else {
      items.set(key, {
        /* Zero when a re-seed is the first thing in range: the build it
           replaces is behind `lo`, so the row is the re-seeds alone and
           saying the player built one here would be the lie. */
        qty: e.rebuild ? 0 : n,
        first: e.t,
        last: e.t,
        ...(now && now.name !== e.item ? { base: e.item, via: now.via } : {}),
        ...(e.rebuild ? { rebuilds: n } : {}),
      });
    }
  }
  return tally;
}

/**
 * Which techs each player holds by `hi`, and when each was ordered.
 *
 * Research is permanent, so this is cumulative to the range's upper bound no
 * matter which mode is active -- both sides get judged against the same
 * horizon. The times are what the unit columns rename their lines from.
 */
export function techsHeldBy(payload: Payload, hi: number): Map<number, Map<string, number>> {
  const held = new Map(payload.players.map((p) => [p.number, new Map<string, number>()]));
  for (const e of payload.events) {
    if (e.cat !== "tech") continue;
    if (e.t > hi) break;
    const mine = held.get(e.player);
    // First order wins: a re-click is the same research, not a later one.
    if (mine && !mine.has(e.item)) mine.set(e.item, e.t);
  }
  return held;
}

/**
 * Everyone not on this player's team. Falls back to "everyone else" when the
 * recording carries no team info, which keeps 1v1s correct either way.
 */
export function opponentsOf(players: Player[], p: Player): Player[] {
  const others = players.filter((x) => x.number !== p.number);
  const teamed = p.team != null && others.some((x) => x.team != null);
  return teamed ? others.filter((x) => x.team !== p.team) : others;
}
