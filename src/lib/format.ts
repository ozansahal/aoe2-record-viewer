import type { CSSProperties } from "react";
import type { Category, Player } from "../types";

/**
 * How long a re-sent build/tech order is folded into the previous one, matching
 * the --dedupe default the JSON exporter uses.
 */
export const DEDUPE_SECONDS = 30;

/**
 * Which counting rules a saved payload was made under.
 *
 * Bump when a change to filter_events makes the same recording, at the same
 * dedupe window, come out as different numbers. It rides in the save key for
 * the reason the window already does -- a payload counted under the old rules
 * is a different answer to the same question, and a cache that cannot tell
 * them apart serves the old one forever.
 *
 * 2: a build is deduped by where it was placed, not by name and clock alone,
 * and a building put back where the same player already had one is counted on
 * its own line. Before it, 36 farms counted 10.
 *
 * 3: that second line is Farms only. A recording never says a building stopped
 * standing, so a repeated Build order at an anchor was counting placement
 * mashing as rebuilding -- seven phantom Siege Workshop "rebuilds" in
 * `.data/rec.aoe2record`, and a Town Center, Archery Range, Siege Workshop and
 * Stable in `rec-old`. A re-seeded farm is the one case the anchor test gets
 * right on its own, so it is the only case left.
 */
export const EVENTS_RULES = 3;

export const CATS: { key: Category; label: string; varname: string }[] = [
  { key: "build", label: "Build", varname: "--build" },
  { key: "tech", label: "Tech", varname: "--tech" },
  { key: "unit", label: "Unit", varname: "--unit" },
];

/** AoE2 player colors -> something readable on both themes. */
const PCOLOR: Record<string, string> = {
  blue: "#4a7fd4", red: "#d0524a", green: "#4fa04f", yellow: "#d2b03a",
  cyan: "#3fb0c2", purple: "#9059c4", grey: "#8b949e", gray: "#8b949e",
  orange: "#d4823a",
};

export function playerColor(p: Pick<Player, "color">): string {
  return PCOLOR[String(p.color || "").toLowerCase()] || "var(--accent)";
}

/** m:ss, or h:mm:ss past an hour. */
export function fmt(seconds: number): string {
  const sec = Math.max(0, Math.round(seconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
}

/*
 * The difficulty ramp, keyed by the label the parser produces. Two sources
 * write that label -- the instructions block, in the game's own words, and the
 * id table -- and only the English ones are recognized here: a localized
 * recording keeps the word and loses the colour, which is the right way round.
 * "Extreme" is not in the id table at all; DE writes it into the instructions.
 */
const DIFFICULTY: Record<string, string> = {
  easiest: "--diff-easiest", standard: "--diff-standard", moderate: "--diff-moderate",
  hard: "--diff-hard", hardest: "--diff-hardest", extreme: "--diff-extreme",
};

/**
 * The pill's fill and the one foreground that goes on all six, or undefined
 * where the label is not one the ramp knows -- ui.diffPill's own grey is what
 * that gets, and it is the right answer: a colour guessed from an unrecognized
 * word would be a scale position the recording never stated.
 */
export function difficultyStyle(difficulty: string | undefined): CSSProperties | undefined {
  const varname = DIFFICULTY[String(difficulty || "").trim().toLowerCase()];
  return varname ? { background: `var(${varname})`, color: "var(--diff-ink)" } : undefined;
}

const AGO = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** Seconds in each unit, largest first: the first one that fits is the one used. */
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/**
 * How long ago, in words -- "3 hours ago", "yesterday", "last month".
 *
 * A date told you when the last game was; this tells you what you actually
 * wanted to know, which is how long it has been. "Aug 24" is a lookup against
 * today's date every time it is read, and on the row that says *this week* it
 * was the one figure you had to do arithmetic on.
 *
 * `numeric: "auto"` is what turns the ones with names into their names --
 * yesterday rather than "1 day ago". Every caller keeps the full date on the
 * tooltip, for when the exact day is the thing being looked for.
 *
 * It lives here rather than on the summary page because both lists of
 * recordings date their rows this way now, and two copies of a clock drift.
 */
export function ago(when: number, now: number = Date.now()): string {
  const seconds = Math.round((when - now) / 1000);
  const size = Math.abs(seconds);
  if (size < 60) return "just now";
  for (const [unit, span] of UNITS) {
    if (size >= span) return AGO.format(Math.round(seconds / span), unit);
  }
  return "just now"; // unreachable: a minute is the smallest unit above
}

/** The date and the time of day, for the tooltip under an `ago`. */
export const WHEN = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * A win rate, as a colour.
 *
 * Five bands rather than the three this started with, because a record is read
 * as a grade and not as a verdict: 95% and 60% are both "winning" and nobody
 * means the same thing by them. So the ramp runs cyan at the top, through
 * green and yellow and orange, to red -- the order every ladder in every game
 * uses, which is what makes it readable without a key.
 *
 * The boundaries are the user's: 95, 80, 60, 40. They are deliberately not
 * even fifths -- most of the interesting range of an AI ladder sits above 50%,
 * so the bands are tight at the top and wide at the bottom.
 */
export function rateColor(pct: number): string {
  if (pct >= 95) return "var(--rate-elite)";
  if (pct >= 80) return "var(--rate-good)";
  if (pct >= 60) return "var(--rate-fair)";
  if (pct >= 40) return "var(--rate-poor)";
  return "var(--rate-bad)";
}
