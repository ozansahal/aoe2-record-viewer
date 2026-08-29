import type { ReactNode } from "react";

import { difficultyStyle, rateColor } from "../lib/format";
import type { SavedEntry } from "../lib/savedStore";
import { highlights, MIN_GAMES, rate, type Leader } from "../lib/summary";
import ui from "../styles/ui.module.css";
import styles from "./StatCards.module.css";

/*
 * Four small cards, between the totals and the last games.
 *
 * The card to their left and the list below it are both about *when*: how the
 * week went, how the month went, how the year went. These four are the other
 * axis -- what you are good at rather than how it has been going -- and there
 * is one of them per thing a saved row knows you chose: the civ you picked,
 * the rung you set the AI to, the map you queued on.
 *
 * They are all time, and each one says so on the line under its figure. That
 * is not decoration: the card immediately to the left of these is usually
 * *tonight*, and two rates side by side with only one of them dated would be
 * read as the same window. The reason for all time is the floor -- five games
 * on one civ is not a week's worth of play, and four cards reading "not enough
 * games" every evening would be furniture. See `highlights` in lib/summary.ts.
 *
 * A dimmed title over the data, in the same small grey capitals every label on
 * this page wears, at the same `--text-title` value size, on the same fill and border
 * and shadow as the two cards beside them. This is a third thing in an
 * established row, not a new idea: nothing here is a colour or a size the page
 * did not already have.
 */

/**
 * The two lines under a title: the answer, then what it was out of.
 *
 * The rate is the only coloured thing on the card and it takes the page's own
 * ramp, so a green here means what a green means in the grid below. The record
 * and the scope share the faint line under it -- both of them qualify the
 * figure rather than being figures, and a sample you cannot see is what makes
 * a rate a lie.
 */
function Figure({ of }: { of: Leader }) {
  const pct = rate(of.wins, of.games);
  return (
    <>
      <div className={styles.rate} style={{ color: rateColor(pct) }}>{pct}%</div>
      <div className={styles.sample}>
        <span className={styles.wins}>{of.wins}</span>
        <span className={styles.of}>/{of.games}</span>
        {" · all time"}
      </div>
    </>
  );
}

/**
 * One card. The title recedes and the figure is the card.
 *
 * `value` is the answer -- a civ name, a map, a difficulty pill -- and it is
 * allowed to be missing: a card with nothing over the floor says what it would
 * have needed rather than showing a zero, because "not enough games" and "you
 * lose them all" are opposite facts and a dash is the only honest way to tell
 * them apart.
 */
function Card({ title, hint, value, children }: {
  title: string;
  hint: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={styles.card} title={hint}>
      <div className={styles.title}>{title}</div>
      <div className={styles.value}>{value}</div>
      {children}
    </div>
  );
}

/**
 * The card nothing cleared the floor for.
 *
 * It says what it would have taken rather than showing a zero, because
 * "nothing has enough games behind it" and "you lose them all" are opposite
 * facts and a card that renders both as 0% is lying about one of them.
 */
function Short({ title, hint, needs }: { title: string; hint: string; needs: string }) {
  return (
    <Card title={title} hint={hint} value={<span className={styles.nil}>–</span>}>
      <div className={styles.sample}>{`Needs ${needs}`}</div>
    </Card>
  );
}

export function StatCards({ entries }: { entries: SavedEntry[] }) {
  const { bestCiv, worstCiv, topRung, bestMap } = highlights(entries);
  /* Said on every tooltip rather than once under the block: the floor is the
     reason a card can be blank while the page above it is full of games, and
     that is the question asked of whichever card is blank. */
  const floor = `Every kept recording, counting only what has ${MIN_GAMES} or more games behind it.`;

  return (
    <div className={styles.grid}>
      {bestCiv ? (
        <Card
          title="Best civ"
          hint={`The civ you have the best record with. ${floor}`}
          value={<span className={styles.name} title={bestCiv.key}>{bestCiv.key}</span>}
        >
          <Figure of={bestCiv} />
        </Card>
      ) : (
        <Short
          title="Best civ"
          hint={`The civ you have the best record with. ${floor}`}
          needs={`${MIN_GAMES} games on one civ`}
        />
      )}

      {/* The same arithmetic read from the other end. The first card says what
          to pick and this one says what to practise, which is the half of the
          question a "best" on its own never answers. */}
      {worstCiv ? (
        <Card
          title="Civ to work on"
          hint={`The civ you have the worst record with. ${floor}`}
          value={<span className={styles.name} title={worstCiv.key}>{worstCiv.key}</span>}
        >
          <Figure of={worstCiv} />
        </Card>
      ) : (
        <Short
          title="Civ to work on"
          hint={`The civ you have the worst record with. ${floor}`}
          /* Two ways to get here -- one civ over the floor, or every civ over
             it on the same record -- and this covers both without claiming
             which. See `worstCiv` in lib/summary.ts. */
          needs={`two civs with ${MIN_GAMES} games and different records`}
        />
      )}

      {/* Not "best difficulty": easiest would win that every time. The rung is
          a scale, and what a player wants off a scale is how far up it they
          have got and what is next. */}
      {topRung ? (
        <Card
          title="Rung you hold"
          hint={`The hardest difficulty you have a winning record on. ${floor}${
            topRung.next ? ` Next up: ${topRung.next}.` : " There is nothing above it."
          }`}
          value={
            <span
              className={`${ui.diffPill} ${styles.pill}`}
              style={difficultyStyle(topRung.key)}
            >
              {topRung.key}
            </span>
          }
        >
          <Figure of={topRung} />
        </Card>
      ) : (
        <Short
          title="Rung you hold"
          hint={`The hardest difficulty you have a winning record on. ${floor}`}
          needs={`${MIN_GAMES} games on one difficulty, won more than lost`}
        />
      )}

      {bestMap ? (
        <Card
          title="Best map"
          hint={`The map you have the best record on. ${floor}`}
          value={<span className={styles.name} title={bestMap.key}>{bestMap.key}</span>}
        >
          <Figure of={bestMap} />
        </Card>
      ) : (
        <Short
          title="Best map"
          hint={`The map you have the best record on. ${floor}`}
          needs={`${MIN_GAMES} games on one map`}
        />
      )}
    </div>
  );
}
