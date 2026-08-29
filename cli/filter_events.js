#!/usr/bin/env node
/**
 * CLI for the event filter -- the Node half of src/parser/filter_events.ts,
 * kept out of the library so the renderer bundle never sees a `node:` import.
 *
 * Mirrors filter_events.py at the repository root, and is one half of the
 * Python parity harness: both must produce character-identical output.
 *
 *   node cli/filter_events.js <rec> [-o out] [--category build tech unit]
 *                             [--player N ...] [--csv] [--json]
 *                             [--no-timeline] [--dedupe [SECONDS]]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { setNodeRuntime } from "../src/parser/runtime.ts";
import { parseMatch } from "../src/parser/parse_rec.ts";
import {
  buildJson, buildReport, collect, dedupe, nameMap, readHeaderExtras,
  toCsv, toJson, CATEGORIES,
} from "../src/parser/filter_events.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// Reads happen inside the parser's functions, never at import time, so setting
// this after the imports above is enough.
setNodeRuntime({
  fs,
  path,
  zlib,
  referenceDir: path.join(here, "..", "src", "parser", "aocref-data"),
});

const USAGE =
  "usage: node filter_events.js <recording.aoe2record> [-o output] "
  + "[--category build tech unit] [--player N ...] [--csv] [--json] "
  + "[--no-timeline] [--dedupe [SECONDS]]";

function main(argv) {
  const args = {
    recording: null, output: null, category: null, player: null,
    csv: false, json: false, noTimeline: false, dedupe: 0,
  };
  const isFlag = (v) => v !== undefined && v.startsWith("-");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--output") args.output = argv[++i];
    else if (arg === "--category") {
      args.category = [];
      while (!isFlag(argv[i + 1]) && argv[i + 1] !== undefined) args.category.push(argv[++i]);
    } else if (arg === "--player") {
      args.player = [];
      while (!isFlag(argv[i + 1]) && argv[i + 1] !== undefined) {
        args.player.push(parseInt(argv[++i], 10));
      }
    } else if (arg === "--csv") args.csv = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--no-timeline") args.noTimeline = true;
    else if (arg === "--dedupe") {
      args.dedupe = isFlag(argv[i + 1]) || argv[i + 1] === undefined ? 30 : parseInt(argv[++i], 10);
    } else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      return 0;
    } else if (args.recording === null) args.recording = arg;
    else {
      console.error(`error: unexpected argument: ${arg}`);
      return 2;
    }
  }
  if (!args.recording) {
    console.error(USAGE);
    return 2;
  }
  if (!fs.existsSync(args.recording)) {
    console.error(`error: file not found: ${args.recording}`);
    return 1;
  }
  if (args.category) {
    const bad = args.category.filter((c) => !CATEGORIES.includes(c));
    if (bad.length) {
      console.error(`error: invalid category: ${bad.join(", ")}`);
      return 2;
    }
  }

  console.error(`Parsing ${args.recording} ...`);
  const match = parseMatch(args.recording);
  const extras = readHeaderExtras(match);
  const names = nameMap(match, extras);
  const categories = new Set(args.category || CATEGORIES);
  const players = args.player ? new Set(args.player) : null;
  let rows = collect(match, categories, players, names);
  if (args.dedupe) {
    const before = rows.length;
    rows = dedupe(rows, args.dedupe);
    console.error(`deduped ${before} -> ${rows.length} rows (${args.dedupe}s window)`);
  }

  if (args.json) {
    const text = toJson(buildJson(match, rows, Boolean(args.dedupe), extras));
    if (args.output) {
      fs.writeFileSync(args.output, text, "utf-8");
      console.error(`${rows.length} events written to ${args.output}`);
    } else {
      console.log(text);
    }
    return 0;
  }

  if (args.csv) {
    const text = toCsv(rows);
    if (args.output) {
      fs.writeFileSync(args.output, text, "utf-8");
      console.error(`${rows.length} rows written to ${args.output}`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  }

  const report = buildReport(match, rows, categories, players, !args.noTimeline, names);
  if (args.output) {
    fs.writeFileSync(args.output, report, "utf-8");
    console.error(`Report written to ${args.output}`);
  } else {
    console.log(report);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
