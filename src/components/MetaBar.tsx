import type { CSSProperties } from "react";
import { difficultyStyle, fmt } from "../lib/format";
import type { Payload } from "../types";
import styles from "./MetaBar.module.css";
import ui from "../styles/ui.module.css";

export function MetaBar({ payload }: { payload: Payload }) {
  /* Difficulty is the one field here that is on a scale, so it is the one that
     gets a colour -- the same ramp the list reads by, so a row you picked out
     of the list by its colour is still that colour once it is open. */
  const fields: [string, string | number | undefined, CSSProperties?][] = [
    ["Map", payload.map],
    ["Duration", fmt(payload.duration)],
    ["Speed", payload.speed],
    ["Difficulty", payload.difficulty, difficultyStyle(payload.difficulty) || {}],
    ["Events", payload.events.length],
  ];
  return (
    <div className={styles.meta}>
      {fields
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v, pill]) => (
          <div key={k}>
            <span>{k}</span>
            <span className={pill ? ui.diffPill : undefined} style={pill}>{v}</span>
          </div>
        ))}
    </div>
  );
}
