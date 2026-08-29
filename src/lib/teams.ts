import type { Player } from "../types";

/**
 * The players split into teams, keeping the file's own order both between
 * teams and inside one. A player the recording gives no team to stands alone,
 * which is what an FFA and a 1v1 both come out as.
 */
export function byTeam(players: Player[]): Player[][] {
  const groups: Player[][] = [];
  const seen = new Map<number, Player[]>();
  for (const p of players) {
    const group = p.team == null ? undefined : seen.get(p.team);
    if (group) {
      group.push(p);
      continue;
    }
    const started = [p];
    groups.push(started);
    if (p.team != null) seen.set(p.team, started);
  }
  return groups;
}
