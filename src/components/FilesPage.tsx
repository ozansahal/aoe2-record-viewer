import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { LibraryEntry } from "../electron";
import type { Library } from "../hooks/useLibrary";
import type { Prescan } from "../hooks/usePrescan";
import type { Saved } from "../hooks/useSaved";
import { ago, WHEN } from "../lib/format";
import { MAX_SAVED, MAX_SCANNED, type SavedEntry } from "../lib/savedStore";
import { usePlatform } from "../platform/context";
import ui from "../styles/ui.module.css";
import { DropZone } from "./DropZone";
import styles from "./FilesPage.module.css";
import { GameLine, Gutter, roster } from "./GameLine";

/*
 * Everything there is to open, in one list.
 *
 * Two places recordings come from -- the folder the game writes to, and the
 * parses kept in this browser -- and they used to be two panels you toggled
 * between. They answer the same question, so they are one page now, sorted
 * together by when you last touched them.
 *
 * It is also the permanent first tab, and the only place a file dialog is
 * opened from -- the toolbar that used to carry that button is gone, so
 * everything that opens a recording is on the page the tab shows.
 *
 * A recording is often in both: you opened it from the folder, so its parse
 * was kept. That is one row, not two. Opening it goes through the folder
 * either way -- `openSource` fingerprints the bytes and finds the saved parse
 * itself, so the file on disk stays the thing being opened and it is still
 * instant.
 */

/** Rows past this are behind the filter box -- a full folder is thousands. */
const MAX_ROWS = 300;


/*
 * How far down the list was left, kept outside the component because the
 * component does not survive the trip: opening a match unmounts this whole
 * page, and coming back to a list scrolled to the top loses the evening you
 * were working through. Module scope rather than a ref -- a ref dies with the
 * instance -- and there is only ever one of these pages on screen.
 */
let listScroll = 0;

const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long" });

/** Midnight local time, as a number, so two timestamps can be compared by day. */
function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY_MS = 86_400_000;

/*
 * What a row sits under. The list is already newest first, so the buckets come
 * out in order and grouping is one pass -- a heading whenever the label
 * changes.
 *
 * Near dates are named the way you would say them out loud (today, yesterday,
 * the weekday for the rest of the last week), because that is how you look for
 * a game you played this morning. Past that the date itself is what you have,
 * so it falls back to the month.
 */
function bucket(when: number, today: number): string {
  const day = startOfDay(when);
  const ago = Math.round((today - day) / DAY_MS);
  if (ago <= 0) return "Today";
  if (ago === 1) return "Yesterday";
  if (ago < 7) return WEEKDAY.format(new Date(day));
  return MONTH.format(new Date(day));
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/*
 * Rescan, as the glyph every application uses for it rather than the word.
 * Drawn for the same reason the crown is: the arrow codepoints render as
 * emoji on Windows, full-colour and off-baseline beside 12px text.
 *
 * It turns while the folder is being read and while the background scan is
 * working, so the one control says what is going on -- the button being busy
 * and the list filling in are the same thing.
 */
function Reload({ turning }: { turning: boolean }) {
  return (
    <svg
      className={turning ? `${styles.reload} ${styles.turning}` : styles.reload}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {/* An arc rather than a ring: the gap is what makes it read as a cycle,
          and the arrowhead has to sit at the end of the stroke, not beside it. */}
      <path
        d="M13.4 6.2A5.6 5.6 0 1 0 13.7 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path d="M13.9 2.4 14.3 6.9 9.9 6.1z" fill="currentColor" />
    </svg>
  );
}

/*
 * The rest of the head's glyphs. Same reason as the two above -- the codepoints
 * that would do this render as emoji on Windows -- and the same box, so they
 * sit on one line with the rescan arrow at the same weight.
 *
 * Outlines rather than the filled shapes the crown and the arrowhead use: at
 * 14px a filled folder and a filled page are two dark blobs, and the pair have
 * to be told apart at a glance rather than identified one at a time.
 */
function Glyph({ d }: { d: string }) {
  return (
    <svg className={styles.glyph} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={d} fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

/** A folder, for the button that picks which one the list is of. */
const FOLDER = "M2.4 12.3V4.1a.9.9 0 0 1 .9-.9h2.9l1.5 1.8h5a.9.9 0 0 1 .9.9v6.4"
  + "a.9.9 0 0 1-.9.9H3.3a.9.9 0 0 1-.9-.9z";

/*
 * A page with a folded corner, for the button that opens one. Deliberately not
 * a second folder: the two sit beside each other, and they are the difference
 * between choosing where the list comes from and opening a file that is not in
 * it.
 */
const DOC = "M9.1 2.3H4.7a.9.9 0 0 0-.9.9v9.6a.9.9 0 0 0 .9.9h6.6a.9.9 0 0 0 .9-.9V5.3zM9.1 2.3v3h3.1";

/*
 * A bin, for "Clear saved". The recordings are not what it throws away -- the
 * kept parses are -- which is what the label and the tooltip are for; no glyph
 * at this size draws that distinction, and this is the one every application
 * uses for emptying a cache.
 */
const BIN = "M2.9 4.4h10.2M6.4 4.4V3.2a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8v1.2"
  + "M4.4 4.4l.5 8a.9.9 0 0 0 .9.9h4.4a.9.9 0 0 0 .9-.9l.5-8";

/** The three dots, drawn for the same reason the two above are. */
function Dots() {
  return (
    <svg className={styles.dots} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  );
}

/** One line of the row menu. `run` is only ever called for an enabled one. */
interface Action {
  label: string;
  /** The long form, on hover. The label is a few words; this is the sentence. */
  hint?: string;
  /** Draws it red, and it is the only kind that asks first. */
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

/*
 * Everything you can do to a row except open it.
 *
 * These were chips along the right of the row -- Show, Re-parse, Forget --
 * which meant the number of buttons on a row depended on what the row was,
 * and put the destructive one a few pixels from the one that opens it. One
 * button in the same place on every row instead, and deleting is behind it.
 *
 * Fixed rather than absolute: the list scrolls, and `overflow-y: auto` on it
 * clips anything positioned inside a row. So the menu is placed from the
 * button's rect at the moment it opens, and any scroll closes it -- a menu
 * that stayed put while its row slid away would be pointing at nothing.
 */
function RowMenu({ label, actions }: { label: string; actions: Action[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  /* Before paint, so the flip never shows: the height is not known until it
     is in the tree, and it is written back to the element rather than to
     state to save the second render. */
  useLayoutEffect(() => {
    const el = menu.current;
    const box = button.current?.getBoundingClientRect();
    if (!el || !box) return;
    const below = box.bottom + 4;
    el.style.top = below + el.offsetHeight <= window.innerHeight - 8
      ? `${below}px`
      : `${Math.max(8, box.top - 4 - el.offsetHeight)}px`;
    el.style.right = `${Math.max(8, window.innerWidth - box.right)}px`;
    /* The keyboard lands on the first item, which is also what tells a pointer
       user the menu took the focus away from the row behind it. Without
       `preventScroll` this scrolls: the menu is fixed, but it is still a
       descendant of the list, so the browser scrolls the list to "reveal" it
       -- which slides the row out from under a menu that is anchored to it. */
    el.querySelector("button")?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const shut = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      shut();
      button.current?.focus();
    };
    /* Pointer down rather than click: pressing anywhere else is already the
       decision to leave, and waiting for the click lets the row under the
       pointer take it. Capturing, so a handler below cannot eat it. */
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) shut();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", shut, true);
    window.addEventListener("resize", shut);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", shut, true);
      window.removeEventListener("resize", shut);
    };
  }, [open]);

  /* Up and down move between the items rather than out of the menu, which is
     what every other menu on the machine does. */
  const arrows = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll("button:not(:disabled)") ?? []);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    (items[(at + step + items.length) % items.length] as HTMLButtonElement).focus();
  };

  return (
    <>
      <button
        ref={button}
        className={styles.more}
        aria-label={`More for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Dots />
      </button>
      {open ? (
        <div ref={menu} className={styles.menu} role="menu" onKeyDown={arrows}>
          {actions.map((action) => (
            <button
              key={action.label}
              role="menuitem"
              className={action.danger ? `${styles.menuItem} ${styles.danger}` : styles.menuItem}
              disabled={action.disabled}
              title={action.hint}
              onClick={() => { setOpen(false); action.run(); }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

interface Row {
  key: string;
  name: string;
  /** The file's last-edit time, or -- with no file left -- the best date the
   *  kept parse carries. What it sorts on, and what it is dated by. */
  when: number;
  /** The folder entry, when the file is still on disk. */
  entry: LibraryEntry | null;
  /** The kept parse, when there is one. Either way it opens without waiting. */
  saved: SavedEntry | null;
}

/** Folder first, then whatever is saved and no longer in it. Newest first. */
function merge(entries: LibraryEntry[], saved: SavedEntry[]): Row[] {
  /* By name, because the two sides have no id in common: the folder knows a
     path and the store a fingerprint of the bytes. Two different recordings
     sharing a name is the cost, and it costs one row. */
  const spare = new Map(saved.map((s) => [s.name, s]));
  const rows: Row[] = entries.map((entry) => {
    const hit = spare.get(entry.name) ?? null;
    if (hit) spare.delete(entry.name);
    return { key: `f:${entry.id}`, name: entry.name, when: entry.modified, entry, saved: hit };
  });
  for (const s of spare.values()) {
    /* The file's own last-edit time if the row ever saw a folder listing,
       which is when the game was; `openedAt` is only when this app last looked
       at it, and it moves. */
    rows.push({ key: `s:${s.id}`, name: s.name, when: s.modified ?? s.openedAt, entry: null, saved: s });
  }
  return rows.sort((a, b) => b.when - a.when);
}

/*
 * A campaign mission, an Art of War challenge, anything else made in the
 * editor. A folder collects a dozen of them for one mission -- every restart
 * writes another -- and they crowd out the matches either side of them, so the
 * list keeps them out of the way and says so, with the way back.
 *
 * The recording states this itself: the map is a scenario file rather than a
 * random map. Only a parsed row knows it; an unread one has nothing but its
 * filename, which says nothing about what was played.
 */
const isScenario = (row: Row) => !!row.saved?.scenario;

/** Every term has to appear somewhere, so "mp 08.14" narrows to one evening. */
function matches(row: Row, terms: string[]): boolean {
  if (!terms.length) return true;
  const hay = `${row.entry?.folder ?? ""}/${row.name} ${row.saved?.map ?? ""} ${row.saved?.difficulty ?? ""}`.toLowerCase();
  return terms.every((term) => hay.includes(term));
}

interface Props {
  library: Library;
  saved: Saved;
  /** The folder being read through in the background. Idle in a browser. */
  prescan: Prescan;
  /** A parse is running; opening another one now would race it. */
  busy: boolean;
  /** Recordings already in a tab, by name, so a row can say so. */
  openNames: Set<string>;
  /** The file dialog. It used to be a toolbar button; this page is the toolbar. */
  onPick: () => void;
  onOpenLibrary: (entry: LibraryEntry) => void;
  onOpenSaved: (entry: SavedEntry) => void;
  /** Only ever called for a row that is both a file and a kept parse. */
  onReparse: (entry: LibraryEntry, savedId: string) => void;
  onFiles: (files: File[]) => void;
  status: string;
  error: boolean;
}

export function FilesPage({
  library, saved, prescan, busy, openNames,
  onPick, onOpenLibrary, onOpenSaved, onReparse, onFiles, status, error,
}: Props) {
  const [query, setQuery] = useState("");
  /* Off by default, and per session: hiding them is the point, but a list that
     cannot be talked into showing what it is holding back is a list you have
     to leave to check something. */
  const [scenariosShown, setScenariosShown] = useState(false);
  /* Whatever the last row action had to say -- which in practice is a delete
     that the filesystem refused. Cleared by the next one that works. */
  const [notice, setNotice] = useState<string | null>(null);
  const { state, scanning } = library;
  /* Only for naming the place a deleted file goes. Windows calls it something
     else, and a dialog that uses the wrong word for it is a dialog you read
     twice before answering. */
  const bin = usePlatform().windowControls?.platform === "win32" ? "Recycle Bin" : "Trash";

  /* A ref callback and not an effect: the list is not in the tree until there
     are rows to put in it, so the moment to restore the scroll is the moment
     the element appears, which may be a scan later than mount. */
  const keepPlace = useCallback((el: HTMLUListElement | null) => {
    if (el) el.scrollTop = listScroll;
  }, []);

  /*
   * Delete, which is the only thing on this page that touches the folder.
   *
   * It asks first, and it takes the kept parse with it: a row whose file is
   * gone but whose parse is not still lists, still opens, and still looks
   * like the recording you just deleted.
   */
  const remove = useCallback((row: Row) => {
    const entry = row.entry;
    if (!entry) return;
    const ask = `Delete ${row.name}?

`
      + `The file is moved to the ${bin}, so it can be put back.`
      + (row.saved ? " Its kept parse is forgotten." : "");
    if (!confirm(ask)) return;
    void (async () => {
      try {
        await library.trash(entry.id);
        if (row.saved) await saved.remove(row.saved.id);
        setNotice(null);
      } catch (err) {
        setNotice(`Could not delete ${row.name}: ${(err as Error).message}`);
      }
    })();
  }, [bin, library, saved]);

  const all = useMemo(
    () => merge(state?.entries ?? [], saved.entries),
    [state, saved.entries],
  );
  /* What the background scan tried and could not read is left out: the row
     would say nothing but a filename, and clicking it would fail the same way.
     A row with a parse behind it stays regardless -- whatever failed, it was
     not this recording. */
  const rows = useMemo(
    () => (prescan.failed.size
      ? all.filter((row) => row.saved || !prescan.failed.has(row.name))
      : all),
    [all, prescan.failed],
  );
  const unreadable = all.length - rows.length;
  const scenarios = useMemo(() => rows.filter(isScenario).length, [rows]);
  const listed = useMemo(
    () => (scenariosShown || !scenarios ? rows : rows.filter((row) => !isScenario(row))),
    [rows, scenarios, scenariosShown],
  );
  const terms = useMemo(
    () => query.toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );
  const found = useMemo(() => listed.filter((r) => matches(r, terms)), [listed, terms]);
  const shown = useMemo(() => found.slice(0, MAX_ROWS), [found]);
  /* The heading each row needs above it, or null when the row before it is
     already under the same one. Recomputed with the rows, and not per row, so
     "today" is read once for the whole list rather than drifting across it. */
  const heads = useMemo(() => {
    const today = startOfDay(Date.now());
    const labels = shown.map((row) => bucket(row.when, today));
    /* How many fall under each heading, counted over the whole list before it
       is cut into runs -- the list is newest first, so a label's rows are
       always adjacent and the two come to the same thing either way. */
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    let last = "";
    return labels.map((label) => {
      if (label === last) return null;
      last = label;
      return { label, count: counts.get(label)! };
    });
  }, [shown]);
  /* Nothing to open from anywhere, so the drop zone is the page rather than a
     footnote under a list -- and it is the drop zone that reports the parse.
     Not while the scan is going: a folder whose newest files cannot be read
     starts out empty, and the zone would appear only to be replaced by a list
     a moment later. */
  const bare = !listed.length && !scanning && !prescan.active;

  return (
    <section className={styles.library} aria-label="Recordings">
      <div className={styles.head}>
        {state?.folder ? (
          <span className={styles.path} title={state.folder}>{state.folder}</span>
        ) : null}
        {state?.detected ? <span className={styles.chip}>detected</span> : null}
        <span className={ui.spacer} />
        {rows.length ? (
          <input
            className={styles.search}
            type="search"
            placeholder="Filter..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : null}
        {library.available ? (
          <>
            <button
              className={`${ui.ghost} ${ui.icon}`}
              /* Both halves of "read the folder again": the listing, and the
                 scan that fills the rows in. The scan stays stopped once it
                 has been stopped, and this is what takes that off. */
              onClick={() => { prescan.resume(); void library.refresh(); }}
              disabled={scanning}
              aria-label="Rescan the recordings folder"
              title="Read the folder again"
            >
              <Reload turning={scanning || prescan.active} />
            </button>
            <button className={ui.ghost} onClick={() => void library.choose()} disabled={scanning}>
              <Glyph d={FOLDER} />
              {state?.folder ? "Change folder..." : "Choose folder..."}
            </button>
          </>
        ) : null}
        {saved.entries.length ? (
          <button
            className={ui.ghost}
            onClick={() => {
              const ask = `Forget all ${saved.entries.length} saved parses?

`
                + "The recordings themselves stay where they are. Anything still in "
                + "the folder is parsed again the next time you open it.";
              if (confirm(ask)) void saved.clear();
            }}
            title="Reset every kept parse, so the next open re-reads the file with the parser as it is now. The recordings stay where they are."
          >
            <Glyph d={BIN} />
            Clear saved
          </button>
        ) : null}
        {/* The one button that is not about the list below it: it is how a
            recording that is in neither the folder nor the store gets in.
            Styled as the rest of the row rather than as the primary: the page
            it sits on is a list of recordings you can already open, so the
            filled button was drawing the eye to the one way in that is not the
            usual one. */}
        <button className={ui.ghost} onClick={onPick} disabled={busy}>
          <Glyph d={DOC} />
          {busy ? "Parsing..." : "Load recordings"}
        </button>
      </div>

      {/* One framed box for everything under the head: the scan bar, the
          list, and the footers, so the border and the corners go round the
          whole of it rather than round the scrolling part alone. Not when the
          drop zone is the whole page, though: it draws its own dashed border,
          and a solid one a pixel outside it read as a mistake. */}
      <div className={bare ? styles.bare : styles.frame}>

      {/* What the background scan is doing, and the way out of it. It is CPU
          nobody asked for, so it says so and can be stopped. */}
      {prescan.total ? (
        <div className={styles.scan}>
          <span>
            Reading the folder — {prescan.done} of {prescan.total}. Rows fill in as it goes.
          </span>
          <button className={styles.link} onClick={prescan.stop}>Stop</button>
        </div>
      ) : null}

      {notice ? <div className={`${styles.empty} ${styles.err}`}>{notice}</div> : null}
      {saved.error ? <div className={`${styles.empty} ${styles.err}`}>{saved.error}</div> : null}
      {state?.error ? <div className={`${styles.empty} ${styles.err}`}>{state.error}</div> : null}

      {/* How the last attempt to open something went. It belongs here, with the
          button that starts one: a file can be dropped on a match, and the
          failure used to be drawn across that match instead -- naming a
          recording that had nothing to do with the one on screen. The drop
          zone says this itself when it is up, so this is for when the list
          has taken its place. */}
      {status && !bare ? (
        <div className={error ? `${styles.empty} ${styles.err}` : styles.empty}>{status}</div>
      ) : null}

      {library.available && state && !state.folder ? (
        <div className={styles.empty}>
          <div>No recordings folder yet.</div>
          <div className={ui.hint}>
            Age of Empires II: DE keeps replays in
            {" "}<code>Games\Age of Empires 2 DE\&lt;your id&gt;\savegame</code>.
            Point at that, or at any folder you keep recordings in.
          </div>
        </div>
      ) : null}

      {/* Nothing anywhere: the drop zone is the whole page, and says so. */}
      {bare ? (
        <DropZone busy={busy} status={status} error={error} onFiles={onFiles} />
      ) : null}

      {shown.length ? (
        <ul
          className={styles.list}
          ref={keepPlace}
          onScroll={(e) => { listScroll = e.currentTarget.scrollTop; }}
        >
          {shown.map((row, i) => {
            const { entry, saved: kept } = row;
            const open = openNames.has(row.name);
            return (
              <Fragment key={row.key}>
                {heads[i] ? (
                  <li className={styles.group}>
                    {heads[i]!.label}
                    {/* How many games that day was. The heading already says
                        when; this says how much, which is the other half of
                        what you are scrolling past it to find out. */}
                    <span className={styles.groupCount}>{heads[i]!.count}</span>
                  </li>
                ) : null}
                <li className={styles.item}>
                  <button
                    className={open ? `${styles.row} ${styles.active}` : styles.row}
                    disabled={busy}
                    /* Where it came from, and -- once there is a parse -- who
                       played, because the line above cuts a long roster off at
                       the width of the list. */
                    title={[
                      entry ? entry.id : `Saved ${WHEN.format(new Date(kept!.savedAt))}`,
                      kept ? roster(kept) : "",
                    ].filter(Boolean).join("\n")}
                    onClick={() => (entry ? onOpenLibrary(entry) : onOpenSaved(kept!))}
                  >
                    {/* What the row is, ahead of both its lines and in a
                        gutter of its own. See `Gutter` in GameLine.tsx. */}
                    <Gutter entry={kept} />
                    <span className={styles.lines}>
                    {/* What the game was, which is what you are looking for.
                        Only a parsed recording knows any of it; until then the
                        file name is the whole of what there is to go on, so it
                        takes this line instead. */}
                    {kept ? (
                      <GameLine entry={kept} accent={open} />
                    ) : (
                      /* Nothing parsed, so nothing to put in the columns: the
                         file name gets the whole line instead of the map's
                         share of it. */
                      <span className={styles.unparsed}>{row.name}</span>
                    )}
                    <span className={styles.meta}>
                      {/* The file name, once the line above says what the game
                          was: still here to be read, and to be filtered on, but
                          no longer the thing the eye lands on first. */}
                      {kept ? <span className={styles.name}>{row.name}</span> : null}
                      {/* Where it came from. A file still in the folder says
                          which folder and stops there -- it used to carry a
                          "saved" badge beside that, which told you nothing: a
                          folder row that has been opened is saved, always, and
                          the badge was on most of the list.

                          What is worth marking is the other way in. A row with
                          no file behind it is a kept parse alone, and "loaded"
                          says that one came in through the button rather than
                          being a folder recording that has since moved or been
                          deleted. Only what was imported after this existed
                          knows which it was; the rest keep the old word. */}
                      {entry ? (
                        <span className={styles.src}>{entry.folder || "folder"}</span>
                      ) : kept!.loaded ? (
                        <span
                          className={`${styles.src} ${styles.loaded}`}
                          title="Opened with Load recordings, not from the recordings folder"
                        >
                          loaded
                        </span>
                      ) : (
                        <span className={`${styles.src} ${styles.saved}`}>saved</span>
                      )}
                      {/* How long ago rather than when: a list is read to find
                          the game you played this morning, and "Aug 24, 14:02"
                          is a lookup against today's date every time. The stamp
                          itself is on the tooltip, for when the exact minute is
                          what is being looked for. */}
                      <span title={WHEN.format(new Date(row.when))}>{ago(row.when)}</span>
                      {entry ? <span>{bytes(entry.size)}</span> : null}
                    </span>
                    </span>
                  </button>
                  {/* What each row can do depends on what it has behind it:
                      re-parsing needs both a file and a parse to replace, and
                      forgetting one is only worth offering where the file is
                      gone -- with the file still there, re-parse is the same
                      thing and leaves you something to look at. */}
                  <RowMenu label={row.name} actions={[
                    ...(entry ? [{
                      label: "Show in folder",
                      hint: "Show in file manager",
                      run: () => library.reveal(entry.id),
                    }] : []),
                    ...(entry && kept ? [{
                      label: "Re-parse",
                      hint: "Forget the kept parse and read the file again, with the parser as it is now",
                      disabled: busy,
                      run: () => onReparse(entry, kept.id),
                    }] : []),
                    ...(kept && !entry ? [{
                      label: "Forget parse",
                      hint: `Forget the saved parse of ${row.name}`,
                      danger: true,
                      run: () => void saved.remove(kept.id),
                    }] : []),
                    ...(entry ? [{
                      label: "Delete file...",
                      hint: `Move ${row.name} to the ${bin}`,
                      danger: true,
                      disabled: busy,
                      run: () => remove(row),
                    }] : []),
                  ]} />
                </li>
              </Fragment>
            );
          })}
        </ul>
      ) : null}

      {rows.length && !found.length ? (
        <div className={styles.empty}>No recording matches “{query}”.</div>
      ) : null}

      {found.length > shown.length ? (
        <div className={styles.foot}>
          Showing the {MAX_ROWS} most recent of {found.length}. Filter to reach the rest.
        </div>
      ) : null}
      {/* Said, like the unreadable count below: they are in the folder, and a
          list that drops rows without a word is one you cannot trust. */}
      {scenarios ? (
        <div className={styles.foot}>
          {scenariosShown
            ? `Listing ${scenarios === 1 ? "the one campaign or scenario recording" : `all ${scenarios} campaign and scenario recordings`}.`
            : scenarios === 1
              ? "One campaign or scenario recording is not listed."
              : `${scenarios} campaign and scenario recordings are not listed.`}
          {" "}
          <button className={styles.link} onClick={() => setScenariosShown((was) => !was)}>
            {scenariosShown ? "Hide them" : "Show them"}
          </button>
        </div>
      ) : null}
      {state?.truncated ? (
        <div className={styles.foot}>
          This folder holds more files than the scan reads; pick a folder closer to
          the recordings.
        </div>
      ) : null}
      {/* Said rather than done silently: they are still in the folder, and a
          listing that quietly drops files is a listing you cannot trust. */}
      {unreadable ? (
        <div className={styles.foot}>
          {unreadable === 1
            ? "One recording in this folder could not be read, and is not listed."
            : `${unreadable} recordings in this folder could not be read, and are not listed.`}
          {" "}Rescan to try them again.
        </div>
      ) : null}

      {saved.entries.length ? (
        <div className={styles.foot}>
          {saved.usage.usage !== null ? (
            <>
              Saved parses use {bytes(saved.usage.usage)}
              {saved.usage.quota ? ` of about ${bytes(saved.usage.quota)} allowed` : ""}.{" "}
            </>
          ) : null}
          The {MAX_SAVED} most recently opened are kept, plus {MAX_SCANNED} the
          folder scan read on its own; the oldest of each drop off, and a scanned
          one never pushes out an opened one.
          {!saved.usage.persisted ? (
            <>
              {" "}
              <button className={styles.link} onClick={() => void saved.persist()}>
                Keep even when storage runs low
              </button>
            </>
          ) : (
            " Marked as persistent, so the browser won't reclaim it."
          )}
        </div>
      ) : null}
      </div>
    </section>
  );
}
