/**
 * The pure half of filter_events: turning actions into rows, and rows into
 * text. No recording needed, so these run everywhere and are where a rule gets
 * pinned down -- the dedupe scoping in particular, which is a decision rather
 * than a mechanism and cost someone an afternoon to get right.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classify, dedupe, toCsv, toJson } from "../src/parser/filter_events.ts";

/** An action shaped the way the match model shapes them. */
const action = (type_name: string, payload: Record<string, unknown> = {}) =>
  ({ type_name, payload });

describe("classify", () => {
  it("reads a building out of a BUILD", () => {
    assert.deepEqual(classify(action("BUILD", { building: "House" })), ["build", "House", 1, "BUILD"]);
  });

  it("reads a technology out of a RESEARCH", () => {
    assert.deepEqual(classify(action("RESEARCH", { technology: "Loom" })), ["tech", "Loom", 1, "RESEARCH"]);
  });

  it("takes the amount from a queue, defaulting to one", () => {
    assert.deepEqual(classify(action("DE_QUEUE", { unit: "Archer", amount: 5 })),
      ["unit", "Archer", 5, "DE_QUEUE"]);
    assert.deepEqual(classify(action("QUEUE", { unit: "Skirmisher" })),
      ["unit", "Skirmisher", 1, "QUEUE"]);
  });

  it("counts a MAKE as one unit, whatever the payload says", () => {
    assert.deepEqual(classify(action("MAKE", { unit: "Villager", amount: 9 })),
      ["unit", "Villager", 1, "MAKE"]);
  });

  it("falls back to the numeric id when reference data has no name", () => {
    assert.deepEqual(classify(action("BUILD", { building_id: 70 })),
      ["build", "building #70", 1, "BUILD"]);
    /* "None", not "undefined": the report is compared against Python's, which
       renders a missing id with its own repr. */
    assert.deepEqual(classify(action("RESEARCH", {})), ["tech", "tech #None", 1, "RESEARCH"]);
  });

  it("ignores everything else", () => {
    assert.equal(classify(action("MOVE", { x: 1 })), null);
    assert.equal(classify(action("DE_ATTACK_MOVE")), null);
  });
});

describe("dedupe", () => {
  const row = (seconds: number, category: string, item: string, player_number = 1) =>
    ({ seconds, category, item, player_number, time: "", player: "", quantity: 1, source: "" });

  it("collapses a build order re-sent inside the window", () => {
    const kept = dedupe([
      row(100, "build", "House"),
      row(105, "build", "House"),
      row(108, "build", "House"),
    ], 30);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].seconds, 100);
  });

  it("keeps a repeat that arrives after the window", () => {
    const kept = dedupe([row(100, "build", "House"), row(140, "build", "House")], 30);
    assert.deepEqual(kept.map((r) => r.seconds), [100, 140]);
  });

  /* A chain measures each repeat against the one before it, not against the
     first: an AI re-sending every 5s for two minutes is one order, not four. */
  it("treats a continuous chain as one order however long it runs", () => {
    const rows = Array.from({ length: 24 }, (_, i) => row(100 + i * 5, "build", "House"));
    assert.equal(dedupe(rows, 30).length, 1);
  });

  it("never collapses unit training, because repeat queuing is real production", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(100 + i, "unit", "Villager"));
    assert.equal(dedupe(rows, 30).length, 10);
  });

  it("keeps players and items apart", () => {
    const kept = dedupe([
      row(100, "build", "House", 1),
      row(102, "build", "House", 2),
      row(103, "build", "Farm", 1),
      row(104, "tech", "Loom", 1),
    ], 30);
    assert.equal(kept.length, 4);
  });

  /* A zero window is not how dedupe is switched off -- `fromMatch` and both
     CLIs guard on it and never call in. Handed zero anyway it still folds a
     repeat sent in the same second, because the comparison is `<=`. Worth
     pinning: "0 disables it" is the natural assumption and it is wrong. */
  it("folds only a simultaneous repeat when the window is zero", () => {
    assert.equal(dedupe([row(100, "build", "House"), row(100, "build", "House")], 0).length, 1);
    assert.equal(dedupe([row(100, "build", "House"), row(101, "build", "House")], 0).length, 2);
  });
});

describe("toCsv", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    seconds: 61, time: "00:01:01", player_number: 1, player: "Ozan",
    category: "build", item: "House", quantity: 1, source: "BUILD", ...over,
  });

  it("writes the header, then a row per event, and ends with a newline", () => {
    const text = toCsv([row()]);
    assert.equal(text,
      "seconds,time,player_number,player,category,item,quantity,source\n"
      + "61,00:01:01,1,Ozan,build,House,1,BUILD\n");
  });

  it("quotes a field holding a comma, and doubles an embedded quote", () => {
    assert.match(toCsv([row({ player: "Last, First" })]), /"Last, First"/);
    assert.match(toCsv([row({ player: 'He said "hi"' })]), /"He said ""hi"""/);
  });

  it("still writes the header when there are no rows", () => {
    assert.equal(toCsv([]), "seconds,time,player_number,player,category,item,quantity,source\n");
  });
});

describe("toJson", () => {
  it("indents with one space, matching json.dumps(indent=1)", () => {
    assert.equal(toJson({ a: 1 }), '{\n "a": 1\n}');
  });

  /* Python's json.dumps escapes non-ASCII by default and the two outputs are
     compared character for character, so this has to as well. */
  it("escapes non-ASCII as \\uXXXX", () => {
    assert.equal(toJson({ name: "Ozan Şahal" }), '{\n "name": "Ozan \\u015eahal"\n}');
    assert.equal(toJson({ map: "Arena \u2014 4v4" }), '{\n "map": "Arena \\u2014 4v4"\n}');
  });

  it("leaves ASCII alone", () => {
    assert.equal(toJson({ map: "Arena" }), '{\n "map": "Arena"\n}');
  });
});
