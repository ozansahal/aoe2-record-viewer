/**
 * JavaScript port of filter_events.py -- filter an AoE2 recorded game down to
 * building, research, and unit-training events, and emit the viewer's JSON
 * (or CSV, or the text report) from it.
 *
 * These are the commands players issued (foundation placed, research started,
 * unit queued), not confirmed completions -- a cancelled building or unit still
 * appears.
 *
 * Parsing lives in ./parse_rec.ts, which is the port of parse_rec.py plus the
 * mgz internals both scripts rely on.
 *
 * Usage:
 *   import { filterEvents, toJson } from "./filter_events.ts";
 *   const payload = filterEvents('rec.aoe2record', { dedupe: 30 });
 *   fs.writeFileSync('events.json', toJson(payload));
 *
 * CLI (mirrors filter_events.py), from the app/ directory:
 *   node cli/filter_events.js <rec> [-o out] [--category build tech unit]
 *                              [--player N ...] [--csv] [--json]
 *                              [--no-timeline] [--dedupe [SECONDS]]
 */

import { runtime, IS_NODE } from "./runtime.ts";
import {
  parseMatch, parseMatchAsync, parseHeader, displayName, fmtTimestamp, Stream,
} from "./parse_rec.ts";
import type {
  Match, ParseOptions, RecordingInput, ReferenceData,
} from "./parse_rec.ts";
import type { Category, Payload } from "../types.ts";

/* ------------------------------------------------------------------ */
/* The public surface's types, formerly in filter_events.d.ts          */
/* ------------------------------------------------------------------ */

export interface FilterOptions extends ParseOptions {
  /** Categories to keep. Default: all three. */
  category?: Category[];
  /** Player numbers to keep. Default: all. */
  player?: number[];
  /** Collapse a build/tech order re-sent within N seconds. 0 disables. */
  dedupe?: number;
  reference?: ReferenceData;
}

/** One filtered command, before it is folded into the payload. */
export interface EventRow {
  seconds: number;
  time: string;
  player_number: number;
  player: string;
  category: Category;
  item: string;
  quantity: number;
  source: string;
  /** Where it was placed, "x,y", or null for anything not placed. */
  at: string | null;
  /** Same building, same spot, earlier in the match. */
  rebuild: boolean;
}

export interface FilterResult {
  match: Match;
  extras: unknown;
  names: Map<unknown, unknown>;
  categories: Set<Category>;
  players: Set<number> | null;
  rows: EventRow[];
  payload: Payload;
}

/** Header extras and the mgz-shaped records read out of a match: untyped by
    design, exactly as `Match` is. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

const utf8 = new TextDecoder("utf-8");

const CATEGORIES: Category[] = ["build", "tech", "unit"];
/* Indexed by a plain string: a row's category comes off an mgz action. */
const LABELS: Record<string, string> = { build: "BUILD", tech: "TECH", unit: "UNIT" };

function toBytes(input: RecordingInput): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof input === "string") {
    if (!runtime.fs) throw new Error("reading by path needs Node; pass the bytes instead");
    return new Uint8Array(runtime.fs.readFileSync(input));
  }
  throw new Error("expected a Uint8Array, ArrayBuffer, or file path");
}

/* Node's `process`; declared, not imported, so src/parser stays free of
   `node:` and of @types/node. Reached only when IS_NODE. */
declare const process: { stderr: { write(text: string): unknown } };

function warn(message: string): void {
  if (IS_NODE) process.stderr.write(`${message}\n`);
  else console.warn(message);
}

/** Python's f-string rendering of a possibly-missing id. */
function idText(value: Rec) {
  return value === undefined || value === null ? "None" : String(value);
}

/** Map an action to [category, item, quantity, source], or null if uninteresting. */
function classify(action: Rec): [Category, string, number, string] | null {
  const name = action.type_name;
  const p = action.payload || {};
  if (name === "BUILD") {
    return ["build", p.building || `building #${idText(p.building_id)}`, 1, name];
  }
  if (name === "RESEARCH") {
    return ["tech", p.technology || `tech #${idText(p.technology_id)}`, 1, name];
  }
  if (name === "DE_QUEUE" || name === "QUEUE") {
    return ["unit", p.unit || `unit #${idText(p.unit_id)}`, p.amount || 1, name];
  }
  if (name === "MAKE") {
    return ["unit", p.unit || `unit #${idText(p.unit_id)}`, 1, name];
  }
  return null;
}

// Only orders that a player re-sends until they succeed may be collapsed.
// Unit training is deliberately excluded: queuing the same unit over and over
// is real production, not a re-send, so folding those chains would erase most
// of a player's army (P2's 361 units collapsed to 46 before this was scoped).
const DEDUPE_CATEGORIES = ["build", "tech"];

/**
 * Collapse an order that is re-issued repeatedly within `window` seconds.
 *
 * AIs re-send a placement order every few seconds until it succeeds, which
 * inflates raw build counts. A continuous chain of repeats collapses to one row.
 * A tech can only be researched once, so a repeat there is a redundant click.
 * Categories outside DEDUPE_CATEGORIES pass through untouched.
 *
 * **A build is keyed on where it was placed as well as what it was.** Without
 * the position this collapsed by name and clock alone, which is not what a
 * re-send is: a re-send is the same building at the same spot, and two
 * buildings of one type going up within the window are two buildings. Farms
 * are where that showed worst, because a player shift-queues a whole row of
 * them in one second -- in `.data/rec.aoe2record` P1 placed 36 distinct farms
 * and this counted 10 -- but nothing was exempt: 11 Archery Ranges counted 3,
 * 9 Barracks counted 3, 28 Houses counted 14. Keyed on the anchor, every one
 * of those comes out at its true number, and the case the window was written
 * for still folds: P2's 15 Siege Workshop orders are 8 places.
 *
 * A tech has no position and needs none -- there is one of each.
 */
function dedupe(rows: EventRow[], window: number): EventRow[] {
  const last = new Map<string, number>();
  const kept: EventRow[] = [];
  for (const r of rows) {
    if (!DEDUPE_CATEGORIES.includes(r.category)) {
      kept.push(r);
      continue;
    }
    const key = `${r.player_number}|${r.category}|${r.item}`
      + (r.at === null || r.at === undefined ? "" : `|${r.at}`);
    const previous = last.get(key);
    last.set(key, r.seconds);
    if (previous !== undefined && r.seconds - previous <= window) continue;
    kept.push(r);
  }
  return kept;
}

/** The one building a second order at the same anchor genuinely means again. */
const RESEEDABLE = "Farm";

/**
 * Whether this build is a **Farm going back onto a plot the same player
 * already sowed** -- a re-seed, and nothing else.
 *
 * The same test the parser makes to rename a Build to `Reseed`, but kept here
 * rather than read off `input.type`, because this walks `match.actions` and a
 * rename lives on the `inputs` stream. Restricted to farms exactly as that one
 * is, and the restriction is the point:
 *
 * `events` are orders *issued*, and a recording never says a building stopped
 * standing. So a second Build at an anchor is a rebuild only if something had
 * gone -- which is precisely what cannot be read here. What it catches instead
 * is placement mashing: a player who cannot afford a building, or whose
 * villager keeps being interrupted, re-sends the placement, and one player in
 * `.data/rec-old.aoe2record` sent 203 `Build "Town Center"` commands at a
 * single anchor over three minutes (see the minimap section of `README.md`).
 * The dedupe window does not save this -- a time-window debounce was measured
 * on that file and rejected, because the mashing runs for minutes -- and on
 * `.data/rec.aoe2record` fifteen Siege Workshop orders across three adjacent
 * anchors inside thirty seconds produced seven "rebuilds" with nothing ever
 * having stood there.
 *
 * A Farm is the one case the model gets right without knowing any of that. A
 * farm expires on its own, re-seeding it is literally a second Farm order on
 * the same plot, and the two can be forty minutes apart and still be a
 * re-seed. Everything else is left alone rather than guessed at.
 *
 * The map still records **every** building, not just farms: a House put on an
 * old plot has to overwrite it, or the next Farm there reads as a re-seed of a
 * plot that has had a house on it since.
 *
 * Per player, because two players may build on the same spot across a match
 * and neither one rebuilt anything.
 */
function occupancy() {
  const held = new Map();
  return (playerNumber: number, item: Rec, position: Rec) => {
    if (!position) return false;
    const key = `${playerNumber}|${position.x},${position.y}`;
    const before = held.get(key);
    held.set(key, item);
    return item === RESEEDABLE && before === RESEEDABLE;
  };
}

/**
 * What a row is called in a report.
 *
 * A re-seed is its own line rather than another tally against the first one,
 * because the two answer different questions and adding them answers neither:
 * how many farms a player had going is the count of plots, and how many times
 * they re-sowed one is the work of keeping them going. Folded together, a
 * booming player and a player nursing four plots for an hour look alike.
 *
 * "Re-seeded" is the only wording, because a re-seeded Farm is the only thing
 * the flag is set on -- see `occupancy()`. There used to be a "rebuilt" arm
 * here for every other building; it had no true cases, only mashing.
 */
function rowLabel(r: Rec) {
  if (!r.rebuild) return r.item;
  return `${r.item} (re-seeded)`;
}

function collect(
  match: Match, categories: Set<Category>, players: Set<number> | null, names?: Map<Rec, Rec>,
): EventRow[] {
  names = names || new Map();
  const rows: EventRow[] = [];
  const rebuilt = occupancy();
  for (const action of match.actions) {
    const hit = classify(action);
    if (hit === null) continue;
    const [category, item, qty, source] = hit;
    /* Before the category filter, so `--category unit` does not leave the
       occupancy map with holes in it and mislabel the next build. */
    const again = category === "build" && action.player !== null
      && rebuilt(action.player.number, item, action.position);
    if (!categories.has(category)) continue;
    if (action.player === null) continue;
    if (players && !players.has(action.player.number)) continue;
    rows.push({
      seconds: Math.trunc(action.timestamp / 1000),
      time: fmtTimestamp(action.timestamp),
      player_number: action.player.number,
      player: names.get(action.player.number) || displayName(action.player),
      category,
      item,
      quantity: qty,
      source,
      /* Where it went, for the dedupe below; null for anything not placed. */
      at: action.position ? `${action.position.x},${action.position.y}` : null,
      /* A Farm on a plot this player already sowed -- a re-seed. Farms only,
         and deliberately: outside them a second Build at an anchor is usually
         the same order sent again, which no dedupe window can be trusted to
         have removed. See `occupancy()`. */
      rebuild: again,
    });
  }
  return rows;
}

/**
 * AI persona, slot type, and handicap.
 *
 * These sit in the DE header but the match model drops them, so parse the
 * header a second time. `type` 2 is a human and 4 an AI, which beats guessing
 * from a blank player name. Returns an empty map if the header cannot be read
 * -- the export is still useful without it.
 */
function readHeaderExtras(input: Rec, options: ParseOptions = {}): Rec {
  let de;
  try {
    // A parsed match already carries the DE header, so re-parsing (as the
    // Python must) is skipped when the caller hands one over.
    if (input && input.de !== undefined && input.players) de = input.de;
    else if (input instanceof Uint8Array || typeof input === "string") {
      de = parseHeader(new Stream(toBytes(input)), options).de;
    } else de = null;
  } catch (err) {
    warn(`warning: could not read AI header fields (${(err as Rec).message})`);
    return new Map();
  }
  const text = (v: Rec) => (v instanceof Uint8Array ? utf8.decode(v) : v || "");
  const extras = new Map();
  for (const p of (de && de.players) || []) {
    const number = p.number;
    if (!Number.isInteger(number) || number < 1) continue;
    extras.set(number, {
      ai_name: text(p.ai_name),
      is_ai: p.type === 4,
      handicap: p.handicap === undefined ? null : p.handicap,
    });
  }
  return extras;
}

/**
 * Real username, else the AI's persona, else a bare slot label.
 *
 * An AI has no username, so falling straight through to "AI (P2)" threw away
 * the persona the header already carries -- "Yekuno Amlak" identifies the
 * opponent far better.
 */
function resolveName(player: Rec, extras: Rec) {
  const info = (extras && extras.get(player.number)) || {};
  return player.name || info.ai_name || `AI (P${player.number})`;
}

function nameMap(match: Match, extras: Rec): Map<Rec, Rec> {
  return new Map(match.players.map((p: Rec) => [p.number, resolveName(p, extras)]));
}

function prettyAge(age: Rec) {
  const name = ["", "DARK_AGE", "FEUDAL_AGE", "CASTLE_AGE", "IMPERIAL_AGE"][age] || String(age);
  /* `.pop()` on a non-empty split is never undefined; asserted rather than
     defaulted, which would put a branch where there was none. */
  return name.split(".").pop()!.replace(/_/g, " ")
    .replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * Bundle match metadata, age-up completions, and events for the viewer.
 *
 * Age-ups come from the in-game AGE notification, so unlike everything in
 * `events` they are real completion times rather than issued commands.
 * `series` carries the SYNC stat samples (~every 7s): total_resources is the
 * summed stockpile, not a per-resource breakdown, and mgz treats those field
 * offsets as informed guesses -- read it as a trend, not an exact figure.
 */
function buildJson(match: Match, rows: EventRow[], deduped: boolean, extras: Rec): Payload {
  extras = extras || new Map();
  const teams = new Map();
  match.teams.forEach((team: Rec, idx: Rec) => {
    for (const p of team) teams.set(p.number, idx + 1);
  });

  return {
    map: match.map.name,
    /* Whether that name is a scenario's filename rather than a map's -- a
       campaign mission or a challenge. Cheap to carry and impossible to
       recover from the name alone. */
    scenario: Boolean(match.map.scenario),
    duration: Math.trunc(match.duration / 1000),
    speed: String(match.speed),
    difficulty: String(match.difficulty),
    deduped,
    /* Whose recording this is: the player whose client wrote the file, which
       the header states as `owner_id` and the match model resolves to a
       player. Every replay in your own savegame folder was written by your
       client, so this is how a list of them knows which player is you --
       nothing else in the file says so, and a name or a colour is whatever
       the lobby happened to hand out that game.
       Null for a recording with no owner: an events.json exported before this
       existed has no `pov` at all, which is the same answer. */
    pov: match.file && match.file.perspective ? match.file.perspective.number : null,
    players: match.players.map((p: Rec) => ({
      number: p.number,
      name: resolveName(p, extras),
      civilization: String(p.civilization),
      color: String(p.color),
      team: teams.has(p.number) ? teams.get(p.number) : null,
      winner: Boolean(p.winner),
      resigned: Boolean(p.resigned),
      ...(extras.get(p.number) || {}),
      /* The DE profile id, which is the one thing about a player that is the
         same from game to game: names are whatever the lobby showed and can
         be changed between matches. An AI seat carries 0xFFFFFFFF. Appended
         last, so everything before it is byte-identical to what this wrote. */
      profile_id: p.profile_id,
    })),
    series: match.players.map((p: Rec) => ({
      player: p.number,
      rows: p.timeseries.map((r: Rec) => [Math.trunc(r.timestamp / 1000), r.total_resources, r.total_objects]),
    })),
    ages: (match.uptimes || []).map((u: Rec) => ({
      t: Math.trunc(u.timestamp / 1000),
      player: u.player ? u.player.number : null,
      age: prettyAge(u.age),
    })),
    /* `item` stays `Farm` and the re-seed rides alongside as a flag (named
       `rebuild`, which is the on-disk key and stays put), so a consumer that
       does not know about re-seeds still reads a
       real building name -- and appended last, and only when true, so every
       event that is not one is byte-identical to what this wrote before. */
    events: rows.map((r: Rec) => ({
      t: r.seconds,
      player: r.player_number,
      cat: r.category,
      item: r.item,
      qty: r.quantity,
      ...(r.rebuild ? { rebuild: true } : {}),
    })),
  };
}

/** json.dumps(payload, indent=1): 1-space indent and \uXXXX-escaped non-ASCII. */
function toJson(payload: Payload): string {
  return JSON.stringify(payload, null, 1).replace(
    /[\u0080-\uFFFF]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function padRight(text: string, width: number) {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Counter.most_common(): count descending, insertion order breaking ties. */
function mostCommon(counter: Map<Rec, Rec>): Rec[] {
  return [...counter.entries()].sort((a, b) => b[1] - a[1]);
}

function buildReport(
  match: Match, rows: EventRow[], categories: Set<Category>,
  players: Set<number> | null, showTimeline: boolean, names?: Map<Rec, Rec>,
): string {
  names = names || new Map();
  const lines: string[] = [];
  const add = (line = "") => lines.push(line);

  add("=".repeat(68));
  add("BUILDINGS / RESEARCH / UNIT TRAINING");
  add("=".repeat(68));
  add(`Map      : ${match.map.name}`);
  add(`Duration : ${fmtTimestamp(match.duration)}`);
  add("Note     : commands issued (placed/started/queued), not completions.");
  add("           An order re-sent until it succeeds counts once per send;");
  add("           use --dedupe to collapse those repeats (build/tech only --");
  add("           repeat unit queuing is real production, never collapsed).");
  add("           A re-send is the same building at the same spot: two placed");
  add("           in one second on different ground are two buildings, and a");
  add("           farm re-seeded later is its own line.");
  add("");

  const byPlayer = new Map();
  for (const r of rows) {
    if (!byPlayer.has(r.player_number)) byPlayer.set(r.player_number, new Map());
    const cats = byPlayer.get(r.player_number);
    if (!cats.has(r.category)) cats.set(r.category, new Map());
    const items = cats.get(r.category);
    const label = rowLabel(r);
    items.set(label, (items.get(label) || 0) + r.quantity);
  }

  for (const p of match.players) {
    if (players && !players.has(p.number)) continue;
    const counts = byPlayer.get(p.number) || new Map();
    add("=".repeat(68));
    add(`P${p.number} ${names.get(p.number) || displayName(p)} -- ${p.civilization}`);
    add("=".repeat(68));
    for (const category of CATEGORIES) {
      if (!categories.has(category)) continue;
      const items = counts.get(category) || new Map();
      let total = 0;
      for (const v of items.values()) total += v;
      add(`  ${LABELS[category]} (${total} total, ${items.size} distinct)`);
      if (!items.size) add("    (none recorded)");
      for (const [item, count] of mostCommon(items)) {
        add(`    ${padRight(item, 28)} x${count}`);
      }
      add("");
    }
  }

  if (showTimeline) {
    add("=".repeat(68));
    add("TIMELINE");
    add("=".repeat(68));
    for (const r of rows) {
      const qty = r.quantity > 1 ? ` x${r.quantity}` : "";
      const who = `P${r.player_number} ${r.player}`;
      add(`  [${r.time}] ${padRight(who, 22)} ${padRight(LABELS[r.category], 6)} ${rowLabel(r)}${qty}`);
    }
  }

  return lines.join("\n");
}

const CSV_FIELDS: (keyof EventRow)[] = [
  "seconds", "time", "player_number", "player", "category", "item", "quantity", "source",
];

function csvCell(value: Rec) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.split('"').join('""')}"` : text;
}

function toCsv(rows: EventRow[]): string {
  const out = [CSV_FIELDS.join(",")];
  for (const r of rows) out.push(CSV_FIELDS.map((f) => csvCell(r[f])).join(","));
  return out.join("\n") + "\n";
}

/**
 * Parse a recording and return the viewer JSON payload.
 *
 * @param {Uint8Array|ArrayBuffer|string} input recording bytes, or a path (Node)
 * @param {object} [options]
 * @param {string[]} [options.category] categories to keep (default: all three)
 * @param {number[]} [options.player]   player numbers to keep (default: all)
 * @param {number}   [options.dedupe=0] collapse re-sent build/tech within N seconds
 * @param {object}   [options.reference] reference-data override for parse_rec
 */
function filterEvents(input: RecordingInput, options: FilterOptions = {}): Payload {
  return filterEventsDetailed(input, options).payload;
}

/** filterEvents for the browser, where inflating the header is async. */
async function filterEventsAsync(
  input: RecordingInput, options: FilterOptions = {},
): Promise<Payload> {
  const match = await parseMatchAsync(input, options);
  return fromMatch(match, options).payload;
}

/** As filterEvents, but also returns the parsed match and the raw rows. */
function filterEventsDetailed(input: RecordingInput, options: FilterOptions = {}): FilterResult {
  return fromMatch(parseMatch(toBytes(input), options), options);
}

/** Build the rows and payload from an already-parsed match. */
function fromMatch(match: Match, options: FilterOptions = {}): FilterResult {
  const extras = readHeaderExtras(match, options);
  const names = nameMap(match, extras);
  const categories = new Set(options.category || CATEGORIES);
  const players = options.player ? new Set(options.player) : null;
  let rows = collect(match, categories, players, names);
  const window = options.dedupe || 0;
  if (window) rows = dedupe(rows, window);
  return {
    match,
    extras,
    names,
    categories,
    players,
    rows,
    payload: buildJson(match, rows, Boolean(window), extras),
  };
}

export {
  filterEvents,
  filterEventsAsync,
  filterEventsDetailed,
  fromMatch,
  toJson,
  toCsv,
  buildJson,
  buildReport,
  collect,
  classify,
  dedupe,
  readHeaderExtras,
  resolveName,
  nameMap,
  CATEGORIES,
};
