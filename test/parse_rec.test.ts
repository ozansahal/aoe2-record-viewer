/**
 * The parser's own primitives: the byte stream the header reads run on, the
 * time formatting the report is compared on, and the two functions whose
 * documented answer is "null, on every recording you own".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  displayName, fmtDuration, fmtTimestamp, headerRange, inflateRaw, parseAchievements, Stream,
} from "../src/parser/parse_rec.ts";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("Stream", () => {
  it("reads forward and reports where it is", () => {
    const s = new Stream(bytes(1, 2, 3, 4, 5));
    assert.deepEqual([...s.read(2)], [1, 2]);
    assert.equal(s.tell(), 2);
    assert.deepEqual([...s.read(2)], [3, 4]);
    assert.equal(s.tell(), 4);
  });

  /* BytesIO returns what is left rather than raising, and the header reads
     depend on that: several of them ask for more than remains at the tail. */
  it("comes up short at the end instead of throwing", () => {
    const s = new Stream(bytes(1, 2, 3));
    assert.deepEqual([...s.read(10)], [1, 2, 3]);
    assert.equal(s.tell(), 3);
    assert.deepEqual([...s.read(1)], []);
  });

  it("reads the rest when asked for no length", () => {
    const s = new Stream(bytes(1, 2, 3, 4));
    s.read(1);
    assert.deepEqual([...s.read()], [2, 3, 4]);
  });

  it("seeks from the start, from here, and from the end", () => {
    const s = new Stream(bytes(0, 1, 2, 3, 4, 5, 6, 7));
    assert.equal(s.seek(3), 3);
    assert.deepEqual([...s.read(1)], [3]);
    assert.equal(s.seek(2, 1), 6); // relative
    assert.deepEqual([...s.read(1)], [6]);
    assert.equal(s.seek(-2, 2), 6); // from the end
  });

  it("knows its own length", () => {
    assert.equal(new Stream(bytes(1, 2, 3)).length, 3);
  });

  it("unpacks little-endian integers and advances by exactly that much", () => {
    // 1 as uint32, then 2 as uint16
    const s = new Stream(bytes(1, 0, 0, 0, 2, 0));
    assert.deepEqual(s.unpack("<I"), [1]);
    assert.equal(s.tell(), 4);
    assert.deepEqual(s.unpack("<H"), [2]);
    assert.equal(s.tell(), 6);
  });

  it("refuses to unpack past the end rather than inventing zeroes", () => {
    const s = new Stream(bytes(1, 0));
    assert.throws(() => s.unpack("<I"), /buffer of 4 bytes/);
  });
});

describe("fmtDuration", () => {
  it("drops the hour until there is one", () => {
    assert.equal(fmtDuration(0), "0:00");
    assert.equal(fmtDuration(9_000), "0:09");
    assert.equal(fmtDuration(61_000), "1:01");
    assert.equal(fmtDuration(599_000), "9:59");
  });

  it("shows hours with zero-padded minutes once past one", () => {
    assert.equal(fmtDuration(3_600_000), "1:00:00");
    assert.equal(fmtDuration(3_661_000), "1:01:01");
    assert.equal(fmtDuration(7_322_000), "2:02:02");
  });

  it("truncates sub-second remainders rather than rounding up", () => {
    assert.equal(fmtDuration(1_999), "0:01");
  });
});

describe("fmtTimestamp", () => {
  it("always pads to hh:mm:ss, which is what the report's columns rely on", () => {
    assert.equal(fmtTimestamp(0), "00:00:00");
    assert.equal(fmtTimestamp(61_000), "00:01:01");
    assert.equal(fmtTimestamp(3_661_000), "01:01:01");
  });
});

describe("displayName", () => {
  it("uses the username when there is one", () => {
    assert.equal(displayName({ name: "Ozan", number: 1 }), "Ozan");
  });

  it("labels an unnamed slot by its number, since an AI has no username", () => {
    assert.equal(displayName({ name: "", number: 2 }), "AI (P2)");
    assert.equal(displayName({ name: null, number: 3 }), "AI (P3)");
  });
});

describe("headerRange", () => {
  /* Two lines, and no validation on purpose: it is mgz's struct read, and the
     "this is not a recording" error surfaces further along, when the header
     fails to inflate. Garbage in gives a garbage range rather than a throw. */
  it("reads the little-endian length prefix and starts the header at 8", () => {
    assert.deepEqual(headerRange(bytes(64, 0, 0, 0, 9, 9, 9, 9)), [8, 64]);
    assert.deepEqual(headerRange(bytes(0, 1, 0, 0, 9, 9, 9, 9)), [8, 256]);
  });

  it("throws only when there is not even a length prefix to read", () => {
    assert.throws(() => headerRange(bytes(0, 0, 0)), /at least 4 bytes/);
  });
});

describe("parseAchievements", () => {
  /* The score screen is a UserPatch/HD action. No Definitive Edition recording
     contains one, which is why the viewer derives the subset it can instead --
     see deriveAchievements. Null here is the documented answer, not a gap. */
  it("returns null when there are no bytes", () => {
    assert.equal(parseAchievements(null, "utf-8", {}), null);
  });

  it("returns null rather than throwing on bytes that do not fit the struct", () => {
    assert.equal(parseAchievements(bytes(1, 2, 3), "utf-8", {}), null);
  });
});

describe("inflateRaw", () => {
  it("round-trips a raw deflate stream", async () => {
    const { deflateRawSync } = await import("node:zlib");
    const original = new TextEncoder().encode("the quick brown fox".repeat(20));
    const out = await inflateRaw(new Uint8Array(deflateRawSync(original)));
    assert.deepEqual([...out], [...original]);
  });
});
