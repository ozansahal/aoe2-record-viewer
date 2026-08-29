import { useCallback, useEffect, useMemo, useState } from "react";

import iconUrl from "../assets/icon.png";
import styles from "./App.module.css";
import { FilesPage } from "./components/FilesPage";
import { MetaBar } from "./components/MetaBar";
import { Minimap } from "./components/Minimap";
import { ModeRow } from "./components/ModeRow";
import { PlayerCard } from "./components/PlayerCard";
import { Scrubber } from "./components/Scrubber";
import { Sparkline } from "./components/Sparkline";
import { SummaryPage } from "./components/SummaryPage";
import { TabBar, type Page } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { useLibrary } from "./hooks/useLibrary";
import { DEFAULT_SPEED, nextSpeed, usePlayback } from "./hooks/usePlayback";
import { usePrescan } from "./hooks/usePrescan";
import { SeekProvider } from "./hooks/useSeek";
import { useSaved } from "./hooks/useSaved";
import { tallyEvents, techsHeldBy } from "./lib/tally";
import { byTeam } from "./lib/teams";
import { DECAY_SECS, MODE_SECS, secsForMode } from "./lib/view";
import { usePlatform } from "./platform/context";
import { useRecordingTabs } from "./useRecordingTabs";

/** The window's name under Electron, the page's heading in a browser. */
const APP_TITLE = "AoE2 Record Viewer";

/* Where the browser build sends someone who wants the desktop one. GitHub
   redirects /releases/latest to whatever the newest release is, so this never
   goes stale and no build step has to bake a version number in. It is also a
   plain top-level navigation, which the page's CSP does not govern -- asking
   the API for the version instead would mean opening `connect-src` up, for a
   string, in an app whose one promise is that it does not use the network. */
const RELEASES_URL = "https://github.com/ozansahal/aoe2-record-viewer/releases/latest";

/*
 * Whether the recordings tab is on the strip, remembered between runs.
 *
 * It is the one page tab that closes, and closing it is a decision about how
 * you want the app to look rather than something you do to this window: a
 * tab that came back on every launch would be a close button that undid
 * itself. Kept beside the open tabs, which are remembered for the same reason
 * -- see `TABS_KEY` in useRecordingTabs.ts -- and defaulting to open, because
 * it is still where files are opened from.
 */
const RECORDINGS_KEY = "aoe2:recordingsTab";

function readRecordingsOpen(): boolean {
  try {
    return localStorage.getItem(RECORDINGS_KEY) !== "closed";
  } catch {
    return true; // no storage is not a reason to start without the tab
  }
}

function writeRecordingsOpen(open: boolean): void {
  try {
    localStorage.setItem(RECORDINGS_KEY, open ? "open" : "closed");
  } catch {
    // A full or blocked store is not a reason to stop working.
  }
}

export function App() {
  const platform = usePlatform();

  /* One of the two pages, or a match. Null is "a match is on screen", which is
     only true while there is one -- see `shown` below: with no tabs open there
     is nothing to go back to, and the summary is the whole app.

     The summary is what the app opens on. It answers the question you arrive
     with -- how the last few nights went, and what the last few games were --
     off parses that are already kept, so it costs nothing to draw and never
     waits for a file. */
  const [page, setPage] = useState<Page | null>("summary");
  /* The recordings tab, which unlike the summary closes. It is where files are
     opened from, so it starts open -- and the decision to close it outlives
     the window, or it would be a button that undid itself on every launch. */
  const [recordingsOpen, setRecordingsOpen] = useState(readRecordingsOpen);
  /* Only while a page is up. The summary reads the same folder scan the
     recordings page starts, so coming back to it is a fresh listing too. */
  const library = useLibrary(page !== null);
  const saved = useSaved();

  /* Everything that means "go to the list of recordings": the tab, Show all on
     the summary, and a parse that failed and has to say so somewhere. It opens
     the tab as well as selecting it, since the tab may well not be there. */
  const openRecordings = useCallback(() => {
    setRecordingsOpen(true);
    writeRecordingsOpen(true);
    setPage("recordings");
  }, []);

  const closeRecordings = useCallback(() => {
    setRecordingsOpen(false);
    writeRecordingsOpen(false);
    /* Closing the page you are looking at has to land somewhere, and the
       summary is the tab that is always there. */
    setPage((current) => (current === "recordings" ? "summary" : current));
  }, []);

  const recordings = useRecordingTabs({ saved, library });
  const { active, status, error, busy, patch } = recordings;
  /* The folder read through in the background, so a row says which map and who
     won before anyone opens it. It starts itself off the first listing, which
     is why nothing here turns it on. `busy` is what keeps it out of the way:
     the parse worker is shared, and somebody waiting comes first. */
  const prescan = usePrescan({ library, saved, busy });
  /* Everything below reads the tab that is on screen. There is no app-wide
     playhead any more: each tab keeps its own, so switching lands where you
     left it. */
  const payload = active?.payload ?? null;
  const { t = 0, mode = "decay", sortBy = "time", w = DECAY_SECS } = active ?? {};

  const setT = useCallback((next: number) => patch({ t: next }), [patch]);

  /* Opening something takes you to it; failing takes you to the page that says
     why, which is the same page the message is written on. A file can be
     dropped anywhere, a match included, so without the second half a failure
     was reported over a recording that had nothing to do with it -- or, if the
     drop came from the page, not reported at all. A cancelled dialog lands
     here too, and it was started from the page, so nothing moves.

     Always the recordings page and never the summary, whichever one the drop
     came from: the message about a parse belongs beside the button that starts
     one -- which is why this opens that tab rather than assuming it is up. */
  const show = useCallback(async (opening: Promise<boolean>) => {
    if (await opening) setPage(null);
    else openRecordings();
  }, [openRecordings]);

  /* Playing walks the playhead forward on a timer, seeking the tab exactly as
     a drag would -- so the cards, the map and the sparklines follow without
     knowing playback exists. The speed is the window's, not the tab's: it is
     how fast you happen to be watching, not something about the match. */
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const { playing, toggle: playPause, pause } = usePlayback({
    t,
    duration: payload?.duration ?? 0,
    speed,
    onSeek: setT,
  });

  /* Closing the last tab leaves nothing to show but a page, whether or not one
     was asked for, so this and not `page` is what is on screen -- and what the
     tab strip reads to know which of the two is selected. The summary is what
     it falls back to: it is the tab that cannot be closed. */
  const shown: Page | null = page ?? (payload ? null : "summary");

  /* Playback belongs to whatever is on screen. Switching tabs, closing the
     last one or going back to the files page stops it, rather than leaving a
     playhead running through a match nobody is looking at. */
  useEffect(() => {
    pause();
  }, [active?.id, shown, pause]);

  /* A file dropped anywhere would otherwise navigate the window to it, which in
     Electron replaces the app. Since the handler has to exist, it may as well
     open the file -- into its own tab, leaving whatever you were looking at
     where it was. The drop zone stops its own drops from reaching here, so a
     file dropped on it is not opened twice. */
  useEffect(() => {
    const onDragOver = (event: DragEvent) => event.preventDefault();
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) void show(recordings.openFiles(files));
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [recordings, show]);

  const nudge = useCallback((seconds: number) => {
    if (!active) return;
    const bounded = Math.min(active.payload.duration, Math.max(0, active.t + seconds));
    patch({ t: bounded });
  }, [active, patch]);

  /* Arrow keys nudge the playhead; shift jumps a minute. Space plays and
     pauses -- but only over a match, since on the files page it is the key
     that pages the list. */
  useEffect(() => {
    if (!payload) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLInputElement && target.type === "number") return;
      if (event.key === " " && shown === null) {
        /* A focused button answers to space itself, so letting this through
           as well would play and pause on the one press. */
        if (target instanceof HTMLButtonElement) return;
        playPause();
        event.preventDefault();
        return;
      }
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      nudge((event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 60 : 5));
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [payload, nudge, playPause, shown]);

  const width = Math.max(1, w || MODE_SECS[mode]);
  /* The cards are always cumulative. A build order or a technology is a thing
     that happened and stays happened, so "what did they have by now" is the
     only question the columns were ever answering -- windowing them hid the
     early game behind the playhead for no gain. */
  const lo = 0;
  const hi = t;
  /* The window governs the map's action overlay instead, and it looks *back*:
     the fighting in the last `width` seconds, ending at the playhead. Not
     centred on it -- a window that runs past the playhead shows the map things
     that have not happened yet at the time the rest of the page is describing.
     Buildings on the map ignore this entirely and stay cumulative.

     Decay looks back over the same range; the difference is that it weights
     an order by its age inside it rather than counting the whole window
     flat -- see `decayWeight` in components/Minimap.tsx. */
  const actionFrom = mode === "cumulative" ? 0 : Math.max(0, t - width);

  /* Built first: the unit columns rename a line to whatever its owner had
     researched by `hi`, so the tally needs the same techs the tech columns
     compare against. */
  const techsHeld = useMemo(
    () => (payload ? techsHeldBy(payload, hi) : null),
    [payload, hi],
  );
  const tally = useMemo(
    () => (payload && techsHeld ? tallyEvents(payload, lo, hi, techsHeld) : null),
    [payload, lo, hi, techsHeld],
  );

  /* Under Electron the name is up in the title bar; a second copy of it below
     would just be the same words twice. Since the heading is all the toolbar
     has left -- the buttons are on the recordings page now -- there is no
     toolbar at all there. */
  const named = platform.windowControls !== null;

  /* By name, because that is what the files page has to match on -- a row
     knows a filename, not the fingerprint the tab is keyed by. */
  const openNames = useMemo(
    () => new Set(recordings.tabs.map((tab) => tab.name)),
    [recordings.tabs],
  );

  return (
    <>
      <div className={styles.chrome}>
        <TitleBar title={APP_TITLE} />
        {named ? null : (
          <header className={styles.header}>
            <img className={styles.icon} src={iconUrl} alt="" />
            <h1 className={styles.title}>{APP_TITLE}</h1>
            {/* Only ever rendered in a browser, because this header is: under
                Electron you are already in the thing it offers. */}
            <a
              className={styles.download}
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              title="Windows, 64-bit. The build is unsigned, so SmartScreen warns the first time it runs."
            >
              Download for Windows
            </a>
          </header>
        )}
        {/* Inside the chrome, so it stays put while the match scrolls under it
            and counts towards what everything sticky below has to clear. */}
        <TabBar
          tabs={recordings.tabs}
          activeId={shown === null ? active?.id ?? null : null}
          page={shown}
          recordingsOpen={recordingsOpen}
          onPage={setPage}
          onCloseRecordings={closeRecordings}
          onSelect={(id) => { recordings.select(id); setPage(null); }}
          onClose={recordings.close}
        />
      </div>

      {/* The only thing that scrolls. The document itself never does -- the
          chrome above is a flex sibling rather than an overlay, so the window
          has no scrollbar of its own and the bar cannot be scrolled away. */}
      <div className={shown !== null ? `${styles.wrap} ${styles.paged}` : styles.wrap}>
        {/* The page stays put if the parse fails, so the next pick is one click
            away rather than behind the button again. */}
        {shown === "recordings" ? (
          <FilesPage
            library={library}
            saved={saved}
            prescan={prescan}
            busy={busy}
            openNames={openNames}
            status={status}
            error={error}
            onPick={() => void show(recordings.openPicked())}
            onFiles={(f) => void show(recordings.openFiles(f))}
            onOpenLibrary={(entry) => void show(recordings.openFromLibrary(entry))}
            onOpenSaved={(entry) => void show(recordings.openSaved(entry))}
            onReparse={(entry, savedId) => void show(recordings.reparse(entry, savedId))}
          />
        ) : shown === "summary" || !payload ? (
          /* The record, out of the parses already kept -- so it needs nothing
             but the store, and none of the match state below. The second half
             of that test is redundant -- `shown` is already "summary" whenever
             there is no payload -- and is what tells the compiler that the
             match below always has one. */
          <SummaryPage
            saved={saved}
            onRecordings={openRecordings}
            onOpen={(entry) => void show(recordings.openSaved(entry))}
            openNames={openNames}
            busy={busy}
          />
        ) : (
          /* Everything under an open match can move the playhead. It is only
             ever `setT` -- the same seek a drag on the track does -- and it is
             here rather than threaded down because the things that use it are
             a column inside a card inside a team. See hooks/useSeek.ts for why
             `t` itself is not in here with it. */
          <SeekProvider value={setT}>
            {saved.error ? <div className={styles.warn}>{saved.error}</div> : null}
            <MetaBar payload={payload} />
            {!payload.deduped ? (
              <div className={styles.warn}>
                Raw command counts — repeated orders are not collapsed. Re-export with
                --dedupe to fold re-sent orders into one.
              </div>
            ) : null}

            {/* The first thing you look at, and no longer under a panel of
                controls: the playhead moved to the bar docked at the foot of
                the window, and the sparklines to the foot of the page. It
                draws itself away when the payload carries no map.

                It reads the playhead rather than the counting window: the map
                answers "what is standing now", which is a position at an
                instant, not a total over a range. */}
            <Minimap
              payload={payload}
              t={t}
              from={actionFrom}
              mode={mode}
              /* The seconds field is one field for two modes that want
                  different numbers out of it, so a switch carries it along --
                  but only from a default. See `secsForMode`. */
              onMode={(next) => patch({ mode: next, w: secsForMode(mode, next, w) })}
              w={w}
              onW={(next) => patch({ w: next })}
            />

            {/* Directly over the cards, because it is about the cards: which
                order their columns are in, and how far the counting runs. Up
                in the panel it was a third control among things that decide
                *what* is shown, one map-height away from the only thing it
                changes. */}
            <ModeRow
              sortBy={sortBy}
              onSortBy={(next) => patch({ sortBy: next })}
              hi={Math.min(payload.duration, t)}
            />

            <div className={styles.players}>
              {byTeam(payload.players).map((team) => (
                <div
                  className={styles.team}
                  key={team[0].number}
                  style={{ ["--n" as string]: team.length }}
                >
                  {team.map((p) => (
                    <PlayerCard
                      key={p.number}
                      player={p}
                      players={payload.players}
                      counts={tally!.get(p.number)!}
                      ages={payload.ages || []}
                      techsHeld={techsHeld!}
                      t={t}
                      sortBy={sortBy}
                    />
                  ))}
                </div>
              ))}
            </div>

            {/* Last, because they are the second opinion rather than the
                answer: the cards say what each player did, and these say what
                the shape of it was. Ordinary flow -- they scroll with the
                page, and they are deliberately not part of the docked bar,
                which is transport and nothing else. */}
            <div className={styles.sparks}>
              <Sparkline payload={payload} t={t} col={1} title="Resources" unit="resources" />
              <Sparkline payload={payload} t={t} col={2} title="Objects" unit="objects" />
            </div>
          </SeekProvider>
        )}
      </div>

      {/* Docked, not in the flow: a flex sibling of the scrolling pane, the
          same arrangement the chrome at the top of the window uses. The
          transport is the one thing you reach for at any point in a match, so
          it is always where you left it -- which is what the floating HUD used
          to stand in for once the old in-page scrubber had scrolled away.
          There is one bar now and this is it; see FloatingScrubber, which
          draws its pill and owns every button in it. */}
      {payload && shown === null ? (
        <Scrubber
          payload={payload}
          t={t}
          onSeek={setT}
          onNudge={nudge}
          playing={playing}
          onPlayPause={playPause}
          speed={speed}
          onSpeed={() => setSpeed(nextSpeed)}
        />
      ) : null}
    </>
  );
}
