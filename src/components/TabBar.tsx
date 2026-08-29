import type { Tab } from "../useRecordingTabs";
import styles from "./TabBar.module.css";

/*
 * The open recordings, one strip above the match.
 *
 * A tab is a whole document -- its own playhead, mode, sort and window -- so
 * switching is instant and lands where you left rather than back at the middle
 * of the match.
 *
 * The strip opens with the summary, which is the one tab that never closes and
 * the page the app starts on: what the recordings already parsed add up to is
 * the question you have on arriving, and it costs nothing to answer -- no file
 * is read and nothing is parsed to draw it.
 *
 * Recordings is a tab like any other now. It is where files are opened from,
 * so it is open by default and it always sits directly after the summary --
 * being second is what makes it findable, and it is not a document you have
 * several of. But it closes, because once an evening's matches are in tabs the
 * list of everything on disk is the one thing on the strip you are not
 * looking at. "Show all" on the summary is the way back to it.
 */

/** The two tabs that are pages rather than recordings. */
export type Page = "summary" | "recordings";

interface Props {
  tabs: Tab[];
  activeId: string | null;
  /** Which page is on screen, or null while a match tab is. */
  page: Page | null;
  /** Whether the recordings tab is on the strip at all. */
  recordingsOpen: boolean;
  onPage: (page: Page) => void;
  onCloseRecordings: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

/**
 * What to call a tab.
 *
 * The game names every replay `MP Replay v101.103.48987.0 @2026.08.17 212220`,
 * so the first thirty characters are the same on all of them and the part that
 * says which match this is sits at the very end. Left whole they truncate to a
 * row of identical tabs, so the boilerplate goes and the timestamp stays. It
 * is the only line on the tab -- the map used to sit under it -- so the full
 * name on the tooltip is where the rest of it lives.
 */
function label(name: string): string {
  return name
    .replace(/\.(aoe2record|aoe2rec|mgz|mgx|json)$/i, "")
    .replace(/^(MP|SP) Replay v[\d.]+ @/i, "")
    .trim() || name;
}

/** 10x10, a pixel thick: the metrics the title bar's glyphs are drawn at. */
function PageGlyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 10 10" width="11" height="11" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1"
      strokeLinejoin="round" strokeLinecap="round">
      <path d={d} />
    </svg>
  );
}

/*
 * Three bars of different heights, for the summary. Not a trophy or a crown:
 * the crown already means "won this match" everywhere else in the app, and a
 * second meaning for it on the tab strip would be the one place it did not.
 */
const CHART = "M1.5 9V5.5M5 9V1.5M8.5 9V3.5";

/*
 * A stack of lines, for the list of everything on disk. It used to be a house,
 * from when this was "home" -- which it no longer is: the summary is the page
 * the app opens on, and a second house on the strip beside it would be two
 * tabs claiming to be the start.
 */
const LIST = "M1.5 2.5h7M1.5 5h7M1.5 7.5h4.5";

export function TabBar({
  tabs, activeId, page, recordingsOpen, onPage, onCloseRecordings, onSelect, onClose,
}: Props) {
  return (
    <div className={styles.tabs} role="tablist" aria-label="Open recordings">
      {/* First, and permanent: it is the page the app starts on. */}
      <div
        className={page === "summary"
          ? `${styles.tab} ${styles.page} ${styles.active}`
          : `${styles.tab} ${styles.page}`}
      >
        <button
          className={styles.pick}
          role="tab"
          aria-selected={page === "summary"}
          onClick={() => onPage("summary")}
          title="What the games you have opened add up to"
        >
          <PageGlyph d={CHART} />
          <span className={styles.name}>Summary</span>
        </button>
      </div>

      {/* Second whenever it is open, and never anywhere else: a tab that moved
          about the strip would have to be looked for, and this is the one you
          go to without looking. */}
      {recordingsOpen ? (
        <div
          className={page === "recordings"
            ? `${styles.tab} ${styles.page} ${styles.active}`
            : `${styles.tab} ${styles.page}`}
        >
          <button
            className={styles.pick}
            role="tab"
            aria-selected={page === "recordings"}
            onClick={() => onPage("recordings")}
            title="Everything there is to open"
          >
            <PageGlyph d={LIST} />
            <span className={styles.name}>Recordings</span>
          </button>
          <button
            className={styles.close}
            onClick={onCloseRecordings}
            aria-label="Close Recordings"
            title="Close — Show all on the summary brings it back"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      ) : null}

      {tabs.map((tab) => (
        <div key={tab.id} className={tab.id === activeId ? `${styles.tab} ${styles.active}` : styles.tab}>
          <button
            className={styles.pick}
            role="tab"
            aria-selected={tab.id === activeId}
            onClick={() => onSelect(tab.id)}
            title={tab.name}
          >
            <span className={styles.name}>{label(tab.name)}</span>
          </button>
          <button
            className={styles.close}
            onClick={() => onClose(tab.id)}
            aria-label={`Close ${tab.name}`}
            title="Close"
          >
            {/* The glyph and its hover pill, so the button itself can be the
                full height of the tab without the pill growing with it. */}
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      ))}
    </div>
  );
}
