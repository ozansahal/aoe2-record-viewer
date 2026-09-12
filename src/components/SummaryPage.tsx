import { Fragment, type CSSProperties, useMemo, useState } from "react";

import type { Saved } from "../hooks/useSaved";
import { ago, difficultyStyle, rateColor, WHEN } from "../lib/format";
import type { SavedEntry } from "../lib/savedStore";
import {
  crosstab,
  decided,
  ladder,
  playedAt,
  rate,
  won,
  type Cell,
  type Period,
} from "../lib/summary";
import ui from "../styles/ui.module.css";
import { RecentGames } from "./RecentGames";
import { StatCards } from "./StatCards";
import styles from "./SummaryPage.module.css";

/*
 * How you are doing, out of the recordings that are already parsed.
 *
 * The second permanent tab, and the other way of reading the rows the
 * recordings page lists: that one is "what did I play", this one is "what came
 * of it". Nothing here opens a file or parses one -- a saved row already
 * carries the map, the difficulty and who won -- so this is arithmetic over
 * the store and costs nothing to put on screen.
 *
 * Which is also its limit: it only knows what has been parsed. A folder the
 * background scan has not been through yet gives a summary of the part of it
 * that has, and the page says so rather than presenting a short total as the
 * whole truth.
 *
 * The list is a ladder rather than a calendar -- the last twenty-four hours,
 * the last week, the last thirty days, then the rest of this month, last
 * month, the rest of this year, a year at a time -- because "how am I doing
 * lately" wants detail at the near end and none at the far one. Fourteen rows
 * of "Jun 8 – Jun 14" were fourteen dates to place before any of them meant
 * anything. The three near rungs roll with the day rather than starting on a
 * Monday, so what they hold is always seven days, or thirty, of play -- and
 * they nest, each one holding the ones above it, which is the only place on
 * the page a game is counted twice. The foot of the list says so. See `ladder`
 * in lib/summary.ts.
 *
 * Every row in it opens. A period says how the week went; what you want next
 * is always which maps and which difficulties that was, so the breakdown is
 * inside the row rather than in a panel beside it. It used to be beside it,
 * driven by a selected row -- which meant the numbers you were reading and the
 * date they belonged to were at opposite ends of the page.
 *
 * One at a time. The grid is five or six rows tall and the list is only five
 * or six rows long, so a second one open pushed the first off the screen and
 * left you scrolling between two things you were trying to hold side by side.
 * The one comparison that is worth making without scrolling -- the last week
 * against the week before it -- is on the card instead.
 */

/** The row at the top of the list: everything, however long that is. */
const ALL = "all";

/* A period runs from midnight to midnight, so its bounds are days and not
   moments: `WHEN` carries a time of day, which on these two would be "12:00
   AM" and "11:59 PM" every time and say nothing. */
const DAYS = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * The dates a period actually covers, for its tooltip.
 *
 * The labels are relative -- "Last week", "Rest of August" -- which is what
 * makes them readable and also the one thing they do not say. This is where
 * the two dates live, for when the question is which days exactly.
 */
function span(period: Period): string | undefined {
  if (!period.start) return undefined; // all time, which spans whatever there is
  const from = DAYS.format(new Date(period.start));
  return period.end === Infinity
    ? `${from} — today`
    : `${from} — ${DAYS.format(new Date(period.end - 1))}`;
}
/**
 * The wider windows, in a second card under the first.
 *
 * The card answers "how am I doing" for the narrowest period there is
 * anything in -- usually tonight -- and on its own that is a figure with
 * nothing to hold it against. A run of three games is 33% or 67% depending on
 * one of them, and the week and the month behind it are what say whether that
 * is a bad night or how you play.
 *
 * They sit under the card rather than being read off the list below it
 * because the list is cut into rungs and these are not: "Last week" here is
 * the whole week, tonight included, which is the number you would have to add
 * two rows together to get. Under and not beside: side by side the two read as
 * answers of equal standing, and the near one is the answer.
 *
 * One card with a row each rather than a card each. The same figures in the
 * same order as the card next to it -- the period and its rate, then games,
 * won, lost -- because three cards in three shapes read as three unrelated
 * things, and these are one question asked over three lengths of time. Only
 * the size separates them now: the rate here is at the value size rather than
 * the card's 40px, which is what keeps the card the answer and these the
 * context for it.
 *
 * A grid rather than a row of flex boxes, so games sits over games down the
 * card: each `dl` is `display: contents`, which lets the pairs inside it be
 * the grid's cells while the period they belong to stays one list.
 */
function Windows({ periods }: { periods: Period[] }) {
  return (
    <div className={styles.windows}>
      {periods.map((period, at) => {
        const pct = rate(period.wins, period.games);
        return (
          <Fragment key={period.key}>
            {/* Between the rows, not around them: a rule of its own rather than
                a border on the cells, because the columns are separated by a
                gap and a border per cell would draw the line in pieces. */}
            {at ? <div className={styles.rule} /> : null}
            <dl className={styles.windowRow} title={span(period)}>
              <div>
                <dt>{period.label}</dt>
                <dd className={styles.windowRate} style={{ color: rateColor(pct) }}>{pct}%</dd>
              </div>
              <div><dt>Games</dt><dd>{period.games}</dd></div>
              <div><dt>Won</dt><dd className={styles.wins}>{period.wins}</dd></div>
              <div><dt>Lost</dt><dd className={styles.losses}>{period.games - period.wins}</dd></div>
            </dl>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * How the card's period compares with the one before it.
 *
 * In points rather than as a ratio: 25% to 40% is fifteen points, and calling
 * it "60% better" would be arithmetic about the arithmetic. The period it is
 * measured against is named on the tooltip, because which one that is depends
 * on what you have played -- the rung under the last week is usually the week
 * before it, but a fortnight off makes it the rest of the month.
 *
 * The triangle is drawn rather than typed, for the reason the chevron is: the
 * codepoint renders as emoji on Windows, full-colour and off-baseline beside
 * the number it belongs to.
 */
function Delta({ points, against }: { points: number; against: Period }) {
  const up = points > 0;
  const was = rate(against.wins, against.games);
  const title = `${against.label}: ${was}% (${against.wins}/${against.games})`;
  const label = points === 0
    ? `No change from ${against.label}`
    : `${up ? "Up" : "Down"} ${Math.abs(points)} points from ${against.label}`;
  return (
    <span
      className={styles.delta}
      style={{ color: points === 0 ? undefined : `var(${up ? "--unit" : "--red"})` }}
      title={title}
      aria-label={label}
    >
      {points === 0 ? (
        <>±0</>
      ) : (
        <>
          <svg className={styles.arrow} viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <path d={up ? "M5 2.2 9 7.8H1z" : "M5 7.8 1 2.2h8z"} fill="currentColor" />
          </svg>
          {Math.abs(points)}
        </>
      )}
    </span>
  );
}

/**
 * Wins as a bar as well as a number.
 *
 * The number is the answer; the bar is what makes a column of them readable
 * without doing the arithmetic on every row. Losses are the track rather than
 * a second colour -- a two-colour bar reads as a comparison between two
 * things, and this is one thing out of a total.
 */
function Bar({ wins, games }: { wins: number; games: number }) {
  const pct = rate(wins, games);
  return (
    <span className={styles.bar} aria-hidden="true">
      {/* The same colour the figure beside it takes, or the bar would be
          arguing with the number: a red 25% over a green bar reads as two
          different opinions of one record. */}
      <span
        className={styles.fill}
        style={{ width: `${pct}%`, background: rateColor(pct) }}
      />
    </span>
  );
}

/**
 * The record and the rate, in the columns every table on this page shares.
 *
 * Won and played are one column rather than two: "17/43" is how anybody says
 * it out loud, it is read as a single fact, and it gives the width back to the
 * map names -- which are the part of a row that was actually short of room.
 */
function Figures({ wins, games }: { wins: number; games: number }) {
  const pct = rate(wins, games);
  return (
    <>
      <span className={styles.record}>
        <span className={styles.wins}>{wins}</span>
        <span className={styles.of}>/{games}</span>
      </span>
      <span className={styles.num} style={{ color: rateColor(pct) }}>{pct}%</span>
      <Bar wins={wins} games={games} />
    </>
  );
}

/**
 * The column headings, which are also the panel's head.
 *
 * There was a titled bar above this saying "When", with the headings
 * underneath it -- two strips of small grey capitals stacked on each other,
 * the first of which named something the first column already names. So the
 * headings moved up into it and took its styling with them.
 */
function Head({ first }: { first: string }) {
  return (
    <div className={`${styles.trow} ${styles.thead}`} role="row">
      <span role="columnheader">{first}</span>
      <span className={styles.record} role="columnheader">Won/played</span>
      <span className={styles.num} role="columnheader">Rate</span>
      <span role="columnheader" aria-label="Win rate" />
    </div>
  );
}

/**
 * The disclosure marker on a date.
 *
 * Drawn rather than typed, for the reason the crown on the files page is: the
 * triangle codepoints render as emoji on Windows, full-colour and off-baseline
 * beside the text they belong to. It turns rather than being swapped for a
 * second glyph, so the closed and open states are the same shape.
 */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? `${styles.chevron} ${styles.down}` : styles.chevron}
      viewBox="0 0 10 10" aria-hidden="true" focusable="false"
    >
      <path d="M3.5 1.5L7 5l-3.5 3.5" fill="none" stroke="currentColor"
        strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A square of the grid: won out of played, and what that comes to.
 *
 * Bare figures, on no fill of their own. A wash tinted by the rate was here for
 * a while and it read as a heat map -- which is a chart, and this is a table
 * you look numbers up in. The rate is written out instead, smaller and in
 * brackets: it is the record restated, not a third number.
 *
 * A square with no games in it says so with a dash: nothing was played there,
 * which is a different fact from having lost it.
 */
function Square({ cell }: { cell: Cell }) {
  if (!cell.games) {
    return <span className={`${styles.cell} ${styles.nil}`} role="cell">–</span>;
  }
  return (
    <span className={styles.cell} role="cell">
      <span className={styles.wins}>{cell.wins}</span>
      <span className={styles.of}>/{cell.games}</span>
      <span className={styles.pct}>({rate(cell.wins, cell.games)}%)</span>
    </span>
  );
}

/**
 * The period as a grid: difficulty down the side, map across the top.
 *
 * Two separate tables each answered half a question -- "Arabia is 33%" and
 * "Hardest is 32%" do not say whether the map went badly because it is the one
 * you play the hardest AI on. So they are one table, and both breakdowns are
 * still in it: the last column is by difficulty and the top row is by map,
 * read off the edges of the grid they came from.
 *
 * The columns are declared from the code because how many there are is the
 * data -- a week is three maps and a year is twenty. Past the width the grid
 * scrolls sideways with the difficulty column pinned, rather than squeezing
 * every map name down to an ellipsis.
 */
function Matrix({ period }: { period: Period }) {
  const grid = useMemo(() => crosstab(period.entries), [period]);
  const columns: CSSProperties = {
    gridTemplateColumns: `minmax(115px, 1.2fr) repeat(${grid.maps.length + 1}, minmax(104px, 1fr))`,
  };

  return (
    <div className={styles.matrixWrap}>
      <div
        className={styles.matrix}
        style={columns}
        role="table"
        aria-label="Difficulty by map"
      >
        <div className={styles.mrow} role="row">
          <span className={`${styles.corner} ${styles.mhead}`} role="columnheader">Difficulty</span>
          {grid.maps.map((map) => (
            <span className={styles.mhead} role="columnheader" key={map} title={map}>{map}</span>
          ))}
          {/* The by-difficulty breakdown lives down this column. */}
          <span className={`${styles.mhead} ${styles.edge}`} role="columnheader">All maps</span>
        </div>

        {/* The by-map breakdown, directly under the map names it belongs to:
            it is the line most of the reading starts from, and the rungs go
            hardest first below it. */}
        <div className={`${styles.mrow} ${styles.edge}`} role="row">
          <span className={`${styles.corner} ${styles.rung}`} role="rowheader">All difficulties</span>
          {grid.mapTotals.map((cell, at) => (
            <Square key={grid.maps[at]} cell={cell} />
          ))}
          <Square cell={grid.total} />
        </div>

        {grid.rows.map((row) => (
          <div className={styles.mrow} role="row" key={row.key}>
            <span className={`${styles.corner} ${styles.rung}`} role="rowheader">
              <span className={ui.diffPill} style={difficultyStyle(row.key)}>{row.key}</span>
            </span>
            {row.cells.map((cell, at) => (
              <Square key={grid.maps[at]} cell={cell} />
            ))}
            <Square cell={row.total} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * One date, and -- when it is open -- what the games under it were.
 *
 * The two tables are built here rather than by the page, so a closed row costs
 * nothing but its own arithmetic: a folder of a thousand recordings is a
 * hundred periods, and splitting every one of them by map to draw twelve would
 * be most of the work on the page thrown away.
 */
function PeriodRow({ period, open, onToggle }: {
  period: Period;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={open ? `${styles.group} ${styles.opened}` : styles.group}>
      <button
        className={open ? `${styles.trow} ${styles.pickable} ${styles.on}` : `${styles.trow} ${styles.pickable}`}
        aria-expanded={open}
        title={span(period)}
        onClick={onToggle}
      >
        <span className={styles.key}>
          <Chevron open={open} />
          {period.label}
        </span>
        <Figures wins={period.wins} games={period.games} />
      </button>
      {/* Built only while it is open, so a closed row costs nothing but its own
          arithmetic: a folder of a thousand recordings is a hundred periods,
          and crossing every one of them to draw twelve would be most of the
          work on the page thrown away. */}
      {open ? (
        <div className={styles.detail}>
          <div className={styles.detailHead}>
            <span>Difficulty by map</span>
            <span className={ui.spacer} />
            <span className={styles.aside}>Won / played</span>
          </div>
          <Matrix period={period} />
        </div>
      ) : null}
    </div>
  );
}

interface Props {
  saved: Saved;
  /** Opens the recordings page -- which is a tab that may well be closed. */
  onRecordings: () => void;
  /** Opens one kept recording, from the last-games list. */
  onOpen: (entry: SavedEntry) => void;
  /** Recordings already in a tab, by name, so a row can say so. */
  openNames: Set<string>;
  /** A parse is running; opening another one now would race it. */
  busy: boolean;
}

export function SummaryPage({ saved, onRecordings, onOpen, openNames, busy }: Props) {
  /* Off by default, exactly as the recordings list has it: a dozen attempts at
     one campaign mission would otherwise be most of the record. */
  const [scenariosIncluded, setScenariosIncluded] = useState(false);
  /* Which date is open -- one, or none. `touched` is what lets "nothing opened
     yet" mean the first period rather than a shut list. */
  const [open, setOpen] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  /* Folding the scenarios in rebuilds the list, so what was open in the old
     one means nothing in the new. */
  const reset = () => { setOpen(null); setTouched(false); };

  const counted = useMemo(
    () => saved.entries.filter((e) => scenariosIncluded || !e.scenario),
    [saved.entries, scenariosIncluded],
  );
  const scenarios = useMemo(
    () => saved.entries.filter((e) => e.scenario && decided(e)).length,
    [saved.entries],
  );
  /* Recordings that name no owner: nothing here can say whether you won one,
     so they are left out and counted. See `decided` in lib/summary.ts. */
  const unknown = useMemo(() => counted.filter((e) => !decided(e)).length, [counted]);
  const games = useMemo(() => counted.filter(decided), [counted]);

  const list = useMemo(() => ladder(counted), [counted]);

  /* Everything, shaped as a period, so the row at the top of the list opens on
     the same two tables every row under it does. */
  const everything: Period | null = useMemo(() => {
    if (!games.length) return null;
    return {
      key: ALL,
      label: "All time",
      start: 0,
      end: 0,
      games: games.length,
      wins: games.filter(won).length,
      entries: games,
    };
  }, [games]);

  /* The one at the top of the page: the narrowest rung there is anything in,
     which is the question the page is usually being opened to answer -- and
     the rung under it, which is what makes that figure mean anything. */
  const latest = list[0] ?? everything;
  const against = list[0] ? list[1] ?? null : null;
  const last = useMemo(
    () => (latest?.entries.length ? Math.max(...latest.entries.map(playedAt)) : null),
    [latest],
  );

  /* The rolling windows the card is not already showing: the week and the
     thirty days when the card is tonight, the thirty days alone when there is
     no tonight, and nothing at all when they hold the same games it does --
     `ladder` has already dropped those. */
  const alongside = useMemo(
    () => list.filter((p) => p.rolling && p.key !== latest?.key),
    [list, latest],
  );

  /* Untouched, the first period is the open one -- the page arrives showing
     something rather than a list to click. */
  const showing = touched ? open : list[0]?.key ?? null;
  const toggle = (key: string) => {
    setOpen(showing === key ? null : key);
    setTouched(true);
  };

  const nothing = !saved.entries.length;

  return (
    <section className={styles.summary} aria-label="Summary">
      {nothing ? (
        <div className={styles.welcome}>
          <h3 className={styles.welcomeTitle}>See the whole game again</h3>
          <p className={styles.lead}>
            Open a recorded Age of Empires II: Definitive Edition game and every
            order in it is laid out along a timeline — each building placed, each
            technology started, each unit queued, for every player. Move to any
            moment and read what the game looked like then.
          </p>
          <ul className={styles.points}>
            <li>
              <strong>It stays on your device.</strong> The recording is read here.
              Nothing is uploaded, and the app does not use the network at all.
            </li>
            <li>
              <strong>A map of the match.</strong> The terrain, the buildings as they
              go up, and where the fighting happened.
            </li>
            <li>
              <strong>One tab per game.</strong> Open several at once and switch
              between them; each keeps its own place on the timeline.
            </li>
            <li>
              <strong>Games you open are kept</strong>, and this page starts adding
              them up — how the last few nights went, and which games those were.
            </li>
          </ul>
          <button className={ui.ghost} onClick={onRecordings}>Open a recording</button>
        </div>
      ) : !latest ? (
        <div className={styles.empty}>
          <div>No game here says who won.</div>
          <div className={ui.hint}>
            A recording only names a winner for the player whose own game wrote it,
            and none of the games kept here does. Open one again and the result
            comes with it.
          </div>
        </div>
      ) : (
        <div className={styles.body}>
          {/* Where you are now, and what you just played, side by side.
              Both answer "how is it going" and neither is a table: the figures
              say how the week went, the list says which games that was, and
              reading one immediately wants the other. The dated rungs below
              are the archive, and they start where these two end. */}
          <div className={styles.top}>
          <div className={styles.cards}>
            <div className={styles.totals}>
              {/* Two rows of the same thing: a label in small capitals with its
                  figure under it. The period and when it last had a game are the
                  pair that says what you are looking at, so they take the first
                  row -- the rate is the period's figure, which is why it sits
                  under the period's name rather than beside it. */}
              <dl className={styles.stats}>
                <div>
                  <dt>{latest.label}</dt>
                  <dd className={styles.rateCell}>
                    <span
                      className={styles.bigNum}
                      style={{ color: rateColor(rate(latest.wins, latest.games)) }}
                    >
                      {rate(latest.wins, latest.games)}%
                    </span>
                    {/* Against the period below it in the list -- the wider
                        window it sits inside, or the calendar month under it --
                        which is the comparison you would make by reading down the
                        list, and the only one the card can make without becoming
                        a chart. */}
                    {against ? (
                      <Delta
                        points={rate(latest.wins, latest.games) - rate(against.wins, against.games)}
                        against={against}
                      />
                    ) : null}
                  </dd>
                </div>
                {last !== null ? (
                  <div>
                    <dt>Last played</dt>
                    {/* The date itself is on the tooltip: the answer here is how
                        long it has been, and that is what gets read. */}
                    <dd title={WHEN.format(new Date(last))}>{ago(last)}</dd>
                  </div>
                ) : null}
              </dl>
              <dl className={styles.stats}>
                <div><dt>Games</dt><dd>{latest.games}</dd></div>
                <div><dt>Won</dt><dd className={styles.wins}>{latest.wins}</dd></div>
                <div><dt>Lost</dt><dd className={styles.losses}>{latest.games - latest.wins}</dd></div>
              </dl>
            </div>
            {alongside.length ? <Windows periods={alongside} /> : null}
          </div>

          {/* The other axis. Everything to the left of these and everything
              below them is about *when* -- how the night went, how the week
              went, how the year went. These four are about *what*: the civ,
              the rung and the map, which are the three things a saved row
              knows you chose. They cover all time and say so on each card,
              because the card immediately beside them is usually tonight. See
              `highlights` in lib/summary.ts. */}
          <StatCards entries={counted} />

          {/* The end of the list you would otherwise go to the recordings page
              for, on the page you land on -- and the way to the rest of it. It
              takes the wider column: a card is four figures and a row is a
              whole match, so the room belongs here. */}
          <RecentGames
            entries={counted}
            onOpen={onOpen}
            onShowAll={onRecordings}
            openNames={openNames}
            busy={busy}
          />
          </div>

          <section className={styles.panel} aria-label="Periods">
            <div className={styles.table} role="table">
              <Head first="Period" />
              {everything ? (
                <PeriodRow
                  period={everything}
                  open={showing === ALL}
                  onToggle={() => toggle(ALL)}
                />
              ) : null}
              {list.map((p) => (
                <PeriodRow
                  key={p.key}
                  period={p}
                  open={showing === p.key}
                  onToggle={() => toggle(p.key)}
                />
              ))}
            </div>
          </section>

          {/* What is not in the numbers above. A summary that quietly drops
              rows is one you cannot trust, and both of these are dropped for a
              reason worth stating. The Scenarios toggle sits on this line
              beside the count it decides: the page no longer has a titled bar
              at the top for a control to live on. */}
          {unknown || scenarios ? (
            <p className={styles.foot}>
              {unknown ? (
                <>
                  {unknown === 1
                    ? "One kept parse names no player as its owner and is left out"
                    : `${unknown} kept parses name no player as their owner and are left out`}
                  {" — there is nobody for a win to belong to."}
                  {scenarios ? " " : null}
                </>
              ) : null}
              {scenarios ? (
                <>
                  {scenariosIncluded
                    ? `Campaign and scenario recordings are included (${scenarios}).`
                    : `${scenarios} campaign and scenario ${scenarios === 1 ? "recording is" : "recordings are"} left out.`}
                  {" "}
                  <button
                    className={styles.scenarios}
                    aria-pressed={scenariosIncluded}
                    onClick={() => { setScenariosIncluded((was) => !was); reset(); }}
                    title="Campaign missions and challenges are left out by default: a dozen attempts at one mission would be most of the record."
                  >
                    Scenarios
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
          {/* The one place on the page a game is counted twice, said out loud
              where it is being read. See `ladder` in lib/summary.ts. */}
          {list.some((p) => p.rolling) ? (
            <p className={styles.foot}>
              The rolling periods at the top of the list hold each other’s games —
              the last week includes the last day — so those rows overlap rather
              than adding up. Everything from the first month down is counted once.
            </p>
          ) : null}
          <p className={styles.foot}>
            Only recordings that have been parsed are counted. The recordings page
            reads the folder through in the background, and this fills in as it goes.
          </p>
        </div>
      )}
    </section>
  );
}
