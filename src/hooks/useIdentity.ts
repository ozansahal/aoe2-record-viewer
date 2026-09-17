import { useCallback, useEffect, useMemo, useState } from "react";

import type { LibraryFolder } from "../electron";
import type { SavedEntry } from "../lib/savedStore";

/**
 * Who you are, so a list of recordings can say which of them are yours.
 *
 * A recording states which player's client wrote it -- `pov` on the saved row
 * -- and for a file the game put in its own savegame folder that player is
 * you. A file somebody sent you was written by *their* client, so its `pov`
 * is them: the crown on that row is theirs, and the list has no way to say so
 * unless it knows which player you are.
 *
 * What identifies you is the DE profile id, not the name: a name is whatever
 * the lobby showed that day, and it can be changed between two games. The
 * name is kept beside it only to have something to print.
 *
 * ## How it is learned
 *
 * From the folder the game itself writes to. Every recording found there was
 * written by your client, so the profile that is `pov` on most of them is
 * yours -- "most" rather than "all" because a file you copied in there is
 * still somebody else's. It is worked out again whenever the saved rows
 * change, so the answer follows the folder, until you choose a name yourself:
 * a manual pick is kept as it is until "Detect automatically" takes it off.
 *
 * In a browser there is no folder, so nothing is learned and the pick is the
 * only way in. localStorage rather than the settings file for that reason:
 * this has to work where there is no main process to keep it.
 */

const KEY = "aoe2:identity";

export interface Identity {
  profileId: number;
  /** Whatever the most recent recording called this player. */
  name: string;
  /** Chosen by hand, so the folder is not consulted. */
  manual: boolean;
}

/** One player seen as a recording's owner, and how often. */
export interface Candidate {
  profileId: number;
  name: string;
  games: number;
}

function read(): Identity | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { profileId, name, manual } = parsed as Record<string, unknown>;
    if (typeof profileId !== "number" || typeof name !== "string") return null;
    return { profileId, name, manual: manual === true };
  } catch {
    return null;
  }
}

function write(identity: Identity | null) {
  try {
    if (identity) localStorage.setItem(KEY, JSON.stringify(identity));
    else localStorage.removeItem(KEY);
  } catch {
    // Nothing kept between launches, then. It is learned again on the next one.
  }
}

/** The owner of a saved row, when the row knows one with a profile. */
function ownerOf(entry: SavedEntry): { profileId: number; name: string } | null {
  if (entry.pov === undefined) return null;
  const player = entry.players[entry.pov];
  if (!player || player.profileId === undefined) return null;
  return { profileId: player.profileId, name: player.name };
}

/**
 * Every owner seen across the rows, most games first. The name is the one from
 * the newest row -- `entries` is newest-opened first, and the first time a
 * profile is met is the freshest name it has.
 */
function tally(entries: SavedEntry[]): Candidate[] {
  const seen = new Map<number, Candidate>();
  for (const entry of entries) {
    const owner = ownerOf(entry);
    if (!owner) continue;
    const hit = seen.get(owner.profileId);
    if (hit) hit.games += 1;
    else seen.set(owner.profileId, { ...owner, games: 1 });
  }
  return [...seen.values()].sort((a, b) => b.games - a.games);
}

export interface IdentityState {
  identity: Identity | null;
  /** Everyone seen as a recording's owner, for the picker. */
  candidates: Candidate[];
  /** Choose one by hand. */
  choose: (candidate: Candidate) => void;
  /** Go back to reading it off the game's folder. */
  detect: () => void;
  /**
   * Whether this row is one of your games: true, false, or null when the row
   * cannot say -- no parse yet, no owner named, or nothing known about you.
   */
  isMine: (entry: SavedEntry | null) => boolean | null;
}

export function useIdentity(entries: SavedEntry[], folders: LibraryFolder[] | undefined): IdentityState {
  const [identity, setIdentity] = useState<Identity | null>(read);

  const candidates = useMemo(() => tally(entries), [entries]);

  /* The detected folder's most frequent owner, or null while there is nothing
     to go on -- an empty folder, a scan that has not reached it, a browser. */
  const learned = useMemo(() => {
    const own = new Set(folders?.filter((f) => f.detected).map((f) => f.path) ?? []);
    if (!own.size) return null;
    const [best] = tally(entries.filter((e) => e.root !== undefined && own.has(e.root)));
    return best ?? null;
  }, [entries, folders]);

  useEffect(() => {
    if (identity?.manual) return;
    if (!learned) return; // nothing to go on is not a reason to forget
    if (identity && identity.profileId === learned.profileId && identity.name === learned.name) return;
    const next = { profileId: learned.profileId, name: learned.name, manual: false };
    setIdentity(next);
    write(next);
  }, [identity, learned]);

  const choose = useCallback((candidate: Candidate) => {
    const next = { profileId: candidate.profileId, name: candidate.name, manual: true };
    setIdentity(next);
    write(next);
  }, []);

  const detect = useCallback(() => {
    /* Straight to what the folder says, or to nothing: the effect above only
       ever fills in, so an old manual pick has to be cleared here. */
    const next = learned ? { profileId: learned.profileId, name: learned.name, manual: false } : null;
    setIdentity(next);
    write(next);
  }, [learned]);

  const isMine = useCallback((entry: SavedEntry | null) => {
    if (!identity || !entry) return null;
    const owner = ownerOf(entry);
    return owner ? owner.profileId === identity.profileId : null;
  }, [identity]);

  return useMemo(
    () => ({ identity, candidates, choose, detect, isMine }),
    [identity, candidates, choose, detect, isMine],
  );
}
