import { useMemo } from "react";

import { useSeek } from "../hooks/useSeek";
import { CATS, fmt, playerColor } from "../lib/format";
import { opponentsOf } from "../lib/tally";
import type { AgeUp, CategoryTally, Player, SortBy } from "../types";
import { CategoryColumn } from "./CategoryColumn";
import styles from "./PlayerCard.module.css";

interface Props {
  player: Player;
  players: Player[];
  counts: CategoryTally;
  ages: AgeUp[];
  /** player number -> techs that player holds by the range's upper bound,
      each mapped to the second its research was ordered. */
  techsHeld: Map<number, Map<string, number>>;
  t: number;
  sortBy: SortBy;
}

export function PlayerCard({ player, players, counts, ages, techsHeld, t, sortBy }: Props) {
  /* The chips are the other place a time is shown against this match, so they
     go to it too -- and they are the times most worth going to: everything the
     columns list is dated relative to when this player aged up. */
  const seek = useSeek();

  const mine = useMemo(
    () => ages.filter((a) => a.player === player.number).sort((x, y) => x.t - y.t),
    [ages, player.number],
  );
  const opponents = useMemo(() => opponentsOf(players, player), [players, player]);

  const alsoHoldingTech = (item: string) =>
    opponents.filter((o) => techsHeld.get(o.number)?.has(item));

  return (
    <div className={styles.player} style={{ ["--pc" as string]: playerColor(player) }}>
      <div className={styles.phead}>
        <b>P{player.number} {player.name}</b>
        <span className={styles.civ}>{player.civilization || ""}</span>
        {player.is_ai ? <span className={styles.ai} title={player.ai_name || "computer player"}>AI</span> : null}
        {player.handicap && player.handicap !== 100
          ? <span className={styles.ai} title="handicap">{player.handicap}%</span>
          : null}
        {/* Two facts, not one. `resigned` is what the recording states
            outright; `winner` is inferred -- from the resignation when there
            is one, and otherwise from the owner having quit, which is why a
            game with no `resigned` on anybody still crowns a side. In a team
            game the whole winning side is tagged, while only the player who
            sent the RESIGN carries the other. */}
        {player.winner ? <span className={styles.win}>Winner</span> : null}
        {player.resigned ? <span className={styles.resigned}>Resigned</span> : null}
      </div>

      {mine.length ? (
        <div className={styles.ages}>
          <span className={styles.lbl}>Ages</span>
          {mine.map((a) => {
            const cls = a.t <= t ? `${styles.ageChip} ${styles.reached}` : styles.ageChip;
            const text = `${a.age.replace(" Age", "")} ${fmt(a.t)}`;
            /* The chip carries the age as well as the time, so the label says
               both -- "8:20" alone is what a screen reader would otherwise get
               out of a control whose whole point is which age it is. */
            return seek ? (
              <button
                key={`${a.age}-${a.t}`}
                type="button"
                className={cls}
                aria-label={`Seek to ${a.age} at ${fmt(a.t)}`}
                title={`Move the playhead to ${a.age}`}
                onClick={() => seek(a.t)}
              >
                {text}
              </button>
            ) : (
              <span key={`${a.age}-${a.t}`} className={cls}>{text}</span>
            );
          })}
        </div>
      ) : null}

      <div className={styles.cats}>
        {CATS.map((c) => (
          <CategoryColumn
            key={c.key}
            label={c.label}
            varname={c.varname}
            items={counts[c.key]}
            sortBy={sortBy}
            {...(c.key === "tech" ? { alsoHeldBy: alsoHoldingTech } : {})}
          />
        ))}
      </div>
    </div>
  );
}
