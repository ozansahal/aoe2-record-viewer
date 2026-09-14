/**
 * The viewer payload, as produced by `filterEventsAsync()` and written to disk
 * by `node cli/filter_events.js --json`. Previously exported events.json files
 * must keep loading, so this shape is a contract -- see PORTING.md.
 */

export type Category = "build" | "tech" | "unit";

export interface Player {
  number: number;
  name: string;
  civilization: string;
  color: string;
  team: number | null;
  /* Inferred, two ways. When somebody resigned: everyone on a team nobody
     resigned from. When nobody did: every side except the recording owner's,
     because a file with no resignation in it is one its owner quit out of.
     False for everyone only when the recording names no owner on a side. */
  winner: boolean;
  /** Stated by the recording: this player sent a RESIGN. */
  resigned: boolean;
  ai_name: string;
  is_ai: boolean;
  handicap: number;
}

/** SYNC stat samples: [seconds, total_resources, total_objects]. */
export type SeriesRow = [number, number, number];

export interface Series {
  player: number;
  rows: SeriesRow[];
}

export interface AgeUp {
  t: number;
  player: number;
  age: string;
}

/** A command a player issued -- not a completion; cancelled orders still count. */
export interface GameEvent {
  t: number;
  player: number;
  cat: Category;
  item: string;
  qty: number;
  /* Builds only: the same building going back onto ground this player had
     already put one on -- a re-seeded farm, a rebuilt house. Counted on its
     own line rather than added to the first build, since "how many farms did
     they have" and "how often did they re-sow one" are different questions.
     Absent on an events.json exported before this existed. */
  rebuild?: boolean;
}

/**
 * A tile layer, run-length encoded: `v[i]` repeated `n[i]` times, row-major by
 * `y` then `x`.
 *
 * A 120x120 map is 14,400 tiles per layer and the biggest AoE2 map is 480x480,
 * which is 230,400 -- and the payload is what gets kept in IndexedDB for a
 * hundred matches, so two raw byte arrays per recording is not free. Terrain
 * and elevation both come in long runs (a map is fields and forests, not
 * noise), so this is a third to a fifth of the size for twenty lines of code.
 * A run never exceeds 65,535; a longer one is split.
 */
export interface TileLayer {
  v: Uint8Array;
  n: Uint16Array;
}

/** What a tile carries besides its terrain. See `OVERLAY` in lib/minimap.ts. */
export type OverlayCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** The three minimap colours a terrain is drawn in, by slope: up, level, down. */
export interface TerrainColors {
  up: string;
  level: string;
  down: string;
}

/**
 * The map as the minimap draws it, built in the parse worker from
 * `match.map.tiles` and `match.gaia` -- see lib/minimap.ts.
 *
 * Optional, and absent from every payload written before this existed as well
 * as from any `events.json` the CLI exports (the CLI's payload is the
 * documented on-disk contract and this is not part of it). The component draws
 * nothing when it is missing.
 */
export interface Minimap {
  /** Side length in tiles. The map is always square. */
  dim: number;
  /** Terrain id per tile. */
  terrain: TileLayer;
  /** Elevation per tile, 0-7ish. The shading rule reads it; see the component. */
  elevation: TileLayer;
  /** What sits on the tile -- forest, gold, a relic. `OverlayCode` values. */
  overlay: TileLayer;
  /**
   * Colours for the terrain ids this map actually uses, so the renderer needs
   * no reference data of its own -- the worker is where the datasets are
   * bundled, and it is the only thing that should have to know that.
   */
  colors: Record<number, TerrainColors>;
  /** Where each player started, and what they started with. */
  starts: MinimapStart[];
  /**
   * Every building *order*, in time. Provisional -- see `buildingsAt` in
   * lib/minimap.ts for what this deliberately does not model.
   */
  builds: MinimapBuild[];
  /**
   * Military orders -- an order one player aimed at another player's unit or
   * building. Parallel arrays rather than objects: this is a few hundred marks
   * for a human and several thousand for an AI, and it is read as columns.
   *
   * Optional: a payload parsed before this existed simply draws no overlay.
   */
  attacks?: MinimapAttacks;
  /**
   * The buildings a player deleted, each resolved to the anchor it stood on.
   *
   * Deletions only -- a building razed by an enemy is not in the command
   * stream at all. Partial by construction: see `buildingsAt` in
   * lib/minimap.ts for which deletes resolve and which are dropped.
   *
   * Optional: a payload parsed before this existed removes nothing, which is
   * exactly what it did when it was written.
   */
  deletes?: MinimapDelete[];
}

/**
 * One building deletion, already resolved from an object id to a position.
 *
 * The anchor, not a tile: it is matched against the same `x,y` key
 * `buildingsAt` slots buildings by, so it carries the same half-integers a
 * `MinimapBuild` does.
 */
export interface MinimapDelete {
  /** Seconds, to match everything else the viewer measures time in. */
  t: number;
  /** Who deleted it. A delete only removes a building this player owns. */
  player: number;
  x: number;
  y: number;
}

/**
 * Where the fighting was, in time.
 *
 * Tile coordinates are floored -- this feeds a density layer, not an anchor,
 * so the half-tile precision a building anchor needs would be thrown away by
 * the splat anyway.
 */
export interface MinimapAttacks {
  /** Seconds, to match everything else the viewer measures time in. */
  t: Uint16Array;
  /** Who issued the order. Matches `Player.number`. */
  player: Uint8Array;
  x: Uint16Array;
  y: Uint16Array;
  /**
   * How many units each order was given to -- the size of the selection, with
   * the AI's one-unit orders summed into the collapsed order they belong to.
   * Optional: a payload parsed before this existed has no count to show.
   */
  n?: Uint16Array;
}

export interface MinimapStart {
  /** Matches `Player.number`, which is how the colour is looked up. */
  player: number;
  /** The Town Centre anchor. */
  x: number;
  y: number;
  /**
   * The buildings they started with, as interleaved `x, y` anchors.
   *
   * World coordinates, not tile indices, and not rounded: an odd-footprint
   * building is anchored at the centre of a tile and so lands on `x.5`, while
   * an even-footprint one is anchored on a corner and lands on an integer.
   * Rounding either would put half of them on the wrong tile.
   */
  buildings: Float32Array;
  /**
   * Their footprints, as interleaved `w, h` in tiles, parallel to `buildings`.
   *
   * Optional: a payload written before this existed carries the anchors alone,
   * and `buildingsAt` falls back to reading the parity off the anchor.
   */
  sizes?: Float32Array;
  /** One `KIND` per building, parallel to the anchor pairs. Optional, as above. */
  kinds?: Uint8Array;
}

/** One building order: where, when, by whom. */
export interface MinimapBuild {
  /** Seconds, to match everything else the viewer measures time in. */
  t: number;
  player: number;
  /** The anchor the order named -- exact, and half-integer for a 3x3. */
  x: number;
  y: number;
  /** "House", "Castle" -- what the order named. */
  item: string;
  /** The footprint that name has, in tiles. Optional, for older payloads. */
  w?: number;
  h?: number;
  /** `KIND` for that name. Optional, for older payloads. */
  kind?: number;
}

/**
 * One thing drawn over the map. Nothing produces these yet: it is the seam a
 * per-time overlay -- buildings as they go up, say -- gets layered on at,
 * without the component having to learn what a building is.
 */
export interface MapMark {
  x: number;
  y: number;
  color: string;
  /** Radius in tiles. Default 1. */
  r?: number;
}

/** A row in the order feed beside the map. See lib/orders.ts. */
export type OrderKind = "build" | "tech" | "unit" | "delete" | "attack";

export interface Order {
  /** Stable for the life of the payload; the rendered row's key. */
  id: number;
  t: number;
  player: number;
  kind: OrderKind;
  /** What was ordered: an item name, or "Attack". */
  label: string;
  /** Units, for a unit or attack order; 1 otherwise. 0 when unknown. */
  qty: number;
}

export interface Payload {
  map: string;
  /**
   * The map is a scenario -- a campaign mission, a challenge, anything the
   * editor made -- and `map` above is its filename. Optional because payloads
   * exported before this existed do not carry it.
   */
  scenario?: boolean;
  /** Match length in seconds. */
  duration: number;
  speed: string;
  difficulty: string;
  /** False when re-sent orders were left uncollapsed; the UI warns about it. */
  deduped: boolean;
  /**
   * The `number` of the player whose client recorded the file -- you, for
   * anything the game wrote into your own savegame folder. Null when the
   * recording names no owner, and absent from payloads exported before it was
   * carried, which is why it is optional rather than nullable alone.
   */
  pov?: number | null;
  /** The map itself, for the minimap. Absent on an exported `events.json`. */
  minimap?: Minimap;
  players: Player[];
  series: Series[];
  ages: AgeUp[];
  events: GameEvent[];
}

/**
 * What the map's action overlay counts.
 *
 * - `cumulative` -- every attack up to the playhead, all weighted the same.
 * - `window` -- only the last `w` seconds, all weighted the same. A hard edge
 *   at both ends: an order is in or it is out.
 * - `decay` -- the same last `w` seconds, but weighted by age, so the fighting
 *   under the playhead is bright and an order about to leave the window has
 *   already faded to nothing. See `SPLAT_DECAY` in components/Minimap.tsx.
 */
export type Mode = "cumulative" | "window" | "decay";
export type SortBy = "time" | "count";

/** What one item accumulates to inside the counted range. */
export interface ItemTally {
  qty: number;
  first: number;
  last: number;
  /* Units only, and only when the line was renamed by an upgrade: the name the
     recording itself used, and the upgrades that moved it off that name. See
     lib/unitLines.ts for why a trained Champion arrives called "Militia". */
  base?: string;
  via?: { name: string; t: number }[];
  /* Builds only: how many of this building went back onto ground the player
     already had one on -- farms re-seeded, houses rebuilt. Counted beside the
     row rather than inside `qty`, since a re-seeded plot is not another farm. */
  rebuilds?: number;
}

export type CategoryTally = Record<Category, Map<string, ItemTally>>;
