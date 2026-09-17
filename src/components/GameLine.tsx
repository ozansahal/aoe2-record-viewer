import type { SavedEntry } from "../lib/savedStore";
import { difficultyStyle, fmt, playerColor } from "../lib/format";
import ui from "../styles/ui.module.css";
import styles from "./GameLine.module.css";

/*
 * One kept recording, drawn as a line.
 *
 * Two lists show this now -- the recordings page, and the last few games on
 * the summary -- and they are the same fact in both places: what the game was,
 * who played it, and whether it was yours. So the row's content lives here
 * rather than in either page, and the pages supply only what surrounds it: a
 * heading, a menu, whatever dates the row.
 *
 * It draws nothing about the *file*. A name, a folder, a size and a byte count
 * belong to the recordings page, which is the list you go to when the question
 * is where something is on disk; here the question is which match this was.
 */

/*
 * Who won, as a crown rather than a tick. A tick beside a name reads as
 * "checked" -- present, selected, done -- which is three things this is not.
 * Drawn rather than typed: the crown codepoints are emoji on Windows and come
 * out full-colour and off-baseline next to 11px text.
 */
export function Crown() {
  return (
    /* One solid silhouette rather than a crown with a separate band: it is
       drawn 12px wide, and at that size a 1px gap between two shapes reads as
       a rendering fault. */
    <svg className={styles.crown} viewBox="0 0 24 18" aria-hidden="true" focusable="false">
      <path d="M1 3.6 6.6 7.8 12 1.2l5.4 6.6L23 3.6l-1.8 12.8H2.8z" />
    </svg>
  );
}

/**
 * Did the player whose recording this is win it?
 *
 * That player is the one the file was written by -- see `pov` on the saved
 * row -- and for a folder the game wrote, it is you. Nothing else in a
 * recording knows which player somebody is: the winner is a side, and a name
 * belongs to whoever the lobby gave it to.
 *
 * False for a row with no parse behind it yet, for a recording that names no
 * owner on a side (nothing is inferred at all), and for anything parsed before
 * the owner was carried through. A game nobody resigned from reads as a loss:
 * the parser takes the missing resignation as the owner having quit.
 */
export function yours(entry: SavedEntry | null): boolean {
  if (!entry || entry.pov === undefined) return false;
  return Boolean(entry.players[entry.pov]?.winner);
}

/** The whole roster as text, for the tooltip of a row whose line cuts it. */
export function roster(entry: SavedEntry): string {
  return entry.players
    /* The crown as the character rather than the drawing: a tooltip is the
       platform's own text, and there is nothing to draw into. */
    .map((p) => `${p.winner ? "\u{1F451} " : ""}${p.name}${p.civilization ? ` (${p.civilization})` : ""}`)
    .join(", ");
}

/**
 * Who played, in whatever room the line has left.
 *
 * Two or three fit with their civs, and that is most of a folder. Past that it
 * depends on what the game was: a lobby of people is a row you look for *by
 * the names in it*, so a multiplayer game lists them however many there are --
 * without civs, on one line, cut off at the width rather than wrapped onto a
 * second one. A game against the computer is not looked for that way, and its
 * seven AI names would only crowd the line, so it keeps the count it had.
 *
 * Cutting off loses names, so the whole roster -- with civs, and with who won
 * -- goes on the row's tooltip.
 */
function who(entry: SavedEntry) {
  const many = entry.players.length > 3;
  if (many && entry.humans < 2) {
    const won = entry.players.filter((p) => p.winner);
    return (
      <span className={styles.roster}>
        <span className={styles.side}>
          {entry.players.length} players
          {/* Which side took it still fits, even when the roster does not. */}
          {won.length ? <><Crown />{won.length > 1 ? `${won.length} winners` : won[0].name}</> : null}
        </span>
      </span>
    );
  }
  const names = entry.players.map((p, i) => (
    <span key={i} className={styles.side} style={{ color: playerColor(p) }}>
      {p.winner ? <Crown /> : null}
      {p.name}
      {/* The civ is the other half of "who": a name says who was at the
          keyboard, the civ says what the game was. Dropped once there are
          enough names that the names are themselves what is short of room. */}
      {!many && p.civilization ? <span className={styles.civ}>{p.civilization}</span> : null}
    </span>
  ));
  /* One box for the lot, however few of them there are, because the cut has to
     be made once and at the end of the line.

     Two names used to be returned loose here, as flex items of the row, on the
     grounds that two always fit. They do not always fit, and what they did
     when they did not depended on the row: while `.what` wrapped, a name too
     many moved to a second line whole; now that it does not wrap, a loose name
     has nowhere to give and breaks *inside itself* -- "Tsar" on one line and
     "Konstantin" on the next, which is not a thing a name should ever do.
     Inside this box the line clips at its end and the row keeps its height. */
  return <span className={styles.roster}>{names}</span>;
}

/**
 * What the row is, in the gutter down its left.
 *
 * Whether people were at the other keyboards, and whether the recording's own
 * player won. Neither is anywhere else on the row -- an AI has a name and a
 * civ like anybody else, and the roster's crowns say which side took it, not
 * whether it was yours. Always rendered, empty or not, so the rows read as a
 * column with a marked-up margin rather than as lines that start in different
 * places.
 */
export function Gutter({ entry, mine }: {
  entry: SavedEntry | null;
  /**
   * Whether the recording is one of your games -- see `useIdentity`. False
   * marks the row: the owner is somebody else, so the crown, if there is
   * one, is theirs. Null, or left out, says nothing either way.
   */
  mine?: boolean | null;
}) {
  return (
    <span className={styles.gutter}>
      {entry && entry.humans >= 2 ? (
        <span className={styles.mp} title={`${entry.humans} human players`}>MP</span>
      ) : null}
      {yours(entry) ? (
        <span
          className={styles.win}
          title={`${entry!.players[entry!.pov!].name} won -- this is their recording`}
        >
          <Crown />
        </span>
      ) : null}
      {entry && mine === false ? (
        <span
          className={styles.other}
          title={`Recorded by ${entry.players[entry.pov!]?.name ?? "somebody else"}, not you`}
        >
          <Other />
        </span>
      ) : null}
    </span>
  );
}

/*
 * Somebody else's recording: a figure, outlined. The file was written by a
 * player who is not you -- a replay you downloaded or were sent -- and nothing
 * else on the row says so: the roster looks the same either way, and the
 * crown crowns whoever the file belongs to. Outlined rather than filled so it
 * does not compete with the crown, which is the mark that means something
 * went well.
 */
function Other() {
  return (
    <svg className={styles.figure} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M2.8 14.2c.5-3.1 2.6-4.6 5.2-4.6s4.7 1.5 5.2 4.6"
        fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      />
    </svg>
  );
}

interface Props {
  entry: SavedEntry;
  /** The recording is already open in a tab, so its map is drawn as the accent. */
  accent?: boolean;
  /**
   * Put the roster on a line of its own under the columns.
   *
   * On one line the roster is the last thing on it and the first thing to run
   * out of room, so it wraps -- and because it is a row of separate names, it
   * wraps *between two of them*: one player on the first line and one on the
   * second, at whatever point the width happened to fall. Rows came out one
   * line tall or two depending on how long the AI's name was, which is the
   * kind of raggedness a list is read down.
   *
   * Given its own line the break is deliberate and always in the same place,
   * every row is the same height, and the roster gets the full width instead
   * of the remainder. The recordings page does not want this -- it already has
   * a second line, for the file -- so it is asked for rather than assumed.
   */
  stack?: boolean;
}

/**
 * The line itself: map, difficulty, duration, roster.
 *
 * Map, difficulty and duration are columns rather than words in a sentence:
 * each holds its width whether or not the row has one, so the eye reads down
 * them instead of hunting along every line for where the last map name
 * happened to end. The roster takes whatever is left, and is the only part
 * that moves -- onto a line of its own, where `stack` asks for it.
 */
export function GameLine({ entry, accent, stack }: Props) {
  const columns = (
    <>
      <span className={accent ? `${styles.map} ${styles.accent}` : styles.map}>{entry.map}</span>
      <span className={styles.diff}>
        {entry.difficulty ? (
          <span className={ui.diffPill} style={difficultyStyle(entry.difficulty)}>
            {entry.difficulty}
          </span>
        ) : null}
      </span>
      <span className={styles.dur}>{fmt(entry.duration)}</span>
    </>
  );

  if (!stack) {
    return <span className={styles.what}>{columns}{who(entry)}</span>;
  }
  return (
    <span className={styles.stacked}>
      <span className={styles.what}>{columns}</span>
      <span className={styles.players}>{who(entry)}</span>
    </span>
  );
}
