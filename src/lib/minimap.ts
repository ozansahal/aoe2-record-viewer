/**
 * The map, turned into something a minimap can draw.
 *
 * This runs in the parse worker, once per recording, on the `match` the parser
 * produces and then throws away. Two reasons it lives here and not in
 * `src/parser/`: the parser's output is a documented on-disk contract that an
 * older `events.json` has to keep matching, and it is checked byte for byte
 * against real recordings -- neither of which a view of the map has any
 * business disturbing.
 *
 * What comes out is deliberately dumb: three run-length-encoded byte layers, a
 * colour table covering only the terrains this map uses, and the players'
 * starting tiles. The renderer needs no reference data and no knowledge of what
 * an object id means, and nothing here knows what a canvas is.
 */
import type {
  Minimap, MinimapAttacks, MinimapBuild, MinimapDelete, MinimapStart, OverlayCode, TerrainColors,
  TileLayer,
} from "../types";

/* ------------------------------------------------------------------ */
/* run-length encoding                                                 */
/* ------------------------------------------------------------------ */

/** Runs cannot be longer than a Uint16; a 480x480 layer of one value would be. */
const MAX_RUN = 0xffff;

export function encodeLayer(values: Uint8Array): TileLayer {
  const v: number[] = [];
  const n: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (v.length && v[v.length - 1] === value && n[n.length - 1] < MAX_RUN) n[n.length - 1]++;
    else { v.push(value); n.push(1); }
  }
  return { v: Uint8Array.from(v), n: Uint16Array.from(n) };
}

export function decodeLayer(layer: TileLayer, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i < layer.v.length && at < length; i++) {
    const end = Math.min(length, at + layer.n[i]);
    out.fill(layer.v[i], at, end);
    at = end;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* what sits on a tile                                                 */
/* ------------------------------------------------------------------ */

/**
 * Overlay codes, in drawing precedence: a gold mine under a tree is still a
 * gold mine, and a tile with nothing on it shows its terrain.
 */
export const OVERLAY = {
  none: 0,
  forest: 1,
  fish: 2,
  relic: 3,
  herd: 4,
  hunt: 5,
  berries: 6,
  stone: 7,
  gold: 8,
} as const;

/*
 * Gaia is classified by name rather than by object id: the ids differ between
 * datasets and between a hundred variants of the same animal, while the names
 * the reference table hands back are stable and readable. About a fifth of the
 * gaia objects in a recording have `name: null` -- an object id the dataset
 * table does not list -- and they fall through to `none`, which is the right
 * answer for something we cannot name.
 *
 * Order matters; the first match wins.
 */
const KINDS: [RegExp, OverlayCode][] = [
  [/^Gold Mine/i, OVERLAY.gold],
  [/^Stone Mine/i, OVERLAY.stone],
  /* Anchored and exact: a loose /Bush/ also catches "Bush A", "Bush B",
     "Bush C" and "Plant (Bush, Green)" -- decoration, not food. On a 168x168
     four-player map that was 629 of 683 berry marks. Forage Bush (59) and
     Fruit Bush (1059) are the only foragables in any dataset. */
  [/^(Forage|Fruit) Bush$/i, OVERLAY.berries],
  /* Herdables -- food you walk home rather than hunt. */
  [/^(Sheep|Goat|Turkey|Cow|Llama|Water Buffalo|Goose|Pig)\b/i, OVERLAY.herd],
  /* Huntables and the predators that eat them: both are meat on the map, and
     at this scale the distinction is not one a pixel can carry. */
  [/^(Deer|Zebra|Wild Boar|Javelina|Elephant|Rhinoceros|Ostrich|Ibex|Gazelle|Wild Camel|Wild Horse|Bactrian Camel|Water Buffalo|Wolf|Lion|Jaguar|Bear|Crocodile|Leopard|Tiger|Komodo|Snow Leopard)\b/i, OVERLAY.hunt],
  [/^Relic\b/i, OVERLAY.relic],
  [/(Fish|Marlin|Perch|Salmon|Snapper|Tuna|Dorado)/i, OVERLAY.fish],
  /* Last, so a bush or a mine in a forest is not swallowed by it. Stumps count
     -- a felled forest is still where the wood was. */
  [/^(Tree|Stump|Forest)/i, OVERLAY.forest],
];

/** The overlay code for a gaia object's name, or 0 for scenery and unknowns. */
export function classify(name: unknown): OverlayCode {
  if (typeof name !== "string" || !name) return OVERLAY.none;
  for (const [pattern, code] of KINDS) if (pattern.test(name)) return code;
  return OVERLAY.none;
}

/**
 * A terrain the dataset does not list. Grey, flat, and obviously not a guess
 * at grass.
 */
const UNKNOWN_TERRAIN: TerrainColors = { up: "#767b80", level: "#63686d", down: "#51565a" };

/** Every forest in `datasets/100.json` carries these three. */
const FOREST_TERRAIN: TerrainColors = { up: "#257439", level: "#157615", down: "#007200" };

/**
 * The Definitive Edition terrains aocref's table stops before.
 *
 * `datasets/100.json` lists terrain up to 109 and the game has more, so these
 * fell to UNKNOWN_TERRAIN's grey -- which was harmless while it was 73 tiles
 * of palm forest, and is not: on the development recording terrain 110 is
 * 1,810 tiles, an eighth of the map, and it is the treeline. It read as grey
 * speckle scattered through the forest, which is exactly what it was.
 *
 * Two gaps stacked to produce it. The object table does not name ids 1717 or
 * 1984 either, so `classify` returned `none` for the trees standing on these
 * tiles and the forest overlay never covered them; the tile then showed its
 * terrain, and the terrain had no colour. Over twenty recordings from the
 * development folder every one of the 9,200 tiles of terrain 110 and the 5,224
 * of terrain 113 carried one of those two objects, and every one of the 71
 * tiles of 112 carried a named Tree (Palm Forest). Three forests, measured,
 * not guessed -- which is why this is a list and not a rule about ids over
 * 109.
 */
const LATE_TERRAIN: Record<number, TerrainColors> = {
  110: FOREST_TERRAIN,
  112: FOREST_TERRAIN,
  113: FOREST_TERRAIN,
};

/* ------------------------------------------------------------------ */
/* the build                                                           */
/* ------------------------------------------------------------------ */

/* The parsed match is mgz-shaped and untyped by design -- see parse_rec.d.ts. */
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Build the minimap layers from a parsed match, or null when the recording
 * carries no map (a header the parser could read but that named no tiles).
 *
 * `dataset` is the aocref dataset the match was parsed with -- its `terrain`
 * table is where the three-colour minimap palette comes from.
 */
export function buildMinimap(match: any, dataset: any): Minimap | null {
  const map = match?.map;
  const dim = Number(map?.dimension) || 0;
  const tiles = map?.tiles;
  if (!dim || !Array.isArray(tiles) || !tiles.length) return null;

  const area = dim * dim;
  const terrain = new Uint8Array(area);
  const elevation = new Uint8Array(area);
  for (const tile of tiles) {
    const x = tile.x | 0;
    const y = tile.y | 0;
    if (x < 0 || y < 0 || x >= dim || y >= dim) continue;
    terrain[y * dim + x] = tile.terrain_id & 0xff;
    elevation[y * dim + x] = tile.elevation & 0xff;
  }

  /* Gaia is ~9,700 objects on a 120x120 map, most of them trees. Rasterising
     them into one byte per tile here is what keeps the renderer from having to
     draw ten thousand sprites, and what keeps ten thousand positions out of
     the payload. Higher codes win, which is the precedence in OVERLAY. */
  const overlay = new Uint8Array(area);
  for (const object of match?.gaia ?? []) {
    const code = classify(object?.name);
    if (!code) continue;
    const x = Math.floor(object.position?.x ?? -1);
    const y = Math.floor(object.position?.y ?? -1);
    if (x < 0 || y < 0 || x >= dim || y >= dim) continue;
    const i = y * dim + x;
    if (code > overlay[i]) overlay[i] = code;
  }

  const colors: Record<number, TerrainColors> = {};
  const table = dataset?.terrain ?? {};
  for (const id of new Set(terrain)) {
    const entry = table[id] ?? table[String(id)];
    const found = entry?.colors;
    colors[id] = found
      ? { up: found.up, level: found.level, down: found.down }
      : LATE_TERRAIN[id] ?? UNKNOWN_TERRAIN;
  }

  const starts: MinimapStart[] = [];
  for (const player of match?.players ?? []) {
    const at = player?.position;
    if (!at) continue;
    const anchors: number[] = [];
    /* Parallel to `anchors` rather than interleaved with it: the stride of
       that array is what a payload written before footprints existed still
       agrees with, and a second array is simply absent there. */
    const sizes: number[] = [];
    const kinds: number[] = [];
    for (const object of player.objects ?? []) {
      if (!keepStarting(object)) continue;
      const x = object.position?.x ?? -1;
      const y = object.position?.y ?? -1;
      if (x < 0 || y < 0 || x >= dim || y >= dim) continue;
      anchors.push(x, y);
      sizes.push(...footprintOf(object.name, x, y));
      kinds.push(kindOf(object.name));
    }
    starts.push({
      player: player.number,
      x: at.x,
      y: at.y,
      buildings: Float32Array.from(anchors),
      sizes: Float32Array.from(sizes),
      kinds: Uint8Array.from(kinds),
    });
  }

  const builds = buildOrders(match, dim);
  return {
    dim,
    terrain: encodeLayer(terrain),
    elevation: encodeLayer(elevation),
    overlay: encodeLayer(overlay),
    colors,
    starts,
    builds,
    attacks: militaryOrders(match, dim),
    deletes: deleteOrders(match, dim, builds, starts),
  };
}

/**
 * Orders one player aimed at another player's things.
 *
 * ---- why the obvious signals do not work ----
 *
 * The parser already labels some actions "Target", and it is tempting to read
 * that as an attack. It is not: "Target" means an order landing on a tile that
 * holds a known building, and the overwhelming majority of those are villagers
 * dropping resources at their own Town Centre. Measured on a 1v1, 1,624 of
 * 1,660 "Target" orders were aimed at the issuer's *own* buildings.
 *
 * Click rate does not separate them either -- laying a wall out-spams every
 * real battle in the recordings here -- and neither does selection size, which
 * comes out *larger* for plain moves than for attacks and is unreliable anyway
 * because `Inputs.addAction` carries the previous selection forward when an
 * action arrives with none.
 *
 * ---- what does work ----
 *
 * Resolve the target's owner. Seed an id-to-player map from every player's
 * starting objects, then walk the body assigning any id not yet seen to
 * whoever issued the order that names it -- only the owner gives an object an
 * order, so the assignment is exact by construction. An order whose target
 * belongs to somebody else is an attack; one whose target is gaia is a
 * villager gathering; one with no target is a move.
 *
 * The fallback for a target id that never resolves is position: a tile another
 * player built on. That is last-write-wins on the exact anchor, so a handful
 * of orders on ground rebuilt after a raze land on the wrong player -- the
 * same provisionality `buildingsAt` already carries.
 *
 * ---- what is deliberately not here: attack *lines* ----
 *
 * Drawing each attack as a line from the attacker to what it was aimed at --
 * the tracer look a shooter's killfeed map has -- was considered and is not
 * built. Only one end of it is in the recording. An order carries where it
 * landed (`input.position`, which is what this function reads) and the ids of
 * the units it was given to (`payload.object_ids`), and nothing anywhere says
 * where *those* units were standing when they got it. The other end would have
 * to be reconstructed: a per-unit last-known position, carried forward through
 * every move, gather and garrison in a 93k-action body, and wrong for the
 * whole of the walk between the order and the fight. That is a unit simulation
 * to draw a line, and the density layer above already says where the fighting
 * was. If it is ever wanted, this is the walk to hang it off -- the ownership
 * map here is already the expensive half.
 */
function militaryOrders(match: any, dim: number): MinimapAttacks {
  const owner = new Map<number, number>();
  for (const player of match?.players ?? []) {
    for (const object of player.objects ?? []) owner.set(object.instance_id, player.number);
  }
  const gaia = new Set<number>((match?.gaia ?? []).map((g: any) => g.instance_id));

  const inputs = match?.inputs ?? [];
  const builtBy = new Map<string, number>();
  for (const input of inputs) {
    const number = input.player?.number;
    if (number === undefined) continue;
    for (const raw of input.payload?.object_ids ?? []) {
      /* The SPECIAL family writes object ids multiplied by 256 -- garrison,
         ungarrison, unqueue, pack. Un-shift, or every id in them is a stranger
         and the ownership map fills up with numbers that are not objects. */
      const id = raw % 256 === 0 && !owner.has(raw) && owner.has(raw / 256) ? raw / 256 : raw;
      if (!owner.has(id) && !gaia.has(id)) owner.set(id, number);
    }
    if ((input.type === "Build" || input.type === "Reseed") && input.position) {
      builtBy.set(`${input.position.x},${input.position.y}`, number);
    }
  }

  const seen = new Map<string, number>();
  const t: number[] = [];
  const player: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const n: number[] = [];
  for (const input of inputs) {
    const number = input.player?.number;
    if (number === undefined || !input.position) continue;
    if (input.type === "Build" || input.type === "Reseed") continue;
    const target = input.payload?.target_id;
    const hostile = (target && owner.has(target) && owner.get(target) !== number)
      || (!(target && gaia.has(target))
        && builtBy.get(`${input.position.x},${input.position.y}`) !== undefined
        && builtBy.get(`${input.position.x},${input.position.y}`) !== number);
    if (!hostile) continue;
    const x = Math.floor(input.position.x);
    const y = Math.floor(input.position.y);
    if (x < 0 || y < 0 || x >= dim || y >= dim) continue;
    const second = Math.min(65535, Math.round(input.timestamp / 1000));
    /* One tactical order, not one per unit.
     *
     * A human tells a whole selection to attack and the recording holds one
     * order; an AI tells each unit separately and it holds forty. Left raw,
     * the same push counts 40x for the AI -- measured on this map, 6,003 and
     * 6,137 for the two AIs against 55 and 231 for the two people, which
     * paints the AIs over a third of the canvas and the humans nowhere.
     *
     * Collapsing (player, tile, second) costs the humans almost nothing --
     * 55 to 53 and 231 to 205, the only losses being genuine double-clicks --
     * and brings the AIs to 1,681 and 1,126. Same events, comparable weight.
     */
    const key = `${number}|${x}|${y}|${second}`;
    /* How many units the order moved: the selection it was given to. Summed
       into the collapsed order rather than kept from the first, so the AI's
       forty single-unit orders and the human's one forty-unit order both come
       out as forty -- the same reasoning as the collapse itself. */
    const units = Math.min(65535, input.payload?.object_ids?.length ?? 0);
    const had = seen.get(key);
    if (had !== undefined) {
      n[had] = Math.min(65535, n[had]! + units);
      continue;
    }
    seen.set(key, t.length);
    t.push(second);
    player.push(number);
    xs.push(x);
    ys.push(y);
    n.push(units);
  }
  return {
    t: Uint16Array.from(t),
    player: Uint8Array.from(player),
    x: Uint16Array.from(xs),
    y: Uint16Array.from(ys),
    n: Uint16Array.from(n),
  };
}

/**
 * A building's footprint in tiles, by the name the dataset gives it.
 *
 * Needed because a mark is drawn at the building's *centre*, and a centre only
 * says where the middle is -- a 4x4 Town Centre and a 1x1 tower share an
 * anchor style and cover sixteen times the ground. Drawn at one size for
 * everything, as they were, no mark matched its building and half of them
 * straddled four tiles for no reason a reader could see.
 *
 * The parity of each entry is measured, not remembered: the anchors in the two
 * recordings here land on `x.5` for every odd footprint and on an integer for
 * every even one, which pins Farm, Barracks, Archery Range, Stable,
 * Blacksmith and Monastery odd, and House, Mill, both camps, Town Centre,
 * Castle, Market, University and Siege Workshop even. The size within a parity
 * is the game's own number.
 */
const FOOTPRINT: Record<string, [number, number]> = {
  "Palisade Wall": [1, 1],
  "Stone Wall": [1, 1],
  "Fortified Wall": [1, 1],
  Outpost: [1, 1],
  "Watch Tower": [1, 1],
  "Guard Tower": [1, 1],
  Keep: [1, 1],
  "Bombard Tower": [1, 1],
  House: [2, 2],
  Mill: [2, 2],
  "Lumber Camp": [2, 2],
  "Mining Camp": [2, 2],
  Farm: [3, 3],
  Barracks: [3, 3],
  "Archery Range": [3, 3],
  Stable: [3, 3],
  Blacksmith: [3, 3],
  Monastery: [3, 3],
  Dock: [3, 3],
  Krepost: [3, 3],
  "Town Center": [4, 4],
  Castle: [4, 4],
  Market: [4, 4],
  University: [4, 4],
  "Siege Workshop": [4, 4],
};

/**
 * What a building is, for the few that are drawn differently from the rest.
 *
 * Not a general type: the map draws buildings as one colour per player and
 * that is most of its legibility. This is the exceptions -- the two worth
 * finding at a glance, and the one there are eighty of.
 *
 * `keep` and `castle` are drawn alike apart from the cross through a Castle,
 * and they are separate values rather than one plus a name because `Placed`
 * carries the kind and not the name: a payload is a footprint, an owner and
 * this number. Appended rather than inserted, so a stored payload written
 * before the split still decodes -- its Castles come back as `keep`, which is
 * how they were drawn then.
 */
export const KIND = { plain: 0, keep: 1, farm: 2, castle: 3 } as const;

/** Town Centres. */
const KEEP = /^Town Cent/i;

/** Krepost and Donjon are a Castle in every way that matters here. */
const CASTLE = /^(Castle|Krepost|Donjon)/i;

/** Which of those a name is. */
export function kindOf(name: string): number {
  if (CASTLE.test(name)) return KIND.castle;
  if (KEEP.test(name)) return KIND.keep;
  if (/^Farm/i.test(name)) return KIND.farm;
  return KIND.plain;
}

/** Gates are the one building that is not square: four tiles long, one thick. */
const GATE = /^(Palisade |Fortified )?Gate/;

/** Whether an anchor sits at a tile's centre, which is what an odd extent does. */
const oddAxis = (v: number) => Math.abs(v - Math.floor(v) - 0.5) < 0.25;

/**
 * The footprint to draw for a building, from its name and where it is anchored.
 *
 * The anchor is the fallback, and a good one. An extent's parity *is* the
 * fractional part of the centre it produces -- odd extents centre on a tile,
 * even ones on the corner between tiles -- so a building this table has never
 * heard of still gets its parity right, and parity is the half of this that
 * governs whether a mark lines up with the ground under it. Being wrong about
 * the size then costs a tile of width; being wrong about the parity costs the
 * alignment, and that is the part the anchor gives away for free.
 *
 * Per axis rather than one number, because a gate is 4x1 or 1x4 depending on
 * which way it was laid, and the anchor says which: the long axis is the one
 * whose centre came out even.
 */
export function footprintOf(name: string, x: number, y: number): [number, number] {
  const known = FOOTPRINT[name];
  if (known) return known;
  const [ox, oy] = [oddAxis(x), oddAxis(y)];
  if (GATE.test(name)) return [ox ? 1 : 4, oy ? 1 : 4];
  /* 3 and 2 are the commonest of each parity among the buildings not listed
     above -- the civ-specific ones, and anything a later patch adds. */
  return [ox ? 3 : 2, oy ? 3 : 2];
}

/** mgz's object class for a building. Walls and gates are in it; villagers are not. */
const BUILDING_CLASS = 80;

/**
 * The object ids that are a real Town Centre, as `parse_rec.js` lists them.
 *
 * A starting Town Centre arrives as *six* objects: this one, three more also
 * named "Town Center" (618, 619, 620) and two unnamed pieces (1649, 890), all
 * at offset positions a fraction of a tile apart. Drawing the lot puts four
 * town centres and two mystery buildings on every starting position.
 */
const TC_IDS = new Set([71, 109, 141, 142]);

/**
 * Whether a starting object is a building worth drawing.
 *
 * Buildings only: the villagers and the scout beside them are at the Town
 * Centre at time zero and somewhere else a minute later, so drawing them would
 * be drawing a fact that stops being true. On Arena what is left is the wall
 * ring, which is most of what makes a starting position recognisable at all.
 *
 * Unnamed buildings go too. An object id the dataset does not list is one we
 * cannot say anything about, and here they are the Town Centre's corner pieces
 * -- a phantom building is worse than a missing one.
 */
function keepStarting(object: any): boolean {
  if (object?.class_id !== BUILDING_CLASS) return false;
  if (typeof object.name !== "string" || !object.name) return false;
  if (/^Town Cent/i.test(object.name)) return TC_IDS.has(object.object_id);
  return true;
}

/**
 * Every Build order in the body, with where it was placed.
 *
 * The payload's `events` already carry build orders, but not *where* -- and
 * position is the whole point here, so this reads `match.inputs` instead. Two
 * hundred-odd orders in a full-length match, so the cost is nothing.
 *
 * Timestamps in the body are milliseconds; everything the viewer shows is
 * seconds, so they are converted once, here, rather than at every use.
 */
function buildOrders(match: any, dim: number): MinimapBuild[] {
  const out: MinimapBuild[] = [];
  for (const input of match?.inputs ?? []) {
    /* `Reseed` too, which is the same action under another name: the parser
       renames a Build to it when the Farm being placed is going onto a
       position that already held one (see the BUILD branch of
       `parse_rec.js`). Same payload, same position, same everything -- so
       filtering on the label alone dropped 38 farm placements of the 120 in
       `.data/rec.aoe2record` and 18 of 112 in `rec-old`.

       It changes no counts in either of those, because every reseed there
       lands on a plot a Build had already used and the anchor rule below
       folds the two together. What it changes is *when*: a plot re-sown at
       40:00 was reading as the 15:00 farm it replaced, which is a wrong
       answer to "what was on the map at 30:00" and, now that the drawing
       stacks by build time, the wrong depth as well. */
    if (input?.type !== "Build" && input?.type !== "Reseed") continue;
    /* Not rounded: the position is the building's exact centre anchor, which
       is a half-integer for anything with an odd footprint -- a Farm, a
       Barracks, a Stable. Flooring would move every one of those a tile. */
    const x = input.position?.x ?? -1;
    const y = input.position?.y ?? -1;
    if (x < 0 || y < 0 || x >= dim || y >= dim) continue;
    const player = input.player?.number;
    if (typeof player !== "number") continue;
    const item = String(input.param ?? "");
    const [w, h] = footprintOf(item, x, y);
    out.push({
      t: Math.round((input.timestamp ?? 0) / 1000),
      player, x, y, item, w, h, kind: kindOf(item),
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Every DELETE in the body that can be resolved to a building anchor.
 *
 * DELETE (`Action.DELETE`, 106) is the one signal in a recording that says a
 * building stopped standing. It is also the *only* one: an enemy razing a
 * Castle is not a command anybody issued, so it is not in the body at all, and
 * nothing here tries to infer one from attack orders.
 *
 * ---- resolving an id to a place ----
 *
 * A DELETE carries an object id and nothing else -- no position, no name, and
 * no way to tell a Town Centre from a spearman. `MinimapBuild` is keyed by
 * anchor and a `Build` order never reports the id of the building it produces,
 * so the two do not meet on their own. Two things bridge them:
 *
 * - **Starting objects**, which carry an `instance_id` and a position
 *   together. Exact, and the only direct link the format offers.
 * - **Orders that *target* an object.** A target's id sits in
 *   `payload.target_id` beside the order's `input.position`, and for a
 *   building that position is the building's own anchor -- which is precisely
 *   why the parser can name an order "Target" by looking its position up in a
 *   table of build positions. A villager sent to finish a foundation, a unit
 *   garrisoning, a monk repairing: any of those pins the id to a tile.
 *
 * The safety rule is that a resolved position is only used when it is *already
 * a known building anchor* -- a starting building's, or one a `Build` named.
 * A unit's own position is a float that will not equal an anchor, so a unit id
 * simply fails to resolve rather than removing something. An id ever seen at
 * two different anchors is dropped outright, and the delete has to come from
 * the player who owns the slot (`buildingsAt` checks that), so the two ways
 * this could remove the wrong building are both closed.
 *
 * ---- what that actually covers ----
 *
 * Measured over the two recordings in `.data/`: 23 of 43 deletes resolve
 * (1 of 8 in `rec.aoe2record`, 22 of 35 in `rec-old.aoe2record`). Every one of
 * the 20 that do not names an id that appears *nowhere else in the body* --
 * not as a target, not as the issuer of an order -- which is what an object
 * nobody ever built or interacted with looks like, i.e. a unit. No delete in
 * either file resolved ambiguously.
 *
 * So this under-reports and never over-reports, which is the right way round:
 * a building missing from the map is a gap, a building removed from under the
 * wrong player is a lie.
 */
function deleteOrders(
  match: any, dim: number, builds: MinimapBuild[], starts: MinimapStart[],
): MinimapDelete[] {
  /* The anchors `buildingsAt` will actually have slots at -- the starting
     buildings it seeds from, and every Build/Reseed position. Nothing outside
     this set can be deleted, because nothing outside it is drawn. */
  const anchors = new Set<string>();
  for (const start of starts) {
    const at = start.buildings;
    for (let i = 0; i + 1 < at.length; i += 2) anchors.add(`${at[i]},${at[i + 1]}`);
  }
  for (const build of builds) anchors.add(`${build.x},${build.y}`);

  const at = new Map<number, string>();
  const ambiguous = new Set<number>();
  const pin = (id: unknown, key: string) => {
    if (typeof id !== "number" || !id) return;
    const had = at.get(id);
    if (had === undefined) at.set(id, key);
    else if (had !== key) ambiguous.add(id);
  };
  for (const player of match?.players ?? []) {
    for (const object of player.objects ?? []) {
      const key = `${object?.position?.x},${object?.position?.y}`;
      if (anchors.has(key)) pin(object?.instance_id, key);
    }
  }
  for (const input of match?.inputs ?? []) {
    const key = input?.position ? `${input.position.x},${input.position.y}` : null;
    if (key !== null && anchors.has(key)) pin(input.payload?.target_id, key);
  }

  const out: MinimapDelete[] = [];
  for (const input of match?.inputs ?? []) {
    if (input?.type !== "Delete") continue;
    const player = input.player?.number;
    if (typeof player !== "number") continue;
    /* One id per DELETE, and it is always its own -- the payload never arrives
       empty, so `Inputs.addAction`'s carry-forward of the previous selection
       cannot put somebody else's object here. */
    const id = input.payload?.object_ids?.[0];
    if (typeof id !== "number" || ambiguous.has(id)) continue;
    const key = at.get(id);
    if (key === undefined) continue;
    const [x, y] = key.split(",").map(Number);
    if (!(x >= 0 && y >= 0 && x < dim && y < dim)) continue;
    out.push({ t: Math.round((input.timestamp ?? 0) / 1000), player, x, y });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * The buildings on the map at `t` seconds: everything each player started
 * with, plus every building they had ordered by then.
 *
 * **One slot per anchor**, which is the rule that makes this readable at all.
 * A player who cannot afford a building mashes the placement, and the body
 * records every click: one player in `.data/rec-old.aoe2record` issued 203
 * `Build "Town Center"` commands at a single anchor over three minutes. Drawn
 * one mark per command that tile is painted 203 times and the file's 509
 * placements roughly double-count the buildings on the map. Keyed by anchor
 * they are 253, which is a map.
 *
 * A later order at an anchor *replaces* the one there rather than adding to
 * it. That is deliberately not a time-window debounce -- a 30-second window
 * was measured on the same file and still left 274 episodes for 509 commands,
 * because the mashing runs for minutes. The anchor is safe to key on: the
 * position a Build reports is the building's exact centre, not the mouse, so
 * every one of those 203 commands reports the identical pair.
 *
 * **Deleted buildings are taken off**, and they are the only ones that are.
 * A DELETE is applied at its own time against the anchor it resolved to, so a
 * plot deleted at 20:00 and rebuilt at 30:00 is empty in between -- and it
 * only removes a slot the *same player* owns, so a delete resolved onto ground
 * somebody else has since built on cannot take their building instead.
 *
 * On the two recordings here that is 23 of 43 deletes, and the shortfall is
 * the format's, not the resolver's. A DELETE names an object id and nothing
 * else. Nothing names a *constructed* building's id at the moment it goes up:
 * a `Build` payload carries `building_id` -- the type, 70 for a House -- and
 * an `object_ids` list that holds the **villagers sent to build it**. So an id
 * only becomes a place when some later order names it beside a position, and
 * every one of the 20 that do not resolve is an id the body mentions exactly
 * once, in the DELETE itself. There is no position in the file to find.
 *
 * **Still provisional otherwise.** This is orders issued, which is what the
 * rest of the viewer counts (`events` are commands, not completions -- see the
 * data contract in README.md), and it is not what was standing:
 *
 * - a foundation the player cancelled, or never finished, is here anyway;
 * - a building an enemy destroyed stays on the map for the rest of the match.
 *   That is not an oversight and not fixable from a recording: razing is
 *   something the game does, not something a player commands, so no action in
 *   the body records it;
 * - a delete whose object id never appears anywhere else in the body cannot be
 *   placed, so that building stays too;
 * - a Farm that expired is still shown.
 *
 * A real model of that would replace the body of this function and nothing
 * else: the component asks this question and draws the answer, and knows
 * nothing about how it was reached. Nothing is building one yet.
 */
export function buildingsAt(data: Minimap, t: number): Placed[] {
  /* One slot per anchor. Insertion into a Map is also what makes a later order
     replace an earlier one, since re-setting a key keeps its original place. */
  const slots = new Map<string, Placed>();
  /* Defensive about its own fields: a minimap comes out of the store as it
     went in, and a payload written by a build where one of these did not exist
     yet must not take the viewer down with it. */
  for (const start of data.starts ?? []) {
    const anchors = start.buildings ?? [];
    const sizes = start.sizes;
    const kinds = start.kinds;
    for (let i = 0; i + 1 < anchors.length; i += 2) {
      const x = anchors[i];
      const y = anchors[i + 1];
      /* A payload from before footprints were carried has the anchors and not
         the sizes. The anchor alone still fixes the parity, which is the part
         that has to be right -- see `footprintOf`. */
      const [w, h] = sizes && i + 1 < sizes.length
        ? [sizes[i], sizes[i + 1]]
        : footprintOf("", x, y);
      slots.set(`${x},${y}`, { x, y, w, h, kind: kinds?.[i / 2] ?? KIND.plain, player: start.player, t: 0 });
    }
  }
  /* Builds and deletes are one stream, walked in step. Applying every delete
     afterwards would be a different picture: a plot deleted at 20:00 and built
     on again at 30:00 has a building on it at 40:00, and a pass at the end
     would have removed it.

     At the same second the build goes first. That is the order the body has
     them in where both happen -- a placement mashed out and taken straight
     back down -- and `t` here is rounded to seconds, so the sub-second
     ordering the body did carry is gone by this point. */
  const deletes = data.deletes ?? [];
  let next = 0;
  const drain = (until: number, inclusive: boolean) => {
    while (next < deletes.length
      && (inclusive ? deletes[next].t <= until : deletes[next].t < until)) {
      const gone = deletes[next++];
      const key = `${gone.x},${gone.y}`;
      /* Only the owner's own building. A resolved anchor can have changed
         hands since -- `buildOrders` lets a later Build take an anchor over --
         and removing somebody else's building would be the one failure worse
         than not removing anything. */
      if (slots.get(key)?.player === gone.player) slots.delete(key);
    }
  };
  for (const build of data.builds ?? []) {
    if (build.t > t) break;  // sorted by time
    drain(build.t, false);
    const [w, h] = build.w && build.h ? [build.w, build.h] : footprintOf(build.item ?? "", build.x, build.y);
    const kind = build.kind ?? kindOf(build.item ?? "");
    slots.set(`${build.x},${build.y}`, { x: build.x, y: build.y, w, h, kind, player: build.player, t: build.t });
  }
  drain(t, true);
  /* Sorted rather than left in the Map's insertion order, because those are
     not the same order and the difference is exactly the case this carries `t`
     for. Re-setting a key keeps its *original* position, so a Castle built at
     40:00 over an anchor first used at 8:00 comes back where the 8:00 building
     was -- underneath everything placed between the two. Sorting puts it where
     it was built.

     Stable, so the starting buildings keep the order the recording lists them
     in: they are all `t` 0 and there is nothing else to separate them by. */
  return [...slots.values()].sort((a, b) => a.t - b.t);
}

/** A building on the map, owned. The colour is the component's business. */
export interface Placed {
  x: number;
  y: number;
  /** Footprint in tiles, per axis: 4x4 for a Town Centre, 1x4 for a gate. */
  w: number;
  h: number;
  /** `KIND` -- which of the specially drawn families this is, if any. */
  kind: number;
  player: number;
  /**
   * When it was ordered, in seconds. 0 for a starting building.
   *
   * Here so the drawing can put a later building over an earlier one, which is
   * the only sane answer where two footprints overlap: a recording says a
   * building was ordered and never says one stopped standing (see above), so
   * an anchor's history is all still on the map and the newest of it is the
   * part that was true last.
   */
  t: number;
}

/* ------------------------------------------------------------------ */
/* projection                                                          */
/* ------------------------------------------------------------------ */

/**
 * A tile's place on the minimap, as a fraction of the canvas in each axis.
 *
 * The map is drawn as a diamond, which is the same rotation the game itself
 * uses: screen x is `tx - ty` and screen y is `tx + ty`, so the north corner
 * is (0, 0). Both halves of the minimap -- the raster below and the markers
 * over it -- go through this, and so does anything that wants to put its own
 * mark on the map.
 *
 * Normalised, so the *shape* of the diamond is not decided here: both axes
 * come back in 0..1 and how tall that is on screen is the plot's business. A
 * 2:1 plot gives the game's own squashed diamond; a 1:1 plot gives the same
 * rotation unsquashed. See `SQUARE` in components/Minimap.tsx.
 */
export function projectTile(dim: number, x: number, y: number): { u: number; v: number } {
  /* Rotated a quarter turn anticlockwise from the game's own orientation: tile
     (0,0) sits at the left vertex rather than the top one. The diamond is
     symmetric under a quarter turn in this normalised space, so the outline and
     the 2:1 plot are unchanged -- only what sits in which corner moves. */
  return { u: (x + y) / (2 * dim), v: (y - x + dim) / (2 * dim) };
}

/** The inverse, for rasterising by destination pixel. May land off the map. */
export function unprojectPoint(dim: number, u: number, v: number): { x: number; y: number } {
  const a = u * 2 * dim;        // x + y
  const b = v * 2 * dim - dim;  // y - x
  return { x: (a - b) / 2, y: (a + b) / 2 };
}
