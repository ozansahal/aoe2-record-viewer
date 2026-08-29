#!/usr/bin/env node
/**
 * CLI for the recording parser -- the Node half of src/parser/parse_rec.ts,
 * kept out of the library so the renderer bundle never sees a `node:` import.
 *
 * Mirrors parse_rec.py at the repository root, and is one half of the Python
 * parity harness: both must produce character-identical reports.
 *
 *   node cli/parse_rec.js <recording.aoe2record> [-o out.txt] [--no-chat] [--actions]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { setNodeRuntime } from "../src/parser/runtime.ts";
import { parseRec } from "../src/parser/parse_rec.ts";

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
  "usage: node parse_rec.js <recording.aoe2record> [-o output.txt] [--no-chat] [--actions]";

function main(argv) {
  const args = { recording: null, output: null, noChat: false, actions: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--output") args.output = argv[++i];
    else if (arg === "--no-chat") args.noChat = true;
    else if (arg === "--actions") args.actions = true;
    else if (arg === "-h" || arg === "--help") {
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
  console.error(`Parsing ${args.recording} ...`);
  const report = parseRec(args.recording, { chat: !args.noChat, actions: args.actions });
  if (args.output) {
    fs.writeFileSync(args.output, report, "utf-8");
    console.error(`Report written to ${args.output}`);
  } else {
    console.log(report);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
