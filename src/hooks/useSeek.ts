import { createContext, useContext } from "react";

/*
 * Moving the playhead, from anywhere under an open match.
 *
 * Every time this app prints against a match is a moment you can go to, and
 * the ones worth clicking are the deepest things on the page: a time in a
 * build list is a row inside a column inside a card inside a team. Threading
 * `onSeek` down to it is four components passing along a prop that three of
 * them never use.
 *
 * Only the callback is in here, never the playhead itself. `t` changes on
 * every tick while a match is playing, and a context carrying it would
 * re-render every consumer on each of those ticks -- which is every time
 * label on the page, a few hundred of them on a busy match. `t` stays on
 * props, where the components that draw it already take it.
 */
const SeekContext = createContext<((t: number) => void) | null>(null);

export const SeekProvider = SeekContext.Provider;

/**
 * The seek, or null where there is no playhead to move -- a card rendered
 * outside a match. Callers draw a plain label then, not a dead button.
 */
export function useSeek(): ((t: number) => void) | null {
  return useContext(SeekContext);
}
