# AoE2 Record Viewer

Drop an Age of Empires II: Definitive Edition recording (`.aoe2record`) on the
window and it is read where it lands — nothing is uploaded — then shows what
each player built, researched and trained, scrubbable along a timeline.

React + TypeScript + Vite in the renderer, Electron around it, and the recording
parser written as plain ESM TypeScript.

Nothing here talks to the network. The recording is read in a worker on your
own machine, and what the app remembers it keeps in IndexedDB.

There are two hosts and one renderer: Electron for the desktop app, and a
browser build published to GitHub Pages. `src/platform/` is the only place
they differ — the browser is handed `null` for anything that needs the
desktop, and the interface asks rather than assumes.

## Getting it

Try it in a browser at **https://ozansahal.github.io/aoe2-record-viewer/** —
drop a recording on the page and it parses there, with nothing uploaded.

The desktop build adds what a browser cannot do: a recordings folder it reads
through and keeps up with, and `.aoe2record` opening on double-click.
**[Download for Windows](https://github.com/ozansahal/aoe2-record-viewer/releases/latest)**
— 64-bit, installer or portable. It is unsigned, so SmartScreen warns the
first time it runs.

## Running it

```bash
npm install
npm run dev
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server + Electron, both watching |
| `npm run dev:web` | Just the dev server, for a plain browser at :5173 |
| `npm run build` | Typecheck, build the renderer into `dist/`, bundle main + preload into `dist-electron/` |
| `npm start` | Build, then run the packaged-layout app |
| `npm run package` | Build, then produce installers with electron-builder |
| `npm run typecheck` | `tsc --noEmit` over the renderer and the Node side |
| `npm run parse` | The report CLI: a recording in, the text report out |
| `npm run events` | The events CLI: a recording in, JSON or CSV out |

## Layout

| Path | Role |
| --- | --- |
| `src/parser/` | The parser: `parse_rec.ts` (port of `parse_rec.py` plus the `mgz` internals it needs) and `filter_events.ts`, as ESM. Everything mgz-shaped is `Rec = any` on purpose -- inventing a shape there is a guess the next save version invalidates |
| `src/parser/aocref-data/` | Reference data (civs, objects, techs, colors) copied from the `aocref` package; imported directly and passed in as `{reference}` |
| `src/parser/runtime.ts` | Where `fs`/`path`/`zlib` are injected, so the renderer bundle never sees a `node:` import |
| `cli/` | The two Node CLIs. They set the runtime, then call the same library the app uses |
| `src/worker/` | The parse worker — a 10 MB recording is ~93k actions and would block the UI for about a second |
| `src/components/`, `src/lib/` | The renderer. A component's hook and its `.module.css` sit beside it; `src/hooks/` is only for the two that more than one file imports |
| `src/platform/` | What the app can ask of its host. `Platform` plus an Electron and a browser implementation, and the shell that provides one — nothing above it touches `window.aoe2` |
| `src/styles/` | `global.css` (tokens, reset, scrollbars) and `ui.module.css`, the few rules more than one component needs |
| `electron/` | Main process, preload, `library.ts` (the recordings folders), `zoom.ts` and `settings.ts` (what is kept across launches) |
| `scripts/` | esbuild bundling for `electron/`, and the dev orchestrator |
| `assets/` | The app icon, `.png` and `.ico` |

The renderer is served over `app://` in production rather than `file://`:
Chromium gives `file://` an opaque origin, which blocks the module worker the
parser runs in.

## The window

There is no menu, and the title bar is the app's own.

- **No application menu.** Nothing in it was ours, and on Windows and Linux it
  drew a strip of system chrome directly above the app's header. macOS keeps
  its menu — that one lives in the system bar rather than in the window, and
  taking it away takes Cmd+Q and the editing shortcuts with it. F12 and
  Ctrl+Shift+I still open the devtools; the accelerators went with the menu, so
  `before-input-event` puts those two back.
- **`titleBarStyle: "hidden"`, not `frame: false`.** The caption goes, the frame
  stays: resize edges, snapping and the rounded corners are still the system's.
  `src/components/TitleBar.tsx` draws the name and the three buttons. The strip
  is one `-webkit-app-region: drag` region — which is also what gives it the
  native double-click to maximize — and the buttons opt back out of it, or they
  would drag the window instead of clicking. macOS renders no buttons: its
  traffic lights sit over the page and the bar only leaves them room.
- **One icon, three places.** `assets/icon.png` is imported by the renderer, so
  Vite hashes it into `dist/` and it serves over `app://` like any other asset —
  it sits beside the name in the title bar, beside the `<h1>` in a browser, and
  is the favicon under the dev server. The same file is the `BrowserWindow`
  icon, reached from `dist-electron/` as `../assets/icon.png`, which is why it
  is in the packaged `files` list as well: unpackaged Windows and every Linux
  take the taskbar icon from there rather than from the executable. Packaging
  reads `assets/icon.ico` on its own — that is what `buildResources` points at.
- **The maximize button follows the window, not the other way round.** Win+Up, a
  snap layout and that double-click all change the state without passing through
  the renderer, so the main process pushes `maximize`/`unmaximize` back over
  `aoe2:window-maximized` and the glyph switches to the restore pair.
- **Zoom is the window's, not a font size.** `webContents.setZoomFactor` scales
  the whole renderer, title bar included, which is what the setting is for: the
  unit and tech columns are dense, and the answer on a large panel is to make
  all of it bigger. Ctrl/Cmd with `+`, `-` and `0` go through the same
  `before-input-event` as F12 — there are no accelerators without a menu — and
  the three small buttons at the right of the title bar do the same thing with
  a mouse. One factor for the app rather than per window: `electron/zoom.ts`
  applies it to every open window, saves it in `settings.json`, and pushes the
  new value back over `aoe2:zoom-changed`, so the percentage in the bar shows
  what the window is at even when a keypress caused it. Chromium drops the
  factor on every navigation, so it is re-applied on `did-finish-load` rather
  than once at startup — otherwise a dev-server reload would silently land back
  at 100%.
- **The bar and the toolbar under it stay at the top.** Both live in one sticky
  `.chrome`, and `useChromeHeight` publishes its height as `--chrome-h`. Two
  things need that number: the player-card headers, sticky themselves, which
  stop underneath it instead of behind it, and the floating scrubber, which is
  meant to appear when the slider is hidden rather than merely past the top of
  the viewport. In a browser there is no title bar at all — the page keeps its
  `<h1>` and the toolbar sticks on its own.
- **Playing is seeking on a timer.** `src/hooks/usePlayback.ts` walks the
  playhead forward by patching the tab's `t`, exactly as a drag or an arrow key
  does, so the cards, the map and the sparklines follow without knowing
  playback exists. It ticks on a `setInterval` against a wall clock rather than
  on `requestAnimationFrame`: the rate that matters is game seconds per real
  second, so a throttled or missed frame must not slow the match down. It keeps
  its own sub-second position — `t` is whole seconds, and at 1× a tick's worth
  of movement would round straight back — and re-seats it whenever `t` arrives
  from somewhere else, which is what lets you drag the slider mid-play. Play at
  the end of a match starts it again from zero. The speed is the window's, not
  the tab's; playback itself stops when you switch tabs or go back to the files
  page, since the playhead it moves belongs to whatever is on screen.

## The recordings folders

Under Electron the app opens on a listing of the folder the game writes to, so
loading yesterday's match is a click rather than a trip through a file dialog
full of identical names. In a browser there is no such folder and none of this
appears — `window.aoe2.library` is undefined and the drop zone is all there is.

- **Found, not asked for.** On Windows the game keeps replays under
  `~/Games/Age of Empires 2 DE/<steam id>/savegame/`; under Proton the same
  layout sits inside the prefix. That path is re-detected every launch, so
  installing the game later is enough.
- **A list, not a folder.** Replays other people sent are wherever they were
  saved to, so the page reads a list of folders: the detected one first, then
  whatever was added through the folders panel (the button at the left of the
  head opens it). Removing a folder deletes nothing and keeps its parses. The
  list is `libraryFolders` in `settings.json` under `app.getPath("userData")`
  — the same file the zoom factor is in, written through `electron/settings.ts`,
  which merges over what is on disk and queues its writes so two settings saved
  at once cannot lose each other. Taking the detected folder off puts it in
  `libraryHidden` so the next launch's re-detect does not put it back. An old
  single-string `libraryFolder` is migrated to the list on first read.
- **Whose game it was.** A recording states which player's client wrote it
  (`pov` on the payload), and for the game's own folder that player is you, so
  `useIdentity` takes the profile that owns most of the detected folder's
  parses as you — by DE profile id (`profile_id`, now on every `Player`), since
  a name is whatever the lobby showed that day. A row whose owner is somebody
  else gets a figure in the gutter next to the crown, the head has All / Mine /
  Others, and the filter box matches player names. The chip in the head names
  you and is a menu for choosing somebody else or going back to detection; the
  pick lives in `localStorage` so a browser with saved rows can use it too.
- **Recordings only.** The listing is `.aoe2record`, `.aoe2rec`, `.mgz`, `.mgx`
  and nothing else, three levels deep, newest first. `.json` is deliberately
  left out even though the dialog and drag-drop accept an exported
  `events.json`: DE writes telemetry and mod manifests as `.json` beside the
  replays, and they are newer than every recording in the folder.
- **The renderer never handles a path.** It asks for an entry by the folder
  and id a listing gave it — a path relative to that folder — and
  `resolveEntry` in `electron/library.ts` checks the folder is on the list,
  re-resolves the id against it and refuses anything that escapes it or is not
  a recording. The one path the renderer does send is the folder to remove,
  and that only ever takes it off the list. Each folder's scan is capped at
  4000 files so pointing the app at a home directory cannot hang it.
- **Same name, two folders.** The files page matches folder rows to kept parses
  by name, and every download is somebody's `rec.aoe2record`, so a parse that
  knows which folder it came from (`root` on the saved row) goes to a row in
  that folder first. The background scan keys on folder and path for the same
  reason.

The list re-scans whenever the window regains focus: alt-tab out of a match and
back, and the replay you just finished is at the top.

### Reading it through in the background

A row of that folder is a filename the game invented, and a filename says
nothing about the game. So the folder is also read through on its own
(`src/hooks/usePrescan.ts`): each recording is parsed and kept exactly as an
opened one is, newest first, and the rows fill in with the map, the difficulty,
the length and who won as it goes. By the time a row is worth clicking,
clicking it is a read rather than a parse.

It starts itself off the first listing — including the re-list on focus, which
is how the match you just finished gets read without asking. The rescan button
is the manual one: it re-lists the folder *and* takes the stop off.

A 10 MB recording is about a second in the parse worker, which is cheap enough
to give away and far too expensive to spend on a folder of four thousand. What
keeps it in its place:

- **One at a time**, in the worker the app already parses in, so the window
  stays smooth throughout.
- **Never while somebody is waiting.** The worker is shared, so the queue holds
  while a recording somebody asked for is parsing: an open waits for at most
  the file already in flight, never for the queue.
- **Capped at `MAX_SCANNED`.** Past that the scan would only evict its own
  earlier work.
- **Stopped for good on the first file the store will not take** — a full store
  means every later parse is thrown away too.
- **Stoppable**, from the progress line, and it stays stopped: the folder
  re-lists on every focus and that must not undo the decision.

Nothing is scanned twice. The second run finds each one in the store already
and spends a read and a fingerprint instead of a parse — which is also why a
file the parser cannot read is remembered as tried, rather than retried on
every focus.

**Recordings the parser cannot read are dropped from the list**, since the row
would carry nothing but a filename and clicking it would fail the same way. A
footer says how many, because a listing that quietly loses files is a listing
you cannot trust, and rescan forgets them and tries them again.

Those failures are remembered between launches, in `localStorage` under
`aoe2:unreadable` (`src/lib/scanFailures.ts`) — otherwise every start would
spend a pass re-discovering the same refusals, which on the development folder
is ninety-three of them. The key is the file's **path, size and mtime
together**, not its path: DE writes a replay *while the match is being played*,
so a recording of a game in progress is half a file and does not parse until
the game has finished with it. Keyed by path alone that match would be hidden
for good; keyed this way the entry stops matching the moment the file grows,
and the next scan picks it up on its own with nothing having to notice the game
ended.

## Saved recordings

Everything opened — dropped, picked, or clicked in the folder listing — is kept
in IndexedDB (`src/lib/savedStore.ts`, `src/hooks/useSaved.ts`) and listed on
the files page, alongside the folder rather than in a panel of its own. A
recording in both places is one row carrying both badges.

Which tabs were open is remembered separately, in `localStorage` under
`aoe2:tabs` — ids and view state only. The payloads come back from IndexedDB on
the next run, so restoring a session re-parses nothing.

There are five ways a recording gets in — a drop, the browser's picker, the
Electron dialog, a row of the files page, a file association — and they differ
only in how the bytes are fetched. Each becomes a `Source` and every one goes
through `openSource` in `src/lib/sources.ts`, so "is this saved already?" and
"save it" are asked once, in one place. Neither that funnel nor the store below
it knows which front end is running: the store's whole interface is the three
methods in `Store`, and Electron contributes nothing to it but a `Source`.
`scanSource` beside it is the same road minus the destination — no tab, no
note — and is what the background scan of the folder runs on.

- **The parse is what is saved, not the file.** A 10 MB recording becomes a
  ~30–95 KB payload, so a hundred matches cost a few megabytes. Re-opening one
  is a read, not a second of parsing.
- **Storage is not a real limit.** IndexedDB gets a share of the disk — 60% of
  what is free in Chromium, 10% in Firefox, around a gigabyte in WebKit — where
  localStorage would have capped at ~5 MB and only held strings. The panel shows
  what `navigator.storage.estimate()` reports, and offers `persist()` so a
  browser clearing space under pressure leaves this origin alone. The cap that
  does bite is ours: `MAX_SAVED`, the 100 most recently opened, and
  `MAX_SCANNED` beside it.
- **Opened and scanned rows are counted separately.** The background scan can
  fill a folder's worth of rows in a few minutes, so a single list sorted by
  date would let it push out matches somebody actually opened. A scanned row
  carries `scanned: true`, is evicted only against other scanned rows, and is
  dated by the recording's own mtime rather than by when the scan reached it —
  eviction reads the same field, so it is the newest replays that survive.
  Reading one is what makes it an opened recording: `readSaved` takes the flag
  off. A row without the flag is one somebody opened, which is what every row
  written before the scan existed was, so no `PAYLOAD_V` bump was needed.
- **Keyed by content.** `fingerprint()` in `src/lib/loadPayload.ts` is a SHA-256
  prefix, so the same match dropped twice, or renamed, is one row and one parse.
  Where `crypto.subtle` is missing (any non-secure context — plain http on a LAN
  address) it falls back to name and length. Fingerprint *before*
  `loadRecordingBytes`, which transfers the buffer to the worker and detaches
  it. The dedupe window goes in the key too: parse the same recording with a
  different one and the right answer is different, not stale.
- **Nothing depends on it, including when it hangs.** A private window, blocked
  storage or a full disk costs you the list and nothing else — `useSaved`
  catches. Stalls need more than a `catch`: IndexedDB can leave a request
  pending with no `error` and no `blocked` event (a `deleteDatabase` waiting on
  a connection another tab holds does exactly that), and the load path awaits
  the store. So the open and every request carry a deadline, and a store that
  misses it is treated as one that said no — the recording parses, opens, and
  the panel says it could not be saved.
- **`PAYLOAD_V` invalidates the lot.** Bump it when a parser fix changes what a
  payload contains — older rows stop being listed and are swept on the next
  write, so a stale parse is never shown.

Opening files takes as many as you hand it: the file input and both drop
handlers are multi-file, and the Electron dialog has `multiSelections`. A batch
is parsed one at a time and the first to land is what you look at; the rest are
saved. The dialog returns `{token, name}` per file rather than paths or bytes,
and the renderer redeems tokens through `readSelected` one by one, so picking
twenty replays is not twenty recordings in memory at once.

## The summary

The second permanent tab (`src/components/SummaryPage.tsx`, `src/lib/summary.ts`)
is the saved rows read the other way round: the files page answers "what did I
play", this answers "what came of it". One list of periods, each of which opens
onto a grid of itself: difficulty down the side, map across the top, won out of
played in each square with the rate beside it. Hardest is the first row and it
eases downwards; the last column and the top row are the by-difficulty and
by-map totals, which is what those used to be as two separate tables — "Arabia
is 33%" and "Hardest is 32%" never said whether the map went badly because it
is the one you play the hardest AI on. The first period is open when the page
arrives, and only one is open at a time: the grid is about as tall as the list
is long, so a second one pushed the first off the screen. The comparison worth
having without scrolling — the last week against the rung under it — is on the
card, in points, with the period it is measured against named on its tooltip.

- **The periods are a ladder, not a calendar.** `ladder()` gives the last
  week, the week before it, the rest of this month, last month, the rest of
  this year, then a row per year back to the oldest game. Uniform weeks were
  what this was first, and they are the wrong shape for the question: fourteen
  rows of "Jun 8 – Jun 14" are fourteen dates to place before any of them means
  anything, while "how am I doing lately" wants detail at the near end and none
  at the far one. The rungs are cut against each other rather than being ranges
  in their own right — the last week can start in last month, so the month gets
  what is left of it and says "Rest of July" — which is what keeps every game
  in exactly one row.
- **The two week rungs roll with the day.** Seven days back from today, by
  whole days. On a Monday-to-Sunday calendar, "this week" on a Monday morning
  is one evening of games and the fortnight you actually played is split across
  the two rows under it: the answer moves because the calendar turned over,
  which is not something that happened to your play. Whole days rather than to
  the hour, so a game does not drop out of the window while you are looking at
  it. The exact dates are on each row's tooltip, since a relative label is the
  one thing that cannot say them.

The grid is `crosstab()` in `src/lib/summary.ts`, and it is built only for a
date that is open: a folder of a thousand recordings is a hundred periods, and
crossing every one of them to draw twelve would be most of the page's work
thrown away. Past the width it scrolls sideways with the difficulty column
pinned — a year can be twenty maps — and the page itself never does.

It is arithmetic over `saved.entries` and nothing else. A `SavedEntry` already
carries the map, the difficulty, the roster and `pov`, so the page opens no
file, reads no payload and costs nothing to show — and it only ever knows what
has been parsed. A folder the background scan has not finished is a summary of
the part of it that has, which the page says rather than presenting a short
total as the whole truth.

- **When a game was played is read off its name.** `playedAt` takes the stamp
  the game writes into every replay's filename (`@2026.08.17 212220`). `savedAt`
  is when this app first parsed it and `openedAt` moves every time you look at
  it, so a summary built on either would drag a game from March into this week
  the moment you opened it. `openedAt` is still the fallback for a recording
  named something else — the scan dates those rows by the file's own mtime.
- **A win belongs to `pov`, so a row without one is not counted.** That is the
  player whose client wrote the file, which for the folder the game keeps is
  you; nothing else in a recording knows which player somebody is. Rows that
  name no owner are left out and reported, because "did you win" has no answer
  at all for one of them.
- **Campaigns and scenarios are out by default**, as they are on the files
  page: a dozen attempts at one mission would otherwise be most of the record.
  The count is stated with the toggle that folds them back in.

## Data contract

`filterEventsAsync()` returns the payload the UI renders. Keep this shape — it
is also the on-disk `events.json` format, so previously exported files keep
working.

```jsonc
{
  "map": "Arena",
  "duration": 3075,            // seconds
  "speed": "Standard",
  "difficulty": "Hard",
  "deduped": true,
  "players": [{
    "number": 1, "name": "zzytds", "civilization": "Teutons", "color": "Blue",
    "team": 1, "winner": true, "resigned": false,
    "ai_name": "", "is_ai": false, "handicap": 100
  }],
  "series": [{ "player": 1, "rows": [[6, 475, 69]] }],  // [t, resources, objects]
  "ages":   [{ "t": 480, "player": 1, "age": "Feudal Age" }],
  "events": [{ "t": 4, "player": 1, "cat": "build", "item": "House", "qty": 1 }]
}
```

`winner` is inferred and `resigned` is not: a `RESIGN` action names the player
who sent it, and the winners are then everyone on a team nobody resigned from.
Where no one resigned — a conquest, a drop, a recording that stops early —
there is no winner to name and every player stays `false`, which is why the
card shows who resigned rather than who won.

`events` are commands *issued*, not completions — a cancelled building still
appears. `ages` are real completion times (from the in-game notification).
`series` are SYNC samples every ~7 s; `total_resources` is a summed stockpile
and mgz treats those field offsets as guesses, so read it as a trend.

## The map

`Payload.minimap` is the one field the parser does not produce. The tiles, the
gaia objects and the build positions only exist on the `match` the parser
builds and then throws away, so `src/worker/parse.worker.ts` runs
`buildMinimap()` (`src/lib/minimap.ts`) over it before it goes, and hangs the
result on the payload.

It is deliberately *not* part of `fromMatch`, and so not part of the
`events.json` above: that shape is a contract older exports have to keep
matching. The field is optional
everywhere — an imported `events.json` and any payload written before this
existed simply have no map, and `Minimap.tsx` draws nothing.

- **Three byte layers, run-length encoded** — terrain, elevation, and what sits
  on the tile. A 120×120 map is 14,400 tiles per layer and a Ludikris one is
  230,400, against a payload that is otherwise ~95 KB and is kept for a hundred
  matches. Terrain and elevation come in long runs, so the encoding is a
  quarter of the size for twenty lines; on the development recording the three
  layers are 9.8 KB rather than 43 KB.
- **Colour comes from the dataset, resolved in the worker.** The three
  `up`/`level`/`down` minimap colours per terrain are in
  `aocref-data/datasets/100.json`, which is bundled into the worker and nowhere
  else. Only the terrains a map actually uses are carried, so the renderer
  needs no reference data at all.
- **Gaia is rasterised, not listed.** ~9,700 objects, mostly trees, become one
  byte per tile. Classified by name rather than object id: names are stable
  across datasets, and about a fifth of gaia has no name in the table, which
  falls through to "nothing".
- **`buildingsAt()` is provisional** and says so in its own doc comment. It is
  build *orders* up to a time, not what was standing, and it is meant to be
  replaced by a real model. The rule that is not provisional is **one slot per
  anchor**: a player who cannot afford a building mashes the placement, and one
  player in `rec-old.aoe2record` issued 203 `Build "Town Center"` commands at a
  single anchor. Keyed by anchor that file's 509 placements are 253 buildings.
  A time-window debounce does not work here and was measured — the mashing runs
  for minutes.
- **Anchors are exact and sometimes half-integer.** The position a `Build`
  reports is the building's centre, not the click, and an odd-footprint
  building (Farm, Barracks, Stable) is anchored at `x.5`. Rounding moves every
  one of those a tile.
- **A Town Centre is six objects.** In `players[].objects` it is id 109 plus
  618/619/620 and two unnamed pieces at offset positions. Filter with the
  parser's `TC_IDS` or every starting position gets four town centres.

## Don't break these

Hard-won details in the parser that look like cleanups but are not:

- **`Inputs.addAction` mutates the action payload it is handed** — BUY/SELL
  amounts are scaled ×100 there, and an action with no selection inherits the
  previous one's `object_ids`. Skipping it reports market trades 100× too small.
- **`bytesCopy`, never `.slice()`** — on a Node `Buffer`, `slice` returns a
  view, so reversing it corrupted the caller's recording and a second parse of
  the same buffer failed.
- **The mgz corrections are deliberate.** In the DE block: player records
  carry a trailing `de_string` (mgz_patch calls it new in save 68; save 67.2
  has it too), the block ends with two int32s ahead of the timestamp so the
  cursor must skip them or the ai flag is read 8 bytes early, and the fixed 33
  bytes after the modded dataset are 27 plus a `de_string` — a lobby
  game leaves that string empty, a single-player game names its scenario in it.
  In the scenario block: the two 64-byte blocks mgz reads after the scenario
  filename come before it, the six message ids come after it, `aocString` reads
  its length unsigned, and the settings-version marker the trigger search looks
  for is 4.7 at save 67.2 and 4.9 at save 68 (mgz's table stops at 4.5). The
  triggers themselves are walked in `deTrigger` rather than in mgz's much older
  shape, and what follows them is 1028 bytes plus the scenario's variables
  rather than a flat 1032. Elsewhere: AI-issued RESEARCH omits the trailing
  selection list; operation 5 in the body is a chapter marker mgz has no branch
  for; and difficulty, population and lock_teams are not read from where mgz
  reads them (see `instructionsSetting` and the header notes in `parse_rec.ts`).
  Every one of these is deliberate. mgz disagreeing here is not a bug to be
  fixed back; it is a save version mgz has not caught up with.
- **`PLAYER_END` is a regex, not a literal** — the byte after the eight `0xff`
  is a wildcard.
- **Payload key insertion order matters** for the text report's action log.
- **A parser change is proved against real recordings.** Before and after it,
  drive the CLIs over a folder of recordings across the 15 flag combinations
  and diff the output byte for byte. Identical is the bar; anything that moved
  is a bug you just introduced.

  `npm test` covers what needs no recording — the stream reader, the event
  filter, the achievement struct — and it is not the gate. The thing most
  likely to break is a byte offset, and an offset only shows itself against a
  real file.

## End-game achievements

`parseAchievements` in `src/parser/parse_rec.ts` is a port of mgz's
`body/achievements.py`: the score screen a game appends as a single action of
type `0xFF`. It is verified field-for-field against mgz's own `construct`
definition.

**No Definitive Edition recording contains it.** A DE file ends with a postgame
*operation* carrying leaderboards and world time — which is where
`rate_snapshot` comes from — and no score screen at all, so kills, losses,
razings, conversions, gathered resources, explored percentage, relics and the
four category scores are simply not in the format. `parseAchievements` returns
null for those files and `deriveAchievements` reconstructs the subset the body
does support, marking each record `source: "derived"`:

| Field | Where it comes from |
| --- | --- |
| `feudal/castle/imperial_time` | the in-game age notification — exact |
| `research_count` | distinct research *orders*, so a cancelled tech counts |
| `tribute_sent` / `tribute_received` | tribute actions, fees excluded — exact |
| `total_wonders` / `total_castles` | build *orders*, not finished foundations |
| `snapshot` | peak and final totals from the SYNC stat rows |

Everything else stays null rather than being guessed at. Nothing renders this:
the viewer had a Final tally panel over it and no longer does, so the records
sit on `match.players[].achievements` for whatever reads them next.

## Known gaps

- The difficulty label is read from the English instructions block only; other
  languages fall back to mgz's (wrong) header value.
- DE save 67.2 and save 68 are verified. Older DE, HD and UserPatch branches
  are ported as written but untested.
- Dataset 101 (the AoE1-in-DE mod) is bundled but has not been exercised.
- Single-player recordings used to fail — 93 of the 131 in the development
  folder — with `de_string marker assertion failed`. They read now (see the DE
  and scenario corrections under "Don't break these"), and the whole folder,
  132 files across save 67.2 and save 68, parses. What was wrong
  was never one thing: a scenario name in a field mgz reads as fixed bytes, a
  settings-version marker two versions out of date, the scenario filename on
  the wrong side of 128 bytes of padding, a signed string length, a trigger
  block walked in a shape the game no longer writes, and a chapter marker in
  the body with no branch for it.
