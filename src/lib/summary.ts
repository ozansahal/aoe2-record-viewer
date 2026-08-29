/**
 * How the recordings you have kept add up.
 *
 * The list answers "what did I play"; this answers "how am I doing". Same
 * rows, read the other way round -- a saved entry already carries the map, the
 * difficulty and who won, so nothing here parses anything or reads a payload.
 * It is arithmetic over `saved.entries` and no more than that.
 *
 * Two things it deliberately does not do. It never takes when the parse was
 * written for when the game was played -- see `playedAt` -- and it never counts
 * a recording whose owner is unknown, because "did you win" has no answer at
 * all for one of those. Those are reported as a count instead, so a total that
 * looks short says why.
 */
import type { SavedEntry } from "./savedStore";

/** A stretch of time the games are counted over. See `ladder` below. */
export interface Bucket {
  /** The React key. Not shown. */
  key: string;
  /** "Last week", "Rest of August", "2025". */
  label: string;
  /** Inclusive start, exclusive end, both epoch ms local. */
  start: number;
  end: number;
}

export interface Period extends Bucket {
  games: number;
  wins: number;
  /** The rows that fell in it, for the grid below. */
  entries: SavedEntry[];
  /**
   * One of the rolling windows at the top of the list, which nest and so hold
   * each other's games. The calendar rungs below them do not. See `ladder`.
   */
  rolling?: boolean;
}

/** One line of a breakdown: a map name, or a difficulty. */
export interface Split {
  key: string;
  games: number;
  wins: number;
}

/*
 * When the match was played.
 *
 * Three answers, in order of how much they know.
 *
 * The file's own last-edit time first. That is the moment the game finished
 * writing the replay, so it is the end of the match to the second -- and
 * unlike everything else here it is a fact about the recording rather than
 * about this app. It is only present where a folder listing supplied it; see
 * `modified` on `SavedEntry`.
 *
 * Then the timestamp the game builds the filename out of -- `MP Replay
 * v101.103.48987.0 @2026.08.17 212220` -- for rows that arrived as bare bytes,
 * a drop or a file association, where there was no listing to read an mtime
 * off. It names the moment the match *started* rather than the moment it
 * ended, which is why it is second: on the same recording the two differ by
 * the length of the game.
 *
 * `openedAt` last, and only because a recording named something else is still a
 * game that happened. `savedAt` is when this app first parsed it and `openedAt`
 * moves every time you look at it, so a summary built on either would drag a
 * game from March into this week the moment you opened it.
 */
const STAMP = /@(\d{4})\.(\d{2})\.(\d{2})[ _]?(\d{2})(\d{2})(\d{2})/;

export function playedAt(entry: SavedEntry): number {
  if (entry.modified) return entry.modified;
  const m = STAMP.exec(entry.name);
  if (!m) return entry.openedAt;
  const [, y, mo, d, h, mi, s] = m;
  /* Local time, because the game wrote it in local time and every label this
     feeds is local as well. */
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return Number.isFinite(t) ? t : entry.openedAt;
}

/**
 * Did the recording's own player win?
 *
 * `pov` is the client that wrote the file, which for the folder the game keeps
 * is you. Undefined means the recording named no owner, or was parsed before
 * that was carried -- neither is a loss, so those rows are left out entirely.
 * See `decided` below, which is the only thing that admits a row to the count.
 */
export const won = (entry: SavedEntry): boolean =>
  entry.pov !== undefined && Boolean(entry.players[entry.pov]?.winner);

/** A row a win or a loss can honestly be claimed about. */
export const decided = (entry: SavedEntry): boolean =>
  entry.pov !== undefined && entry.players[entry.pov] !== undefined;

const MONTH_OF = new Intl.DateTimeFormat(undefined, { month: "long" });

/** Midnight local, so two timestamps can be compared by day. */
function startOfDay(t: number): Date {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** `days` before the start of today, as a moment. See `ladder` below. */
function daysBack(now: number, days: number): number {
  const d = startOfDay(now);
  d.setDate(d.getDate() - days);
  return d.getTime();
}

const DAY = 24 * 60 * 60 * 1000;

const startOfMonth = (t: number): number => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};

const startOfYear = (t: number): number => new Date(new Date(t).getFullYear(), 0, 1).getTime();

/**
 * One rung of the ladder, as it would be if nothing above it existed.
 *
 * `end` is where the period naturally stops -- the end of that month, that
 * year, `Infinity` for one that is still running. A calendar step gets
 * whatever the steps above it have not already taken, which is how "August"
 * turns into "Rest of August"; a rolling one always gets its whole window.
 */
interface Step {
  start: number;
  end: number;
  name: string;
}

/**
 * The periods: three rolling windows -- the last day, the last week, the last
 * thirty days -- and then the calendar, coarsening as it goes back. The rest
 * of this month, last month, the rest of this year, then a row per year.
 *
 * Uniform weeks were what this used to be, and they are the wrong shape for
 * the question. Fourteen rows of "Jun 8 - Jun 14" all say the same thing --
 * that the week they name is *some* week -- and you have to do the arithmetic
 * yourself to find out which one you are in. How you have been doing lately
 * wants fine detail at the near end and none at the far one, so the rungs get
 * wider the further back they are and every one of them is named by where it
 * sits relative to today rather than by a date you have to place.
 *
 * The near rungs roll rather than sitting on the calendar. A Monday-to-Sunday
 * week means that on a Monday morning "this week" is one evening of games and
 * the fortnight you actually played is split across two rows below it -- the
 * answer moved because the calendar turned over, which is not a thing that
 * happened to your play. Seven days back from today always holds seven days of
 * it.
 *
 * The three of them nest, and are the one place this counts a game twice.
 * "Last week" means the last week, all of it, including the evening the row
 * above it is about; "Last 30 days" includes that week. Cut against each other
 * they would be honest totals and the wrong answers: the row called "Last
 * week" would hold the six days *before* today, so a good evening would leave
 * the week looking worse than it was by being excluded from it. What is being
 * asked of these three is "how am I doing over this long", and each one has to
 * answer for its whole window to mean that. The calendar rungs below are still
 * cut, against each other and against the deepest rolling window, so nothing
 * below the fold is counted twice and no game is missed.
 *
 * Rolling by whole days, not to the hour, for the week and the thirty: a game
 * seven days ago at nine in the evening would otherwise drop out of the window
 * at nine this evening, and a total that changes while you are looking at it
 * is worse than one that is a few hours generous. The day rung is the
 * exception -- it is twenty-four hours to the hour, because a session is what
 * it is asked about, and a day boundary splits an evening that ran past
 * midnight across two rows.
 *
 * The calendar rungs are cut against each other rather than being ranges in
 * their own right: a month can start inside the thirty-day window, so the
 * month it overlaps gets what is left of it and says so.
 *
 * A rung with no games is dropped -- a fortnight you did not play is a blank
 * row saying nothing, and the gap is legible from the labels either side. A
 * rolling rung holding exactly what the rung above it holds is dropped as
 * well: when the only games there are were played tonight, "Last week" and
 * "Last 30 days" are the same three games written out twice more, and three
 * identical rows say less than one.
 */
export function ladder(entries: SavedEntry[], now: number = Date.now()): Period[] {
  /* Today and the six days before it, which is seven days of play; likewise
     twenty-nine days back for thirty. */
  const week = daysBack(now, 6);
  const days30 = daysBack(now, 29);
  const month = startOfMonth(now);
  const year = new Date(now).getFullYear();

  /* Narrowest first, each one whole. See the note above on why these overlap. */
  const rolling: Step[] = [
    { start: now - DAY, end: Infinity, name: "Last 24 hours" },
    { start: week, end: Infinity, name: "Last week" },
    { start: days30, end: Infinity, name: "Last 30 days" },
  ];

  const calendar: Step[] = [
    { start: month, end: Infinity, name: MONTH_OF.format(month) },
    /* The month before this one, whichever year that lands in. */
    { start: startOfMonth(month - 1), end: month, name: MONTH_OF.format(startOfMonth(month - 1)) },
    { start: startOfYear(now), end: Infinity, name: String(year) },
  ];
  /* And a rung per year, back to the oldest game there is: without them the
     ladder would stop at January and everything before it would vanish. */
  const oldest = entries.reduce((t, e) => Math.min(t, playedAt(e)), now);
  for (let y = year - 1; y >= new Date(oldest).getFullYear(); y--) {
    calendar.push({
      start: new Date(y, 0, 1).getTime(),
      end: new Date(y + 1, 0, 1).getTime(),
      name: String(y),
    });
  }

  const rung = (step: Step, label: string, end: number): Period => ({
    key: `r${step.start}`,
    label,
    start: step.start,
    end,
    games: 0,
    wins: 0,
    entries: [],
  });

  const rungs: Period[] = rolling.map((step) => ({ ...rung(step, step.name, step.end), rolling: true }));
  /* What the rungs above have already claimed. The calendar starts under the
     deepest rolling window rather than at now, so the two halves of the list
     meet without overlapping: everything after that moment is up there. */
  let ceiling = days30;
  for (const step of calendar) {
    if (step.start >= ceiling) continue; // wholly inside a rung above it
    /* Whole when it reaches its own end, and the leftovers otherwise --
       "Rest of July" is July minus whatever the thirty days took out of it. */
    rungs.push(rung(step, ceiling >= step.end ? step.name : `Rest of ${step.name}`, ceiling));
    ceiling = step.start;
  }

  for (const entry of entries) {
    if (!decided(entry)) continue;
    const t = playedAt(entry);
    const win = won(entry) ? 1 : 0;
    /* Every rung it falls in, which is one of the calendar ones or however
       many of the rolling ones reach back that far. */
    for (const r of rungs) {
      if (t < r.start || t >= r.end) continue;
      r.games += 1;
      r.wins += win;
      r.entries.push(entry);
    }
  }

  const kept: Period[] = [];
  /* The last rolling rung that made the list. Nesting means the next one out
     can only match or beat it, and matching it is the same games again. */
  let above = -1;
  for (const r of rungs) {
    if (!r.games) continue;
    if (r.rolling) {
      if (r.games <= above) continue;
      above = r.games;
    }
    kept.push(r);
  }
  return kept;
}

/**
 * A breakdown, most-played first.
 *
 * Ties go alphabetically rather than in whatever order the store handed the
 * rows over, so the table does not reshuffle itself when one more game lands
 * in one of them.
 */
export function splitBy(entries: SavedEntry[], of: (entry: SavedEntry) => string): Split[] {
  const byKey = new Map<string, Split>();
  for (const entry of entries) {
    const key = of(entry) || "Unknown";
    let split = byKey.get(key);
    if (!split) byKey.set(key, (split = { key, games: 0, wins: 0 }));
    split.games += 1;
    if (won(entry)) split.wins += 1;
  }
  return [...byKey.values()].sort((a, b) => b.games - a.games || a.key.localeCompare(b.key));
}

/* The ramp's own order, so difficulty reads as a scale rather than as a league
   table sorted by how much you happened to play each rung. The words are the
   parser's; anything it does not recognize -- a localized recording -- sorts
   to the end. */
const RUNG = ["easiest", "standard", "moderate", "hard", "hardest", "extreme"];

const rungOf = (name: string): number => {
  const at = RUNG.indexOf(name.trim().toLowerCase());
  return at < 0 ? RUNG.length : at;
};

/** One square of the grid below: what happened on this map at this rung. */
export interface Cell {
  games: number;
  wins: number;
}

/** One rung of the ramp, across every map, plus what it came to. */
export interface CrossRow {
  key: string;
  /** One per column of `maps`, in that order. Zeroed where nothing was played. */
  cells: Cell[];
  total: Cell;
}

/**
 * The period as a grid: difficulty down the side, map across the top.
 *
 * The two separate breakdowns each answered half a question. "Arabia is 33%"
 * and "Hardest is 32%" do not say whether Arabia went badly *because* it was
 * the map you played the hardest AI on -- and that is the question, so the two
 * are one table with the totals down the last column and along the last row.
 *
 * Columns are ordered by how much they were played and rows by the ramp: a
 * grid is read across for "which map" and down for "how hard", and the second
 * of those is a scale, not a ranking.
 */
export interface Crosstab {
  /** The columns, most played first. */
  maps: string[];
  rows: CrossRow[];
  /** One per column, so the foot of the grid is the by-map breakdown. */
  mapTotals: Cell[];
  total: Cell;
}

export function crosstab(entries: SavedEntry[]): Crosstab {
  const maps = splitBy(entries, (e) => e.map).map((s) => s.key);
  /* Hardest first, easing downwards: the grid is read from the top, and the
     rung you are trying to clear is the one you look at first. */
  const rungs = splitBy(entries, (e) => e.difficulty)
    .sort((a, b) => rungOf(b.key) - rungOf(a.key) || b.games - a.games)
    .map((s) => s.key);

  const column = new Map(maps.map((name, at) => [name, at]));
  const zeros = (): Cell[] => maps.map(() => ({ games: 0, wins: 0 }));
  const rows: CrossRow[] = rungs.map((key) => ({ key, cells: zeros(), total: { games: 0, wins: 0 } }));
  const row = new Map(rows.map((r) => [r.key, r]));
  const mapTotals = zeros();
  const total: Cell = { games: 0, wins: 0 };

  for (const entry of entries) {
    /* The same fallback `splitBy` uses, so an entry always lands in the row
       and column its own key produced. */
    const at = column.get(entry.map || "Unknown");
    const line = row.get(entry.difficulty || "Unknown");
    if (at === undefined || !line) continue; // unreachable: both keys came from these entries
    const win = won(entry) ? 1 : 0;
    for (const cell of [line.cells[at], line.total, mapTotals[at], total]) {
      cell.games += 1;
      cell.wins += win;
    }
  }
  return { maps, rows, mapTotals, total };
}

/** Whole percent, and 0 for no games rather than a NaN. */
export const rate = (wins: number, games: number): number =>
  (games ? Math.round((wins / games) * 100) : 0);

/* ---- the four cards ----
 *
 * Four questions the ladder above cannot answer, because each of them is
 * about a *thing* -- a civ, a rung, a map -- rather than about a stretch of
 * time.
 *
 * They cover all time, deliberately, and every card says so on its own face.
 * Two reasons. A card wants a sample: the floor below is five games, and by
 * civ that is already a demand a fortnight of play will not meet for anything
 * -- cut to the last week the four of them would read "not enough games" most
 * evenings, which is a row of furniture saying nothing. And the period
 * question is already answered, twice, by the card beside these and the whole
 * list below: "how am I doing lately" is what that ladder is for, and these
 * are the other question -- what am I actually good at, over everything I have
 * kept. Anything that reads as a rate here therefore has to name its scope, or
 * it would be read as the near answer sitting next to it.
 */

/**
 * The floor a card's sample has to clear.
 *
 * A civ played once and won once is 100% and is not "most successful"; five is
 * where a rate stops being a coin. It is stated on every card that fails to
 * meet it, because "no answer" and "a bad answer" have to be told apart.
 */
export const MIN_GAMES = 5;

/** The civ *you* played: `pov` names the client that wrote the file. */
export const povCiv = (entry: SavedEntry): string =>
  (entry.pov !== undefined ? entry.players[entry.pov]?.civilization : "") || "Unknown";

/** A card's answer: what won, and what that was out of. */
export interface Leader {
  /** A civ name, a map name, a difficulty label. */
  key: string;
  games: number;
  wins: number;
}

/** The difficulty card also names the rung above the one you hold. */
export interface Rung extends Leader {
  /** The next rung up, or null at the top of the ramp. */
  next: string | null;
}

export interface Highlights {
  /** Best and worst by rate, of the civs that cleared the floor. */
  bestCiv: Leader | null;
  /** Null as well when only one civ cleared it -- that one is already above. */
  worstCiv: Leader | null;
  /** The hardest rung you hold a winning record on. */
  topRung: Rung | null;
  bestMap: Leader | null;
  /** Decided games behind all four, so a card can say what it read. */
  games: number;
}

/* Rate first, then the bigger sample, then the name -- so one more game
   landing in a tie does not reshuffle the card, and a 3/4 never outranks a
   12/16 that says the same thing with more behind it. */
const bestFirst = (a: Split, b: Split): number =>
  rate(b.wins, b.games) - rate(a.wins, a.games) || b.games - a.games || a.key.localeCompare(b.key);

/* The same, upside down, except that the tie-breaks do not flip: the weak spot
   worth naming is the one with the most games behind it either way. */
const worstFirst = (a: Split, b: Split): number =>
  rate(a.wins, a.games) - rate(b.wins, b.games) || b.games - a.games || a.key.localeCompare(b.key);

/* What cleared the floor and is worth naming. "Unknown" is `splitBy`'s
   fallback for a row that carried no civ or no map, and it is not an answer:
   "your best map is Unknown" is a bug report, not a stat. */
const answerable = (splits: Split[]): Split[] =>
  splits.filter((s) => s.games >= MIN_GAMES && s.key !== "Unknown");

const RUNG_NAME = ["Easiest", "Standard", "Moderate", "Hard", "Hardest", "Extreme"];

/**
 * The four cards, over every decided game there is.
 *
 * Hand it the same rows the rest of the page counts -- scenarios already
 * folded out or in. Undecided rows are dropped here rather than by the caller,
 * for the reason they are dropped everywhere else: a recording that names no
 * owner has no answer to "did you win", and counting it as a loss would make
 * every civ on the card look worse than it is.
 *
 * Best and worst civ are the same arithmetic read from both ends, which is
 * the pair worth having: the first says what to pick and the second says what
 * to practise. The rung is not a ranking -- easiest would win a league table
 * of difficulty every time -- so the question asked of it is the one a player
 * is actually asking, which is how far up the ramp the record still holds.
 */
export function highlights(entries: SavedEntry[]): Highlights {
  const games = entries.filter(decided);
  const civs = answerable(splitBy(games, povCiv));
  const maps = answerable(splitBy(games, (e) => e.map));

  const pick = (splits: Split[], order: (a: Split, b: Split) => number): Leader | null => {
    const [top] = [...splits].sort(order);
    return top ? { key: top.key, games: top.games, wins: top.wins } : null;
  };

  const best = pick(civs, bestFirst);
  const worst = pick(civs, worstFirst);

  /* Held rather than best: a winning record, on the hardest rung that has one.
     A label the ramp does not know -- a localized recording -- is left out
     rather than sorted to one end, since it has no position on the scale at
     all and would otherwise be crowned as the hardest thing you have beaten. */
  const held = answerable(splitBy(games, (e) => e.difficulty))
    .filter((s) => rungOf(s.key) < RUNG.length && rate(s.wins, s.games) > 50)
    .sort((a, b) => rungOf(b.key) - rungOf(a.key))[0];
  const at = held ? rungOf(held.key) : -1;

  return {
    bestCiv: best,
    /* Null where the two ends meet -- one civ over the floor, or every civ
       over it on the same record. Both of those name the same civ twice, once
       as the thing to pick and once as the thing to practise, which is a card
       spent on a joke. */
    worstCiv: worst && worst.key !== best?.key ? worst : null,
    topRung: held
      ? { key: held.key, games: held.games, wins: held.wins, next: RUNG_NAME[at + 1] ?? null }
      : null,
    bestMap: pick(maps, bestFirst),
    games: games.length,
  };
}
