import { useEffect, useMemo, useRef, useState } from "react";

import { playerColor } from "../lib/format";
import {
  KIND, OVERLAY, buildingsAt, decodeLayer, projectTile, unprojectPoint,
} from "../lib/minimap";
import { byTeam } from "../lib/teams";
import { DECAY_SECS } from "../lib/view";
import { OrderFeed } from "./OrderFeed";
import type {
  MapMark, Minimap as MinimapData, MinimapAttacks, Mode, Payload, Player,
} from "../types";
import styles from "./Minimap.module.css";

/*
 * The map, drawn the way the game draws it.
 *
 * ---- diamond, not square ----
 *
 * A square render is a handful of lines shorter and just as legible, and it is
 * still the wrong picture: an AoE2 player has spent every match reading this
 * map rotated 45 degrees, so a square one has to be turned in the head before
 * "my base was bottom-left" means anything. Since the raster is built by
 * walking destination pixels and asking which tile each one lands on -- which
 * is what avoids the seams and gaps that painting rotated quads gives you --
 * the rotation costs one extra line in `unprojectPoint` and nothing else. What
 * it costs is canvas: the plot is 2:1 and something under half of it is empty.
 * That is the trade, and familiarity wins it.
 *
 * ---- what is drawn where ----
 *
 * Ground and forest go in a raster: they are areas, they cover the map, and
 * they never change for the length of a match, so it is built once per
 * recording into an offscreen canvas and kept in a WeakMap keyed by the
 * minimap itself. Switching tabs and coming back is a blit, not a rebuild.
 *
 * Everything a player actually looks for -- the gold, the stone, the berries,
 * the sheep, the buildings -- goes on top as marks a little larger than a
 * tile. Drawn as ground they would be four pixels of a slightly different
 * colour among fourteen thousand others; drawn as marks a seven-tile gold
 * clump is a blob you can find without hunting for it. That is the whole
 * reason for the split.
 *
 * ---- fixed backing store ----
 *
 * The canvas has a fixed pixel size and CSS scales it. It is measured against
 * nothing, so there is no ResizeObserver to not fire and no zero-sized canvas
 * to debug -- see the "Verifying UI changes" section of the root CLAUDE.md for
 * why that matters here.
 */

/**
 * Backing-store size. 2:1, because the diamond is twice as wide as it is tall.
 *
 * Twice the width the plot is ever displayed at, which is the whole of the
 * antialiasing story. The ground is a walk over destination pixels asking
 * which tile each one lands on -- one sample, no coverage -- so every edge in
 * it is a hard pixel boundary: the diamond's own outline stair-stepped, a
 * treeline came out ragged, and a tile is about three pixels wide at zoom 1,
 * which is exactly the ratio that moires. Painting at 2x and letting the
 * browser scale it down to the CSS width is a 2x2 box filter run on the GPU
 * for nothing, and it is also what makes the plot right on a HiDPI screen,
 * where 1024 was being magnified rather than reduced.
 *
 * It is affordable because the walk no longer decides anything per pixel: the
 * colour of every tile is resolved once in `decode` and the loop is a gather.
 * 2048x1024 measures ~5 ms against ~11 ms for the old 1024x512 -- four times
 * the pixels and half the time. Supersampling further is not worth it: 4096
 * is 16 MB of ImageData per view change and the edges are already smooth.
 *
 * Everything drawn on top is sized against RASTER_W, so nothing else has to
 * know this number changed.
 */
const RASTER_W = 2048;
const RASTER_H = 1024;

/**
 * One pixel of the 1024-wide store the mark sizes below were tuned against.
 *
 * The minimum radii are floors in raster pixels -- "never smaller than two" --
 * and a floor written in raster pixels shrinks on screen when the raster
 * grows. This keeps them the size they look.
 */
const PX = RASTER_W / 1024;

/** The resources drawn as marks, in the order they are painted. */
const RESOURCE_CODES = [
  OVERLAY.fish, OVERLAY.hunt, OVERLAY.herd, OVERLAY.relic,
  OVERLAY.berries, OVERLAY.stone, OVERLAY.gold,
] as const;

/**
 * What each thing on the map is drawn in.
 *
 * Mostly the game's own minimap conventions -- gold is gold, stone is grey,
 * forest is a darker green than any terrain the table hands back so a treeline
 * reads as an edge rather than as a change of ground. Three are deliberately
 * not the obvious choice, because the player colours have first claim on the
 * bright end of the wheel and a resource that could be mistaken for somebody's
 * buildings is worse than an unconventional one:
 *
 * - berries are a deep maroon rather than a bright red, which is the red
 *   player's;
 * - a relic is violet rather than the gold-yellow it would otherwise share
 *   with actual gold;
 * - hunt is dark enough to hold against desert, which is most of what a dry
 *   map's ground is.
 */
const OVERLAY_COLOR: Record<number, string> = {
  /* Flat, and barely green. Forest is an area, not a thing to find, so it is
     drawn in one colour with no slope shading -- and a dull one, or a treeline
     competes with the green player's buildings sitting in front of it. */
  [OVERLAY.forest]: "#2c3a2c",
  [OVERLAY.fish]: "#2f93c4",
  [OVERLAY.relic]: "#b98ae0",
  [OVERLAY.herd]: "#f4f2e8",
  [OVERLAY.hunt]: "#7d4f24",
  [OVERLAY.berries]: "#8f2233",
  [OVERLAY.stone]: "#9fb3c4",
  [OVERLAY.gold]: "#ffcf3d",
};

/**
 * The terrain half of the legend under the plot, in the order a player would
 * look for them. The players are the other half, and a separate list: see the
 * `floats` markup down the left of the plot.
 */
const LEGEND: { code: number; label: string }[] = [
  { code: OVERLAY.gold, label: "Gold" },
  { code: OVERLAY.stone, label: "Stone" },
  { code: OVERLAY.berries, label: "Berries" },
  { code: OVERLAY.herd, label: "Sheep" },
  { code: OVERLAY.hunt, label: "Hunt" },
  { code: OVERLAY.relic, label: "Relic" },
  { code: OVERLAY.forest, label: "Forest" },
];

/**
 * Pull a terrain colour towards grey and darken it.
 *
 * The game's own palette is for a minimap with no player buildings drawn on
 * it. Here the ground is background: Arena's grass is a strong green and the
 * green player's buildings vanish into it, which is the one thing the map
 * exists to show. Muting the ground costs a little terrain-to-terrain contrast
 * -- grass against dirt -- and buys every player colour back.
 *
 * Applied to ground only. Gold, stone, berries and the rest keep their full
 * strength; they are marks on the background, not the background.
 */
function mute(rgb: [number, number, number]): [number, number, number] {
  const grey = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  const toward = (c: number) => Math.round((c * (1 - MUTE_GREY) + grey * MUTE_GREY) * MUTE_DIM);
  return [toward(rgb[0]), toward(rgb[1]), toward(rgb[2])];
}

/** How far the ground is pulled to grey, and how far it is darkened. */
const MUTE_GREY = 0.62;
const MUTE_DIM = 0.68;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return hex.length >= 7
    ? [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    : [((n >> 8) & 15) * 17, ((n >> 4) & 15) * 17, (n & 15) * 17];
}

/* ------------------------------------------------------------------ */
/* the military layer                                                  */
/* ------------------------------------------------------------------ */

/**
 * Spread of one order, in tiles, and the kernel radius that covers it.
 *
 * A mark per tile leaves the layer as isolated pinpricks -- on a 1v1 the two
 * players' attack tiles overlapped in 5% of cells at one-tile resolution and
 * 19% at three. The spread is what turns a scatter into a front line.
 *
 * 0.95, down from the 1.5 this started at by way of 1.2: a front line is the
 * point, but at 1.5 a raid two screens from anything else still painted a blob
 * wide enough to read as a fight, and along a real front the two players'
 * clouds met well short of where either side actually was. Narrower keeps the
 * front and gives the isolated orders back their position.
 *
 * The last step down is about the centres rather than the width. The kernel is
 * flat near its peak, so at 1.2 the ring one tile out still carried 71% of the
 * middle's weight and a blob read as an even patch; at 0.95 that ring is at
 * 57% and the busiest tile is visibly the busiest. The falloff does the work
 * -- nothing is added at the centre, so the compression below is untouched.
 *
 * The radius stays at 3 -- over 3 sigma now rather than 2 -- so the tail is
 * cut further out than before rather than closer in, and narrowing the spread
 * does not square the kernel off. It costs nothing: the loop is bounded by the
 * radius whatever sigma says.
 *
 * A lone order's own cell is unaffected: its weight is exp(0) = 1 for any
 * sigma, so the anchor `HEAT_REF` is tuned against below still holds.
 */
const SPLAT_SIGMA = 0.95;
const SPLAT_R = 3;

/**
 * A flat scale on the finished layer's alpha.
 *
 * Separate from the compression below on purpose. `HEAT_REF` sets what a given
 * *volume* of orders is worth, and moving it re-ranks the map -- a busy tile
 * and a quiet one change by different amounts. This changes nothing about the
 * ranking; it only says how far the whole layer sits in front of the ground it
 * is drawn over. The buildings and the resources are what the map is for and
 * the fighting is context on them, so the context gives way a little.
 */
const HEAT_ALPHA = 0.92;

/**
 * How much of a farm is drawn.
 *
 * Farms are a third of every building on the map by count and none of what a
 * base is: a boom is eighty 3x3 patches of the owner's colour, and at full
 * strength the Town Centre and the Castle in the middle of them are the same
 * colour as the field. Held back they still read as held ground, which is what
 * a farm is, and stop being the first thing the eye lands on.
 */
const FARM_ALPHA = 0.45;

/** The outline a Castle, a Town Centre and a starting position all share. */
const KEEP_EDGE = "rgba(12,14,17,.72)";

/**
 * How far out a Castle's cross reaches, as a share of the footprint.
 *
 * Short of the corners rather than into them, because a cross that meets the
 * border stops being a mark inside the box and becomes part of it: the
 * vertices are where the diamond is narrowest and the border is already
 * sitting in them, so the tips land in ink that is already dark and what is
 * left reads as four filled triangles rather than as a box with a cross in it.
 *
 * At 0.55 the arms end with the owner's colour still around them on all four
 * sides -- roughly a quarter of the footprint between each tip and the border
 * -- which is what makes the cross a shape rather than a texture, and leaves
 * enough colour showing that whose Castle it is survives the mark.
 */
const CROSS_SPAN = 0.55;

/**
 * How much one order still counts for, given its age, the window it is decaying
 * across, and how sharp the fade is. 1 at the playhead, 0 at the far edge of
 * the window.
 *
 * Exponential, because that is what "still going on" looks like: the fighting
 * a few seconds back is nearly all of what you want to see, and the rest
 * should be on its way out rather than sitting at half strength until it
 * vanishes. `span` is how sharp that is -- it is how many e-foldings fit in
 * the window, so an order is down to `e^-1` at `1/span` of the way through it.
 *
 * `DECAY_SPAN` is where the chip over the plot starts, rather than a constant
 * the layer is stuck with: 1.6, a half-life of 43% of the window against the
 * 23% the 3 this began at gave. At 3 the fade was over almost as soon as it
 * began -- a fight was bright for a few seconds and then effectively gone, so
 * the window behind it never got to be context and the layer flickered as much
 * as the hard cut it exists to avoid. Slower, the trail behind the fighting
 * lasts long enough to read as a trail. It is worth being a control because
 * how much trail is wanted depends on what is being looked for: a raid is a
 * moment, a siege is a minute, and the same number cannot suit both.
 *
 * The subtraction is not decoration. A bare `exp(-k * age / w)` is still worth
 * `e^-3` = 5% at the window's far edge, and orders cross that edge as the
 * playhead moves: the layer would shed a visible rim of colour every time one
 * fell out, which is exactly the popping that window mode's hard cut already
 * has and this mode exists to avoid. Rescaled to hit zero at the edge, an
 * order leaves the window at the weight it will leave at -- nothing. The
 * flatter the decay the more that subtraction matters: at 1.6 a bare
 * exponential would still be worth 20% at the edge, and the control reaches
 * down to 0.4, where it would be worth 67%.
 *
 * `floor` is that rescaling term, `e^-span`. Passed in rather than derived
 * here now that the span moves: it is one exponential for a whole pass, and
 * this is called once per order.
 *
 * Note this makes the two windowed modes genuinely different pictures rather
 * than one dimmer than the other: `window` answers "where was there fighting
 * in the last two minutes", `decay` answers "where is the fighting now", with
 * the last two minutes as context behind it.
 */
const DECAY_SPAN = 1.6;
const decayWeight = (age: number, secs: number, span: number, floor: number) =>
  (Math.exp((-span * age) / secs) - floor) / (1 - floor);

/**
 * What decay mode starts at, relative to the same ground in the other modes.
 *
 * Every weight in this mode is a fraction of the one an order gets elsewhere,
 * so the layer is strictly dimmer than window mode over the same orders -- and
 * the thing it is meant to show, the fighting *now*, is the part paying least
 * for it, because the tile under the playhead is competing with the whole
 * window's worth of orders in the other mode. Starting the fade a fifth above
 * the flat rendering puts the live front line back where the eye expects it
 * and lets the rest of the window fall away behind it.
 *
 * On the finished opacity rather than on the weight, so it means what it says:
 * `heat` is logarithmic, and a 1.2x on the count would arrive as a few percent
 * of brightness. Clamped, so a tile already at full does not overflow.
 */
const DECAY_GAIN = 1.2;

/**
 * The count that reaches full opacity, for a player of average volume.
 *
 * Naive alpha accumulation cannot do this job. Repeated source-over draws give
 * `1-(1-a)^n`, so the span from "just visible" to "saturated" is
 * `ln(.05)/ln(.95)` = 58:1 *whatever* alpha you pick -- lowering it slides the
 * window, it does not widen it. The real range is far wider: a human's busiest
 * attack tile holds 15 orders and an AI's holds 814.
 *
 * So the weight is compressed instead. Log, not sqrt: at the measured
 * quantiles sqrt leaves the median tile at 1.5% opacity, which is invisible.
 * And the reference is anchored rather than taken from the per-match maximum,
 * or a quiet game renders as loud as a busy one. 32 is chosen so a single lone
 * order lands at 0.198 -- what a naive alpha of 0.2 would have given it --
 * while nothing can blow out.
 *
 * It is the anchor at strength 1, not the only one there is: the "military"
 * chip over the plot divides this by its number, so 2 means half the orders
 * reach any given brightness and 0.5 means twice as many are needed. Strength
 * rather than the reference itself, because the reference is backwards -- a
 * *smaller* count for full opacity is a *louder* layer -- and nobody reading a
 * map wants to hold that in their head. It re-ranks rather than dims, which is
 * the difference from `HEAT_ALPHA`: at a higher strength the quiet tiles climb
 * further than the busy ones, which are already near the top of the log.
 */
const HEAT_REF = 32;

/**
 * The widest a player's own reference may stray from that anchor.
 *
 * One reference for everybody is what left the human invisible: separate grids
 * stop the AI's orders from being *added* to the human's, but with a shared
 * reference the AI's median tile still sits at 0.87 opacity and the human's at
 * 0.2, so the map reads as the AI's map with a few faint smudges on it. The
 * cure is to compare each player against their own volume: 800 orders on a
 * tile means something different from a player who issued 15,000 all game than
 * from one who issued 400.
 *
 * The bound stops that from becoming a lie in the other direction. A player
 * who barely fought at all would otherwise get a reference near zero, and
 * their three stray orders would paint as loud a front line as a real battle;
 * an eight-player game would push the busiest player's reference up eightfold
 * on nothing but headcount. A factor of eight either way covers the AI-versus-
 * human gap -- 15:1 in the recordings here -- and refuses to go further.
 */
const REF_SPAN = 8;

/**
 * Each player's reference, from their share of the orders across the *whole*
 * game -- not the window on screen.
 *
 * Whole game because the weighting has to hold still. Scaled to the window,
 * every scrubber move would rebalance the colours underneath the playhead, and
 * a lull in which the AI happens to be quiet would blow the human up to full
 * brightness and back down a second later. Fixed per match, the layer stays a
 * comparison between players rather than a comparison with a moving target.
 *
 * The mean is the pivot, so the total ink is roughly what it was: the busy
 * player is pulled down about as far as the quiet one is pushed up, and a
 * match where everybody fought equally comes out exactly as it did before.
 *
 * `anchor` is `HEAT_REF` scaled by the strength chip -- what an average player
 * needs for full opacity. Every player's own reference is a share of it, so
 * the control moves the whole layer without touching the balance between them.
 */
function heatRefs(attacks: MinimapAttacks, anchor: number): Map<number, number> {
  const totals = new Map<number, number>();
  for (let i = 0; i < attacks.player.length; i++) {
    const number = attacks.player[i];
    totals.set(number, (totals.get(number) ?? 0) + 1);
  }
  const mean = attacks.player.length / totals.size;
  const refs = new Map<number, number>();
  for (const [number, total] of totals) {
    const share = Math.min(REF_SPAN, Math.max(1 / REF_SPAN, total / mean));
    refs.set(number, anchor * share);
  }
  return refs;
}

/** Opacity for one accumulated weight, against `1 / log1p(ref)` for a player. */
const heat = (weight: number, invLog: number) => Math.min(1, Math.log1p(weight) * invLog);

/**
 * Accumulate the attacks up to `at` into one RGBA image in *tile* space.
 *
 * Tile space, not screen space, so this runs once per playhead move rather
 * than once per pan, and so the per-player composite happens on a few thousand
 * cells instead of half a million pixels.
 *
 * Players are accumulated separately and combined at the end, and each is
 * compressed against its own reference from `heatRefs`: an AI issues thousands
 * of attack orders to a human's few hundred, so a shared grid would normalise
 * the human out of existence, and a shared reference would still leave the
 * human at a fifth of the AI's opacity on comparable ground. Colour is the
 * alpha-weighted mix and opacity is the screen combination, which makes
 * contested ground -- where two players' attacks overlap -- come out as its
 * own hue rather than as whoever happened to be drawn last.
 */
function heatTiles(
  data: MinimapData, from: number, at: number, colors: Map<number, string>,
  /**
   * Seconds the weighting decays across, or 0 for none -- which is both
   * cumulative and window mode, where every order in range counts the same.
   * When set it is the window's own length, so the fade finishes exactly where
   * `from` cuts.
   */
  decay = 0,
  /**
   * How sharp that fade is, in e-foldings across the window. Only read when
   * `decay` is set; see `decayWeight`.
   */
  span = DECAY_SPAN,
  /**
   * How strong the finished layer is, as a multiple of the anchor `HEAT_REF`
   * was chosen at: higher is brighter, because the count it takes to saturate
   * is divided by it.
   */
  strength = 1,
): Uint8ClampedArray<ArrayBuffer> | null {
  const gain = decay ? DECAY_GAIN : 1;
  const floor = Math.exp(-span);
  const attacks = data.attacks;
  if (!attacks || !attacks.t.length) return null;
  const { dim } = data;
  const area = dim * dim;

  const grids = new Map<number, Float32Array>();
  let drawn = 0;
  for (let i = 0; i < attacks.t.length; i++) {
    if (attacks.t[i] > at || attacks.t[i] < from) continue;
    const number = attacks.player[i];
    let grid = grids.get(number);
    if (!grid) { grid = new Float32Array(area); grids.set(number, grid); }
    const cx = attacks.x[i];
    const cy = attacks.y[i];
    /* Age is folded in once per order, not once per cell: it is constant
       across the order's own kernel, so it scales the splat rather than
       joining the exponent inside the loop. */
    const weight = decay ? decayWeight(at - attacks.t[i], decay, span, floor) : 1;
    if (weight <= 0) continue;
    for (let dy = -SPLAT_R; dy <= SPLAT_R; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= dim) continue;
      for (let dx = -SPLAT_R; dx <= SPLAT_R; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= dim) continue;
        grid[y * dim + x] +=
          weight * Math.exp(-(dx * dx + dy * dy) / (2 * SPLAT_SIGMA * SPLAT_SIGMA));
      }
    }
    drawn++;
  }
  if (!drawn) return null;

  /* One reciprocal log per player, not one per cell: the composite below walks
     every tile on the map and this is a per-player constant. */
  const anchor = HEAT_REF / strength;
  const refs = heatRefs(attacks, anchor);
  const rgb = new Map<number, [number, number, number]>();
  const invLog = new Map<number, number>();
  for (const number of grids.keys()) {
    rgb.set(number, hexToRgb(colors.get(number) ?? "#8b949e"));
    invLog.set(number, 1 / Math.log1p(refs.get(number) ?? anchor));
  }

  const out = new Uint8ClampedArray(area * 4);
  for (let i = 0; i < area; i++) {
    let sum = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let clear = 1;
    for (const [number, grid] of grids) {
      if (!grid[i]) continue;
      const a = Math.min(1, heat(grid[i], invLog.get(number)!) * gain);
      const colour = rgb.get(number)!;
      sum += a;
      r += a * colour[0];
      g += a * colour[1];
      b += a * colour[2];
      clear *= 1 - a;
    }
    if (!sum) continue;
    const at4 = i * 4;
    out[at4] = r / sum;
    out[at4 + 1] = g / sum;
    out[at4 + 2] = b / sum;
    out[at4 + 3] = (1 - clear) * HEAT_ALPHA * 255;
  }
  return out;
}

/** Scratch for the military layer: one pixel per tile, sized to the map. */
let heatCanvas: HTMLCanvasElement | null = null;

/**
 * Project the tile-space heat image onto the diamond for one view.
 *
 * The projection is affine -- `projectTile` is linear in x and y, and the view
 * is a uniform scale and a translation on top of it -- so the whole of it fits
 * in a canvas transform and the tile grid can be handed to `drawImage` as one
 * `dim`x`dim` image. There are no seams to leave, because there are no quads:
 * it is a single blit.
 *
 * That is what makes the layer read at zoom. The old destination-pixel walk
 * took the nearest tile, which is right at zoom 1 -- three screen pixels to a
 * tile -- and turns the front line into a mosaic of flat blocks at 8x, while
 * the buildings beside it scale smoothly. `drawImage` interpolates, so a
 * kernel that was always continuous in tile space arrives on screen
 * continuous. It interpolates in *premultiplied* alpha, which is the part that
 * has to be right: a cell next to an empty one must fade out, not darken
 * towards the black those empty cells carry in their unused colour bytes.
 *
 * None of the physics moves. The splat, the log compression against each
 * player's reference and the screen combination all still happen once per playhead
 * move, in `heatTiles`, on a few thousand cells; the kernel stays in tile
 * space, where it has none of the y-squash a screen-space circle would pick up
 * from the 2:1 projection. A pan is now a `putImageData` of 14k pixels and one
 * transformed blit -- less than it was at 1024 wide, let alone at 2048.
 */
function drawHeat(
  ctx: CanvasRenderingContext2D, tiles: Uint8ClampedArray<ArrayBuffer>, dim: number,
  at: (x: number, y: number) => readonly [number, number],
): void {
  if (!heatCanvas) heatCanvas = document.createElement("canvas");
  if (heatCanvas.width !== dim || heatCanvas.height !== dim) {
    heatCanvas.width = dim;
    heatCanvas.height = dim;
  }
  const scratch = heatCanvas.getContext("2d")!;
  scratch.putImageData(new ImageData(tiles, dim, dim), 0, 0);

  /* Read the matrix off `projectTile` rather than writing its algebra out
     again: three calls give the origin and the screen step for one tile of x
     and one of y, which is the whole of an affine map, and the layer cannot
     then be left behind by a change to the projection -- the quarter turn was
     one, and the square mode below is another. Image pixel (x, y) is tile
     (x, y) and its centre, which is what the filter samples at, is the middle
     of the tile. */
  const origin = at(0, 0);
  const alongX = at(1, 0);
  const alongY = at(0, 1);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(
    alongX[0] - origin[0], alongX[1] - origin[1],
    alongY[0] - origin[0], alongY[1] - origin[1],
    origin[0], origin[1],
  );
  ctx.drawImage(heatCanvas, 0, 0);
  ctx.restore();
}

/**
 * How much of the map is on screen.
 *
 * `zoom` 1 is the whole diamond; `u`/`v` are the point at the centre of the
 * plot, in the same 0..1 diamond space `projectTile` hands back. Panning moves
 * the centre, so no part of the drawing needs to know about scroll offsets.
 */
/**
 * How wide the panel is allowed to get. See the `--map-max` pair in the CSS.
 *
 * One axis, not two. `square` is the other control on the panel's own row and
 * it is a different question -- which plot the map is *drawn into*, inside a
 * canvas whose box never changes. This is how far that canvas is stretched
 * across the page, and "wide" is the end of it with no cap at all: the two
 * compose, so a square map can be page-wide and a diamond can be compact.
 */
export type Size = "compact" | "large" | "wide";

export interface View {
  zoom: number;
  u: number;
  v: number;
}

/** The row's class per size; see `.row` in the stylesheet. */
const ROW: Record<Size, string> = {
  compact: styles.rowCompact, large: styles.rowLarge, wide: styles.rowWide,
};

const HOME: View = { zoom: 1, u: 0.5, v: 0.5 };
const MAX_ZOOM = 8;

/** A number input's `min`/`max` are advice; the maths behind them is not. */
const clamp = (n: number, lo: number, hi: number) =>
  (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

/** So the viewport cannot be dragged off the edge of the diamond. */
function clampView(view: View): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
  const room = 0.5 - 0.5 / zoom;
  const clamp = (n: number) => Math.min(0.5 + room, Math.max(0.5 - room, n));
  return { zoom, u: clamp(view.u), v: clamp(view.v) };
}

/** The ground layer, plus everything about it that does not change with view. */
interface Base {
  canvas: HTMLCanvasElement;
  /** Tile indices per resource code, so the mark layer does not re-scan. */
  resources: { code: number; tiles: number[] }[];
  /**
   * The finished colour of every tile, packed the way an ImageData word is.
   *
   * Terrain, elevation and the forest overlay never change for the length of a
   * match, so neither does this, and the raster walk becomes a gather: no
   * palette lookup, no slope comparison, no branch on forest, per pixel. It is
   * what pays for the supersampled backing store.
   */
  tiles: Uint32Array;
  /** The view the pixels currently in `canvas` were rasterised for. */
  key: string;
}

const viewKey = (view: View) =>
  `${view.zoom.toFixed(4)}|${view.u.toFixed(5)}|${view.v.toFixed(5)}`;

/**
 * Colour every tile, and collect the resource tiles on the way past.
 *
 * Slope shading is the game's: a tile is drawn in its terrain's `up` colour
 * when it stands higher than the tile behind it and `down` when it stands
 * lower, where "behind" is one step further from the viewer -- the quarter
 * turn puts the screen's vertical axis on `y - x`, so up-screen is
 * `(x+1, y-1)`. The far edges have nothing behind them and stay level.
 *
 * All of it is per *tile*, and it used to be evaluated per pixel: fourteen
 * thousand comparisons dressed up as half a million, redone on every pan. Once
 * here, into `Base.tiles`, and the raster walk has nothing left to decide.
 */
function decode(data: MinimapData): Base {
  const { dim } = data;
  const area = dim * dim;
  const terrain = decodeLayer(data.terrain, area);
  const elevation = decodeLayer(data.elevation, area);
  const overlay = decodeLayer(data.overlay, area);

  const resources = RESOURCE_CODES.map((code) => ({ code: code as number, tiles: [] as number[] }));
  const byCode = new Map(resources.map((r) => [r.code, r.tiles]));
  for (let i = 0; i < area; i++) {
    byCode.get(overlay[i])?.push(i);
  }

  const palette = new Map<number, [number, number, number][]>();
  for (const [id, colors] of Object.entries(data.colors)) {
    palette.set(Number(id), [
      mute(hexToRgb(colors.up)), mute(hexToRgb(colors.level)), mute(hexToRgb(colors.down)),
    ]);
  }

  const forest = hexToRgb(OVERLAY_COLOR[OVERLAY.forest]);
  const fallback: [number, number, number][] = [[110, 110, 110], [95, 95, 95], [80, 80, 80]];
  const tiles = new Uint32Array(area);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const i = y * dim + x;
      let rgb: [number, number, number];
      if (overlay[i] === OVERLAY.forest) {
        rgb = forest;
      } else {
        const bx = x + 1;
        const by = y - 1;
        const behind = bx < dim && by >= 0 ? elevation[by * dim + bx] : elevation[i];
        const slope = elevation[i] > behind ? 0 : elevation[i] < behind ? 2 : 1;
        rgb = (palette.get(terrain[i]) ?? fallback)[slope];
      }
      /* ABGR, which is what RGBA bytes are on a little-endian machine -- every
         machine this runs on. One word written per pixel instead of four. */
      tiles[i] = 0xff000000 | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0];
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = RASTER_W;
  canvas.height = RASTER_H;
  return { canvas, resources, tiles, key: "" };
}

/**
 * The area the map is drawn into, inside the canvas.
 *
 * The canvas itself is always `PLOT` -- the full width and the 2:1 box the
 * panel has always had. Nothing about the layout changes with the shape: the
 * tools are positioned against that box, the panel keeps its height, and
 * toggling the shape moves nothing under the map. What changes is the area
 * *within* it that the projection is scaled to.
 *
 * The quarter turn is not what the square mode changes either -- the rotation
 * is the whole reason the map is readable at a glance, and it stays. What it
 * changes is the *squash*: the game's minimap is 2:1, a diamond half as tall
 * as it is wide, and scaled to a 1:1 area the same projection comes out as a
 * true square standing on its corner. Nothing in `projectTile` moves; both
 * axes come back in 0..1 and this is what that is worth in pixels.
 *
 * The square's side is the box's *height*, so the map is as big as the space
 * allows without the panel growing, and the leftover width sits either side
 * of it -- which is where the tools already are. A square scaled to the box's
 * width instead would be as tall as the panel is wide, and at zoom 1, the one
 * zoom whose whole job is to hold the map at once, the bottom of it would be
 * below the fold.
 */
const PLOT = { w: RASTER_W, h: RASTER_H };
interface Area { w: number; h: number; x: number }
const plotArea = (square: boolean): Area => (square
  ? { w: PLOT.h, h: PLOT.h, x: (PLOT.w - PLOT.h) / 2 }
  : { w: PLOT.w, h: PLOT.h, x: 0 });

/**
 * Scratch for the raster, shared rather than one per recording.
 *
 * 2048x1024 is 8 MB of ImageData, `rasterize` is synchronous, and a WeakMap of
 * open recordings holding one each adds up.
 */
let raster: ImageData | null = null;

/**
 * Paint the ground for one view, if it is not already painted for it.
 *
 * Zoom re-rasterises rather than scaling the zoom-1 bitmap up. It costs the
 * same two-million-pixel loop every time the view changes -- ~5 ms, which a
 * pan can afford -- and it is the difference between reading tiles at 8x and
 * reading a blur: at zoom 1 a 168-map gives about six pixels per tile, so
 * there is nothing in the bitmap to magnify.
 *
 * Nearest tile, deliberately, where the military layer above it interpolates:
 * a tile is the unit the ground is *known* in, and a filtered terrain at 8x is
 * a guess at a boundary the data does not have. The supersampled store is what
 * takes the jaggedness off those edges without softening what is inside them.
 */
function rasterize(base: Base, dim: number, view: View, area: Area): void {
  const key = `${viewKey(view)}|${area.w}`;
  if (base.key === key) return;

  const ctx = base.canvas.getContext("2d")!;
  if (!raster) raster = ctx.createImageData(PLOT.w, PLOT.h);
  const px = new Uint32Array(raster.data.buffer);
  px.fill(0);  // outside the diamond, and beside it: transparent

  /* Both tile axes advance by the same amount per pixel across a row --
     `unprojectPoint` adds `u * dim` to each of x and y -- so the row is walked
     with two additions instead of an unprojection per pixel. Over 2048 steps
     of ~0.06 the drift is around 1e-13 of a tile. */
  /* Through the *area*, not the canvas: in square mode the map is a square of
     the canvas's height sitting in the middle of it, so a pixel's place is
     measured from `area.x` and against `area.w`. The columns either side fall
     outside the map by the same arithmetic that the diamond's corners do, and
     are skipped by the same bounds check. */
  const step = dim / (area.w * view.zoom);
  const u0 = ((0.5 - area.x) / area.w - 0.5) / view.zoom + view.u;
  for (let py = 0; py < PLOT.h; py++) {
    /* Pixel centres, so the diamond's edges land where they should, mapped
       back out through the view: screen 0.5 is the view's centre. */
    const v = ((py + 0.5) / area.h - 0.5) / view.zoom + view.v;
    const start = unprojectPoint(dim, u0, v);
    let fx = start.x;
    let fy = start.y;
    const row = py * PLOT.w;
    for (let pxi = 0; pxi < PLOT.w; pxi++, fx += step, fy += step) {
      if (fx < 0 || fy < 0) continue;
      const x = fx | 0;
      const y = fy | 0;
      if (x >= dim || y >= dim) continue;
      px[row + pxi] = base.tiles[y * dim + x];
    }
  }
  ctx.putImageData(raster, 0, 0);
  base.key = key;
}

/** Kept per minimap, so a tab you come back to keeps its decoded layers. */
const bases = new WeakMap<MinimapData, Base>();

function baseLayer(data: MinimapData): Base {
  let base = bases.get(data);
  if (!base) {
    base = decode(data);
    bases.set(data, base);
  }
  return base;
}

interface Props {
  payload: Payload;
  /**
   * The playhead, in seconds. Buildings ordered after it are not drawn, so the
   * map fills in as the scrubber moves. Defaults to the end of the match,
   * which is what a caller with no playhead wants.
   */
  t?: number;
  /**
   * Drawn last, over everything. Nothing passes any yet: it is the seam for an
   * overlay this component should not have to know about.
   */
  marks?: MapMark[];
  /**
   * Start of the action window, in seconds. 0 -- the default -- means
   * cumulative: every attack up to the playhead. Both `window` and `decay`
   * set it; what differs is whether an order's age counts for anything once
   * it is inside.
   *
   * Only the military layer reads it. Buildings are cumulative whatever this
   * says: a building that went up twenty minutes ago is still standing, so
   * windowing them would erase the base and leave the fighting floating over
   * empty ground.
   */
  from?: number;
  /** Cumulative or a trailing window -- this panel's control, applied above. */
  mode?: Mode;
  onMode?: (mode: Mode) => void;
  /** How far back the window reaches, in seconds. */
  w?: number;
  onW?: (w: number) => void;
}

export function Minimap({
  payload, t, marks, from = 0, mode = "decay", onMode, w = DECAY_SECS, onW,
}: Props) {
  const data = payload.minimap;
  const canvas = useRef<HTMLCanvasElement>(null);
  const at = t ?? payload.duration;
  const [view, setView] = useState<View>(HOME);
  const [military, setMilitary] = useState(true);
  /* The two numbers behind the military layer, as controls rather than as
     constants: how sharply an order fades across the window, and how much
     brightness a given volume of orders is worth. Both are about how this
     match wants to be read -- a raid and a siege want different fades, an AI
     game and a 1v1 different strengths -- which is exactly the sort of thing
     that cannot be settled once in a module constant. Local, like `military`
     itself: they are how the panel is being looked at. */
  const [decaySpan, setDecaySpan] = useState(DECAY_SPAN);
  const [heatStrength, setHeatStrength] = useState(1);
  /* Which plot the map is drawn into. The 2:1 diamond is the game's own and
     the default; the square keeps the same quarter turn and drops the squash,
     so distance means the same thing in both screen directions and the map is
     a true square standing on its corner. Local, like `military` and the size
     cap: it is how this panel is being looked at, not part of what the
     recording says. */
  const [square, setSquare] = useState(false);
  /* How much of the page the map is allowed to take. "large" is the panel this
     has always been; "compact" halves the cap, which is enough map to read a
     base off and leaves the player cards on the fold. The canvas is a fixed
     backing store scaled by CSS, so this is a width cap and nothing else --
     no rebuild, no re-raster, no measurement. */
  const [size, setSize] = useState<Size>("large");
  /* The terrain key, folded independently of the panel. Local and per
     component, like `open` and `square` above it: which half of the key you
     have up is about the question you are asking right now, not something
     about the recording worth carrying between tabs. */
  const [showKey, setKey] = useState(true);
  /* Open by default -- it is the first thing worth looking at. Collapsed, the
     canvas is unmounted and every memo below short-circuits, so a folded map
     costs a heading and nothing else: no splat, no raster, no half-million
     pixel walk on a playhead move. */
  const [open, setOpen] = useState(true);

  /* A new recording in this tab is a new map; keep the old one's zoom and you
     are looking at the wrong corner of it. */
  useEffect(() => { setView(HOME); }, [data]);

  /* Zoom about the pointer, so the thing under the cursor stays under it --
     the only zoom that lets you aim at a base and arrive there.

     Non-passive, and therefore not an `onWheel` prop: React attaches wheel
     listeners passively at the root, where `preventDefault` is a no-op and the
     page scrolls out from under the map instead of zooming. */
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = target.getBoundingClientRect();
      /* Pointer in 0..1 of the *drawn area*, then in diamond space under the
         old view. Of the area rather than of the element, because in square
         mode the map is the middle square of a wider canvas: measured against
         the element, a cursor over the map's centre reads as off to one side
         and the zoom walks away from what it was aimed at. */
      const at = plotArea(square);
      const px = ((event.clientX - box.left) / box.width) * PLOT.w;
      const py = ((event.clientY - box.top) / box.height) * PLOT.h;
      const su = (px - at.x) / at.w - 0.5;
      const sv = py / at.h - 0.5;
      setView((old) => {
        const zoom = Math.min(MAX_ZOOM, Math.max(1, old.zoom * Math.exp(-event.deltaY / 400)));
        /* Hold the point under the cursor still: it sits at the same screen
           offset before and after, so the centre absorbs the difference. */
        return clampView({
          zoom,
          u: old.u + su / old.zoom - su / zoom,
          v: old.v + sv / old.zoom - sv / zoom,
        });
      });
    };
    target.addEventListener("wheel", onWheel, { passive: false });
    return () => target.removeEventListener("wheel", onWheel);
    /* `open` matters: collapsing unmounts the canvas, so the listener has to be
       attached again to the new one when it comes back. `square` matters
       because the handler measures against the area, which it changes. */
  }, [open, square]);

  /* Drag to pan. Pointer capture rather than window listeners: a drag that
     ends outside the canvas still ends, and there is nothing to clean up. */
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (view.zoom <= 1 || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const held = drag.current;
    if (!held || held.id !== event.pointerId) return;
    const box = event.currentTarget.getBoundingClientRect();
    /* Against the area for the same reason: a drag has to move the ground by
       exactly what is under the pointer, and in square mode the element is
       wider than the map drawn in it. */
    const at = plotArea(square);
    const dx = ((event.clientX - held.x) / box.width) * (PLOT.w / at.w);
    const dy = ((event.clientY - held.y) / box.height) * (PLOT.h / at.h);
    held.x = event.clientX;
    held.y = event.clientY;
    setView((old) => clampView({ ...old, u: old.u - dx / old.zoom, v: old.v - dy / old.zoom }));
  };
  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };

  /* By player number, so a building knows its colour without the draw walking
     the player list once per mark. */
  const colors = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of payload.players) map.set(p.number, playerColor(p));
    return map;
  }, [payload.players]);

  /* Provisional: build *orders* up to the playhead, plus what each player
     started with. See `buildingsAt` for what that is not. */
  const buildings = useMemo(
    () => (data && open ? buildingsAt(data, at) : []),
    [data, open, at],
  );

  /* Recomputed when the playhead moves, not when the view does -- the splat
     and the per-player composite are in tile space precisely so a pan does not
     pay for them. */
  const heatmap = useMemo(
    () => (data && military && open
      ? heatTiles(data, from, at, colors, mode === "decay" ? w : 0, decaySpan, heatStrength)
      : null),
    [data, military, open, from, at, colors, mode, w, decaySpan, heatStrength],
  );

  useEffect(() => {
    const target = canvas.current;
    if (!target || !data || !open) return;
    const ctx = target.getContext("2d");
    if (!ctx) return;

    const { dim } = data;
    const base = baseLayer(data);
    const area = plotArea(square);
    ctx.clearRect(0, 0, PLOT.w, PLOT.h);

    /* One step of the tile grid, in pixels, along each screen axis.
       Everything on top is sized in these, so the marks stay in proportion on
       a 480 map -- and grow with the zoom, so zooming in makes buildings
       bigger rather than just further apart.

       Two numbers, because the step is diagonal and the plot decides how
       diagonal it comes out: `tileY` is half of `tile` in the squashed 2:1
       diamond and equal to it in the square. Every shape below is written in
       terms of both rather than assuming the squash -- that assumption, left
       in one place, is a mark drawn square on a rotated map. */
    const tile = (area.w / (2 * dim)) * view.zoom;
    const tileY = (area.h / (2 * dim)) * view.zoom;
    /* World coordinates through the view: a building's anchor is already an
       exact point, and a half-integer one for anything with an odd footprint.
       Screen centre is the view's centre, which is what makes panning a change
       of two numbers and nothing else. */
    const point = (x: number, y: number) => {
      const { u, v } = projectTile(dim, x, y);
      return [
        ((u - view.u) * view.zoom + 0.5) * area.w + area.x,
        ((v - view.v) * view.zoom + 0.5) * area.h,
      ] as const;
    };

    /* The ground, walked by destination pixel into whichever plot it is going
       to. One path for both shapes: the walk asks `unprojectPoint` which tile
       a pixel is over, and neither the question nor the answer changes when
       the plot stops being 2:1. */
    rasterize(base, dim, view, area);
    ctx.drawImage(base.canvas, 0, 0);
    /* A tile index, drawn at the middle of its tile -- which is half a tile
       along both axes from the corner the index names. */
    const tilePoint = (index: number) =>
      point((index % dim) + 0.5, Math.floor(index / dim) + 0.5);
    /* A w-by-h footprint, centred on a point, in whichever shape a tile is.
       In the diamond a tile is a diamond and an axis-aligned rectangle of the
       same footprint spills into its neighbours -- a row of them comes out as
       a smear -- so the shape is the parallelogram the two tile steps span:
       one tile of x goes right by `tile` and *up* by `tileY`, one tile of y
       goes right and down by the same. It is only a diamond when w equals h,
       which is the common case and worth the branch. The square plot changes
       what `tileY` is worth and nothing else here: the rotation is the same,
       so the shapes are the same shapes unsquashed.

       Halves throughout: the anchor is the building's centre, not its corner,
       which is exactly why an even footprint lands on the corner between four
       tiles and an odd one lands in the middle of one. */
    const cell = (cx: number, cy: number, w: number, h: number) => {
      const [a, b] = [w / 2, h / 2];
      if (w === h) {
        ctx.moveTo(cx, cy - w * tileY);
        ctx.lineTo(cx + w * tile, cy);
        ctx.lineTo(cx, cy + w * tileY);
        ctx.lineTo(cx - w * tile, cy);
        ctx.closePath();
        return;
      }
      const sx = (x: number, y: number) => cx + (x + y) * tile;
      const sy = (x: number, y: number) => cy + (y - x) * tileY;
      ctx.moveTo(sx(-a, -b), sy(-a, -b));
      ctx.lineTo(sx(a, -b), sy(a, -b));
      ctx.lineTo(sx(a, b), sy(a, b));
      ctx.lineTo(sx(-a, b), sy(-a, b));
      ctx.closePath();
    };
    /* A share of the same footprint's two diagonals, centred on it -- corner
       towards opposite corner in tile space, which is the one shape that
       cannot be mistaken for the box it is in whatever the plot does to the
       box. The projection turns them upright: the square's corners are the
       diamond's vertices, so corner-to-corner comes out as one vertical line
       and one horizontal one, which is also the pair of angles a canvas draws
       without a fringe of antialiasing at the two-pixel widths this is drawn
       at. Scaling both half-extents by the same number keeps the centre where
       it was and pulls both tips of each arm in equally, so the cross stays
       centred on the building rather than sliding towards one corner.

       Written in the general form rather than `cell`'s square shortcut,
       because a Krepost is 3x3 where a Castle is 4x4 and both want a cross. */
    const cross = (cx: number, cy: number, w: number, h: number) => {
      const [a, b] = [(w / 2) * CROSS_SPAN, (h / 2) * CROSS_SPAN];
      const sx = (x: number, y: number) => cx + (x + y) * tile;
      const sy = (x: number, y: number) => cy + (y - x) * tileY;
      ctx.moveTo(sx(-a, -b), sy(-a, -b));
      ctx.lineTo(sx(a, b), sy(a, b));
      ctx.moveTo(sx(a, -b), sy(a, -b));
      ctx.lineTo(sx(-a, b), sy(-a, b));
    };
    /* A floor in tiles, so a mark on a 480 map is still a mark. */
    const atLeast = (tiles: number, px: number) => Math.max(tiles, px / tile);

    /* Under the resources and the buildings: a Castle must not be hidden by
       the fighting around it, and the point of the layer is where the fighting
       was relative to what was there. */
    if (heatmap) drawHeat(ctx, heatmap, dim, point);

    /* Resources, in tile shape like the buildings and a little over a tile
       across, so a clump of them closes up into one blob rather than reading
       as speckle. Round marks left gaps at the corners of a gold pile that
       the same footprint square fills. One path per kind, filled once. */
    for (const group of base.resources) {
      if (!group.tiles.length) continue;
      const r = atLeast(1.25, 2 * PX);
      ctx.beginPath();
      for (const index of group.tiles) {
        const [cx, cy] = tilePoint(index);
        cell(cx, cy, r, r);
      }
      ctx.fillStyle = OVERLAY_COLOR[group.code];
      ctx.fill();
    }

    /* Buildings, in the owner's colour and at their real size: what they
       started with, and everything they had ordered by the playhead. On a
       walled map the starting outline is most of what makes a base
       recognisable -- and at one tile each, the ring closes up into a line
       instead of a row of overlapping blobs.

       Drawn in build order, one path per run of buildings that share an owner
       and a family -- not one pass per family, which is what this was.

       Order first. Where two footprints overlap, something has to be on top,
       and the only answer that means anything is the later building: a
       recording is orders issued and never says a building stopped standing,
       so an anchor that was a Barracks at 8:00 and a Castle at 40:00 is both
       of those on this map and the Castle is the part that was true last.
       Drawn by family instead, the answer was whatever the pass order happened
       to be -- every Castle over every Barracks regardless of age, and, since
       the players were walked in the order a Map handed them over, one player
       winning every overlap with the other for the whole match.

       Runs, because the fill is per owner and the alpha is per family, so a
       path can hold as many buildings as agree on both -- which in practice is
       most of them, since builds arrive in bursts from one player. 349
       buildings in the recording here come out as a few dozen paths rather
       than one, which is nothing next to the two-million-pixel raster under
       them.

       Farms are the one thing runs cost anything: they are drawn at
       `FARM_ALPHA`, and two of them in *different* runs blend where they meet
       rather than being one flat fill. Buildings do not overlap, so what
       compounds is the antialiased seam between neighbours and not their
       area -- a hairline slightly darker than the field, against getting the
       overlaps right.

       What each family is drawn like, and why, is unchanged:

       Farms are the most numerous thing a player builds and the least worth
       looking at -- eighty of them at full strength is a wall of colour with
       the base buried in it. Held back, they still say "this ground is
       theirs" and stop competing with what is standing on it.

       Castles and Town Centres get a border for the opposite reason: they are
       what you look for first, and at 4x4 in a field of 3x3 farms of the same
       colour they were only a slightly larger patch of it. The outline is the
       one the starting-position rings already use, so the map has one way of
       saying "this matters", not two.

       A Castle then gets a cross inside that border, because the border alone
       only separates the two of them from everything else and they are not the
       same news: a Town Centre where a base already is says the boom is on,
       and a Castle says the ground under it is being held. Told apart by size
       they are not told apart at all -- a Krepost is 3x3, the size of the
       Barracks beside it, and a 4x4 Castle is a Town Centre's footprint
       exactly. Shape is the one channel left: colour is the owner and the
       border is already spent. */
    const drawRun = (run: typeof buildings) => {
      const { player, kind } = run[0];
      ctx.beginPath();
      for (const building of run) {
        const [cx, cy] = point(building.x, building.y);
        cell(cx, cy, building.w, building.h);
      }
      ctx.fillStyle = colors.get(player) ?? "#8b949e";
      ctx.globalAlpha = kind === KIND.farm ? FARM_ALPHA : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (kind !== KIND.keep && kind !== KIND.castle) return;
      /* Inside the shape, not straddling it: a stroke centred on the path
         would eat a quarter-tile of the neighbours a Castle is wedged
         between, which on a walled base is another building. */
      ctx.save();
      ctx.clip();
      ctx.lineWidth = Math.max(2 * PX, tile * 0.5);
      ctx.strokeStyle = KEEP_EDGE;
      ctx.stroke();
      /* Still under the border's clip -- the path is replaced, the region is
         not. `CROSS_SPAN` is what keeps the arms off the corners; the clip is
         what keeps them off the *neighbours* if that number is ever raised,
         and it costs nothing to leave in place.

         Thinner than the border, which is the other half of keeping them two
         marks: at the same weight the cross reads as more border rather than
         as something inside it. */
      if (kind === KIND.castle) {
        ctx.beginPath();
        for (const building of run) {
          const [cx, cy] = point(building.x, building.y);
          cross(cx, cy, building.w, building.h);
        }
        ctx.lineWidth = Math.max(1.5 * PX, tile * 0.32);
        ctx.stroke();
      }
      ctx.restore();
    };
    /* `buildingsAt` hands these back in build order, so a run is simply as far
       as the next disagreement about owner or family. */
    let run: typeof buildings = [];
    for (const building of buildings) {
      if (run.length && (run[0].player !== building.player || run[0].kind !== building.kind)) {
        drawRun(run);
        run = [];
      }
      run.push(building);
    }
    if (run.length) drawRun(run);

    /* Then the town centres, big enough to find at a glance and ringed so a
       dark colour still reads against forest. */
    for (const start of data.starts) {
      const [cx, cy] = point(start.x, start.y);
      const r = Math.max(5 * PX, tile * 2.4);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = colors.get(start.player) ?? "#8b949e";
      ctx.fill();
      ctx.lineWidth = Math.max(2 * PX, r * 0.32);
      ctx.strokeStyle = KEEP_EDGE;
      ctx.stroke();
    }

    for (const mark of marks ?? []) {
      const [cx, cy] = point(mark.x, mark.y);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1.5 * PX, (mark.r ?? 1) * tile), 0, Math.PI * 2);
      ctx.fillStyle = mark.color;
      ctx.fill();
    }
  }, [data, colors, buildings, marks, view, heatmap, open, square]);

  /* An events.json, or a recording parsed before this existed. There is
     nothing useful to say about a map we do not have, so the panel is simply
     not there. */
  if (!data) return null;

  /* The order feed's two columns, one per margin. Teams alternate sides, so
     a 1v1 or a 2v2 has each side's players beside each other and facing the
     other's -- the shape the game itself has. An FFA alternates players. */
  const sides = useMemo(() => {
    const left: Player[] = [];
    const right: Player[] = [];
    byTeam(payload.players).forEach((team, i) => (i % 2 ? right : left).push(...team));
    return { left, right };
  }, [payload.players]);
  /* Fewer rows each when a margin holds several players, or the column runs
     past the bottom of the map it is beside. */
  const feedRows = Math.max(sides.left.length, sides.right.length) > 2 ? 4 : 8;

  return (
    /* The panel and its margins. A grid rather than the panel's own auto
       margins, so the space either side of the capped panel is a column
       something can be put in -- the order feed -- and so that when there is
       no such space, at wide or in a narrow window, the same two columns go
       under the map instead. The cap moves up here with it: the middle track
       is what holds the panel to `--map-max`, and the panel's own max-width
       now only repeats what the track already says. */
    <div className={styles.box}>
      <div className={`${styles.row} ${ROW[size]}${open ? "" : ` ${styles.folded}`}`}>
        {open ? (
          <OrderFeed payload={payload} players={sides.left} t={at} rows={feedRows} side="left" />
        ) : null}
        <section
          /* One class per size past the default. `large` is the default and adds
             nothing: it is the cap the panel already carries. */
          className={
            size === "large" ? styles.minimap : `${styles.minimap} ${styles[size]}`
          }
        >
          <div className={styles.label}>
            <button
              type="button"
              className={styles.title}
              onClick={() => setOpen((was) => !was)}
              aria-expanded={open}
            >
              <span className={open ? styles.caretOpen : styles.caret} aria-hidden="true">▸</span>
              Map
            </button>
            {/* Beside the heading rather than in the stack over the plot: it sizes
                the panel, so it is not one of the map's own controls -- and at
                compact width the stack is already the busiest corner of the map.
                Hidden while folded, where there is no plot to size. */}
            {open ? (
              <div className={styles.sizes} role="group" aria-label="Map size">
                <button
                  type="button"
                  aria-pressed={size === "compact"}
                  onClick={() => setSize("compact")}
                >
                  Compact
                </button>
                <button
                  type="button"
                  aria-pressed={size === "large"}
                  onClick={() => setSize("large")}
                >
                  Large
                </button>
                {/* No cap at all -- the map takes the page. Its own button rather
                    than a bigger `large`, because the cap exists for a reason
                    (past it the 2048 backing store is being stretched rather than
                    sampled down, and a 2:1 map the width of the window is tall
                    enough to push the cards off the fold) and this is the choice
                    to spend both of those. */}
                <button
                  type="button"
                  aria-pressed={size === "wide"}
                  onClick={() => setSize("wide")}
                  title="Full width — the map is stretched past the backing store's own resolution"
                >
                  Wide
                </button>
              </div>
            ) : null}
            {/* Beside the size for the same reason: both are about the panel the
                map is in rather than about the match. One button, not a pair --
                the diamond is the default and this is the departure from it. */}
            {open ? (
              <button
                type="button"
                className={styles.shape}
                onClick={() => setSquare((was) => !was)}
                aria-pressed={square}
                title="Draw the map unsquashed, in a square plot"
              >
                Square
              </button>
            ) : null}
          </div>
          {open ? (
          <div className={styles.plot}>
            <div className={styles.stage}>
            <canvas
              ref={canvas}
              width={PLOT.w}
              height={PLOT.h}
              className={view.zoom > 1 ? `${styles.canvas} ${styles.grab}` : styles.canvas}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={() => setView(HOME)}
              role="img"
              aria-label={
                `${payload.map}, ${data.dim} by ${data.dim} tiles: resources, and the `
                + "buildings each player had ordered by the playhead, in their colour"
              }
            />
            {/* One corner, and it wraps. Everything over the plot is a control now
                that the building count is gone, so splitting them across the two
                top corners was separating things that are read together -- and the
                readouts that used to hold the left corner are two chips, which is
                not a column. The wrap is what keeps a single cluster out of the
                map: chips flow right to left and down, widest rows first, which is
                the shape of the room a top corner has -- see `tools` in the
                stylesheet. Ordered so the layer's own controls come before what
                the map is and where you are in it. */}
            <div className={styles.tools}>
            {data.attacks?.t.length ? (
              <button
                type="button"
                className={military ? `${styles.toggle} ${styles.on}` : styles.toggle}
                onClick={() => setMilitary((was) => !was)}
                aria-pressed={military}
              >
                Military
              </button>
            ) : null}
            {onMode ? (
              /* Narrowest reach first, widest last: decay, then the flat window
                 behind it, then the whole game. The order is the amount of the
                 match each one is claiming to describe, and the default sits at
                 the end you start reading from. */
              <div className={styles.modes}>
                <button
                  type="button"
                  aria-pressed={mode === "decay"}
                  onClick={() => onMode("decay")}
                >
                  Decay
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "window"}
                  onClick={() => onMode("window")}
                >
                  Window
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "cumulative"}
                  onClick={() => onMode("cumulative")}
                >
                  All
                </button>
              </div>
            ) : null}
            {/* ---- the three numbers ----
                Every one of these is showing in every mode, and two of them are
                usually inert. That is deliberate, and it is the whole of the fix
                for a cluster that used to move under the cursor.

                The chips wrap, so removing one does not just leave a gap where it
                was: the ones after it slide up into its place and the rows
                re-pack, which took the mode buttons themselves with them. Switch
                from Decay to All and the pair of numbers vanished, the cluster
                shortened by a row, and the button you had just pressed was
                somewhere else -- with the pointer now over whatever had moved into
                the space. A control that jumps out from under the click that
                worked it is worse than one that is visibly not applicable.

                So the geometry is fixed: same chips, same order, same rows, in all
                three modes. A number the mode does not read is dimmed and its
                field disabled, which also answers the question the disappearance
                never did -- that the control exists and this mode has no use for
                it. See `.muted` in the stylesheet. */}
            {/* Both windowed modes read this one -- it is how far back they reach,
                and in decay's case also how long the fade takes. Cumulative counts
                the whole match, so there is no window for it to size. */}
            {onW ? (
              <label
                className={mode === "cumulative" ? `${styles.secs} ${styles.muted}` : styles.secs}
                title={
                  mode === "cumulative"
                    ? "How far back the fighting layer reaches. All counts the whole match, "
                      + "so this applies in Decay and Window only"
                    : "How far back the fighting layer reaches"
                }
              >
                last{" "}
                <input
                  type="number"
                  value={w}
                  min={5}
                  max={600}
                  step={5}
                  disabled={mode === "cumulative"}
                  onChange={(event) => onW(Number(event.target.value))}
                />{" "}
                sec
              </label>
            ) : null}
            {/* Decay's alone: in the other two an order's age buys it nothing, so
                a fade sharpness is a control over nothing. */}
            <label
              className={mode === "decay" ? styles.secs : `${styles.secs} ${styles.muted}`}
              title={
                "How sharply fighting fades across the window: higher leaves only "
                + "the last few seconds bright, lower keeps a longer trail behind it"
                + (mode === "decay" ? "" : ". Decay mode only -- the other two weigh every order alike")
              }
            >
              decay{" "}
              <input
                type="number"
                value={decaySpan}
                min={0.4}
                max={6}
                step={0.2}
                disabled={mode !== "decay"}
                /* Clamped where the field is read rather than left to the
                   attributes, which browsers treat as advice: the weight is
                   rescaled by `1 - e^-span`, so a cleared field arriving as 0
                   would divide by zero and paint the layer NaN. */
                onChange={(event) => setDecaySpan(clamp(Number(event.target.value), 0.4, 6))}
              />
            </label>
            {/* Only if there is a layer to draw at all -- that is a fact about the
                recording and does not change while you are looking at it. Whether
                the layer is *on* does change, and turning it off dims this rather
                than removing it, for the same reason the two above stay: the chip
                is directly under the toggle that governs it, and a cluster that
                re-packs on every press moves the toggle out from under the
                pointer. */}
            {data.attacks?.t.length ? (
              <label
                className={military ? styles.secs : `${styles.secs} ${styles.muted}`}
                title={
                  "How much brightness a given volume of attack orders is worth: "
                  + "higher makes the fighting layer stronger over the same orders"
                  + (military ? "" : ". The military layer is off")
                }
              >
                military{" "}
                <input
                  type="number"
                  value={heatStrength}
                  min={0.25}
                  max={4}
                  step={0.25}
                  disabled={!military}
                  onChange={(event) => setHeatStrength(clamp(Number(event.target.value), 0.25, 4))}
                />
                ×
              </label>
            ) : null}
            {/* What the map is, after what is drawn on it: the size is a fact you
                check once and the zoom is where you already know you are. */}
            <span className={styles.sub}>{data.dim} × {data.dim}</span>
            {view.zoom > 1 ? (
              <button type="button" className={styles.reset} onClick={() => setView(HOME)}>
                {view.zoom.toFixed(1)}× · reset
              </button>
            ) : (
              <span className={styles.hint}>scroll to zoom</span>
            )}
            </div>
            {/* Two lists, not one: what the terrain colours mean, then who the
                player colours are. Flat and concatenated they read as one
                vocabulary, and a player called "Forest" or "Gold" disappeared
                into it. See the `legend` block in the stylesheet.

                Over the plot rather than under it, and in a column, for the same
                reason the tools are: the map is what you are looking at, and a
                key you have to look away from the map to read is a key you read
                twice. Down the left, because the tools hold the right -- and the
                players go above the terrain, since a name is what you look up
                while the vocabulary is what you learn once. */}
            <div className={styles.floats}>
              <ul
                className={`${styles.legend} ${styles.legendPlayers}`}
                aria-label="Player colours"
              >
                {payload.players.map((p) => (
                  <li key={p.number}>
                    <span className={styles.swatch} style={{ background: playerColor(p) }} />
                    {p.name || `Player ${p.number}`}
                  </li>
                ))}
              </ul>
              {/* Folded away rather than dropped: seven swatches are worth one
                  reading and then only worth the room they take. The same
                  disclosure the panel itself uses, so there is one kind of fold
                  on this map and not two. Collapsed it is still a chip that says
                  what it is, which is what makes it findable again. */}
              <div className={styles.legendBox}>
                <button
                  type="button"
                  className={styles.legendTitle}
                  onClick={() => setKey((was) => !was)}
                  aria-expanded={showKey}
                >
                  <span className={showKey ? styles.caretOpen : styles.caret} aria-hidden="true">▸</span>
                  Key
                </button>
                {showKey ? (
                  <ul className={styles.legend} aria-label="Terrain and resource colours">
                    {LEGEND.map((item) => (
                      <li key={item.code}>
                        <span
                          className={styles.swatch}
                          style={{ background: OVERLAY_COLOR[item.code] }}
                        />
                        {item.label}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
            </div>
          </div>
          ) : null}
        </section>
        {open ? (
          <OrderFeed payload={payload} players={sides.right} t={at} rows={feedRows} side="right" />
        ) : null}
      </div>
    </div>
  );
}
