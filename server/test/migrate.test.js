"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { migrateSamples, MAX_SAMPLES } = require("../migrate");

const OBJECT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "integer" },
    contact: {
      type: "object",
      properties: { phone: { type: "string" } },
      required: ["phone"],
    },
    tags: { type: "array", items: { type: "string" } },
    v: { type: "integer" },
  },
  required: ["id", "contact", "v"],
};

const BASELINE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "integer" },
    phone: { type: ["null", "string"] },
    tags: { type: "array" },
  },
  required: ["id", "phone"],
};

test("migrateSamples moves values to nested targets, fills defaults and groups success", () => {
  const result = migrateSamples({
    baselineSchema: BASELINE_SCHEMA,
    currentSchema: OBJECT_SCHEMA,
    samples: [{ id: 1, phone: "123", tags: ["a", "b"] }],
    mappings: [
      { from: "/phone", to: "/contact/phone" },
      { from: "/version", to: "/v", default: 1 },
    ],
  });
  assert.equal(result.total, 1);
  assert.deepEqual(result.summary, { success: 1, conflict: 0, invalid: 0 });
  const item = result.samples[0];
  assert.equal(item.status, "success");
  assert.deepEqual(item.before, { id: 1, phone: "123", tags: ["a", "b"] });
  assert.deepEqual(item.after, {
    id: 1,
    tags: ["a", "b"],
    contact: { phone: "123" },
    v: 1,
  });
  assert.equal(item.current.valid, true);
  assert.equal(item.baseline.valid, true);
  assert.deepEqual(
    item.operations.map((op) => op.kind),
    ["move", "default"]
  );
  assert.equal(result.mappings[1].hasDefault, true);
});

test("migrateSamples plans removals deepest first and writes shallowest first", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ a: { x: 1 } }],
    mappings: [
      { from: "/a", to: "/moved" },
      { from: "/a/x", to: "/xOnly" },
    ],
  });
  // Removals: depth 2 (/a/x) before depth 1 (/a).
  assert.deepEqual(
    result.plan.sourceRemovals.map((op) => op.pointer),
    ["/a/x", "/a"]
  );
  // Writes: depth 1 targets before depth 2.
  assert.deepEqual(
    result.plan.targetWrites.map((op) => op.pointer).sort((a, b) => a.length - b.length),
    result.plan.targetWrites.map((op) => op.pointer)
  );
  // Deepest source is lifted out, ancestor subtree moves without that key.
  assert.deepEqual(result.samples[0].after, { moved: {}, xOnly: 1 });
});

test("migrateSamples supports swaps and chains because all sources are extracted first", () => {
  const swap = migrateSamples({
    currentSchema: {},
    samples: [{ a: 1, b: 2 }],
    mappings: [
      { from: "/a", to: "/b" },
      { from: "/b", to: "/a" },
    ],
  });
  assert.deepEqual(swap.samples[0].after, { b: 1, a: 2 });

  const chain = migrateSamples({
    currentSchema: {},
    samples: [{ a: 1, b: 2 }],
    mappings: [
      { from: "/a", to: "/b" },
      { from: "/b", to: "/c" },
    ],
  });
  assert.deepEqual(chain.samples[0].after, { b: 1, c: 2 });
});

test("migrateSamples handles array elements: high indexes first, - append, fresh arrays", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ list: [10, 20, 30] }],
    mappings: [
      { from: "/list/1", to: "/one" },
      { from: "/list/0", to: "/rest/-" },
    ],
  });
  // /list/1 (20) removed first while indexes are still valid, then /list/0 (10).
  assert.deepEqual(result.samples[0].after, { list: [30], one: 20, rest: [10] });

  const appended = migrateSamples({
    currentSchema: {},
    samples: [{ x: 1, tags: ["a"] }],
    mappings: [{ from: "/x", to: "/tags/-" }],
  });
  assert.deepEqual(appended.samples[0].after, { tags: ["a", 1] });

  // A missing intermediate before a numeric child is auto-created as an array.
  const fresh = migrateSamples({
    currentSchema: {},
    samples: [{ x: 7 }],
    mappings: [{ from: "/x", to: "/items/0" }],
  });
  assert.deepEqual(fresh.samples[0].after, { items: [7] });
});

test("migrateSamples swaps array elements in place without losing untouched elements", () => {
  const mappings = [
    { from: "/arr/0", to: "/arr/1" },
    { from: "/arr/1", to: "/arr/0" },
  ];
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ arr: ["A", "B", "C"] }],
    mappings,
  });
  assert.equal(result.samples[0].status, "success");
  // The unmoved "C" must survive: indexes address pre-migration positions.
  assert.deepEqual(result.samples[0].after, { arr: ["B", "A", "C"] });

  // Mapping input order must not change the outcome.
  const reversed = migrateSamples({
    currentSchema: {},
    samples: [{ arr: ["A", "B", "C"] }],
    mappings: [...mappings].reverse(),
  });
  assert.deepEqual(reversed.samples[0].after, { arr: ["B", "A", "C"] });
});

test("migrateSamples keeps pre-migration indexes inside nested arrays", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ m: [["a", "b"], ["c", "d"]] }],
    mappings: [
      { from: "/m/0/0", to: "/m/0/1" },
      { from: "/m/0/1", to: "/m/0/0" },
    ],
  });
  assert.deepEqual(result.samples[0].after, { m: [["b", "a"], ["c", "d"]] });

  // Swap across two sibling sub-arrays.
  const cross = migrateSamples({
    currentSchema: {},
    samples: [{ m: [["a", "b"], ["c", "d"]] }],
    mappings: [
      { from: "/m/1/0", to: "/m/0/0" },
      { from: "/m/0/0", to: "/m/1/0" },
    ],
  });
  assert.deepEqual(cross.samples[0].after, { m: [["c", "b"], ["a", "d"]] });
});

test("migrateSamples compacts source vacancies after all writes, keeping refilled slots", () => {
  // Move /arr/1 out and refill exactly that slot from elsewhere: the array
  // keeps its shape, nothing shifts.
  const refilled = migrateSamples({
    currentSchema: {},
    samples: [{ arr: ["A", "B", "C"], y: "Y" }],
    mappings: [
      { from: "/arr/1", to: "/x" },
      { from: "/y", to: "/arr/1" },
    ],
  });
  assert.deepEqual(refilled.samples[0].after, { arr: ["A", "Y", "C"], x: "B" });

  // Move out only: the gap closes after writes, siblings keep their order.
  const movedOut = migrateSamples({
    currentSchema: {},
    samples: [{ arr: ["A", "B", "C"] }],
    mappings: [{ from: "/arr/0", to: "/x" }],
  });
  assert.deepEqual(movedOut.samples[0].after, { arr: ["B", "C"], x: "A" });

  // Two gaps close in one pass; the untouched elements survive in order.
  const twoGaps = migrateSamples({
    currentSchema: {},
    samples: [{ arr: ["A", "B", "C", "D"] }],
    mappings: [
      { from: "/arr/2", to: "/y" },
      { from: "/arr/0", to: "/x" },
    ],
  });
  assert.deepEqual(twoGaps.samples[0].after, { arr: ["B", "D"], x: "A", y: "C" });
});

test("migrateSamples addresses targets by pre-migration indexes (move to original end)", () => {
  // /arr/3 is exactly the pre-migration length: append after the last element.
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ arr: ["A", "B", "C"] }],
    mappings: [{ from: "/arr/0", to: "/arr/3" }],
  });
  assert.equal(result.samples[0].status, "success");
  assert.deepEqual(result.samples[0].after, { arr: ["B", "C", "A"] });

  // One past the original end is still out of range and rolls the sample back.
  const oor = migrateSamples({
    currentSchema: {},
    samples: [{ arr: ["A", "B", "C"] }],
    mappings: [{ from: "/arr/0", to: "/arr/4" }],
  });
  assert.equal(oor.samples[0].status, "conflict");
  assert.match(oor.samples[0].reasons[0], /越界/);
  assert.deepEqual(oor.samples[0].before, { arr: ["A", "B", "C"] });
});

test("migrateSamples compacts vacancies inside a moved subtree", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ arr: ["A", "B", "C"] }],
    mappings: [
      { from: "/arr/0", to: "/x" },
      { from: "/arr", to: "/rest" },
    ],
  });
  assert.deepEqual(result.samples[0].after, { x: "A", rest: ["B", "C"] });
});

test("migrateSamples refuses to write through a vacated array element", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ arr: [{ v: 1 }], y: { v: 2 } }],
    mappings: [
      { from: "/arr/0", to: "/x" },
      { from: "/y", to: "/arr/0/v" },
    ],
  });
  const item = result.samples[0];
  assert.equal(item.status, "conflict");
  assert.match(item.reasons[0], /已被移出/);
  assert.deepEqual(item.before, { arr: [{ v: 1 }], y: { v: 2 } });
});

test("migrateSamples still conflicts when two active mappings write the same array slot", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ arr: ["A"], a: 1, b: 2 }],
    mappings: [
      { from: "/arr/0", to: "/x" },
      { from: "/a", to: "/arr/0" },
      { from: "/b", to: "/arr/0" },
    ],
  });
  const item = result.samples[0];
  assert.equal(item.status, "conflict");
  assert.equal(item.after, null);
  assert.deepEqual(item.before, { arr: ["A"], a: 1, b: 2 });
  assert.match(item.reasons[0], /写入位置冲突/);
});

test("migrateSamples validates migrated arrays with Ajv and keeps the status classes", () => {
  const schema = {
    type: "object",
    properties: { arr: { type: "array", items: { type: "string" }, minItems: 3 } },
    required: ["arr"],
  };
  const ok = migrateSamples({
    currentSchema: schema,
    samples: [{ arr: ["A", "B", "C"] }],
    mappings: [
      { from: "/arr/0", to: "/arr/1" },
      { from: "/arr/1", to: "/arr/0" },
    ],
  });
  assert.deepEqual(ok.summary, { success: 1, conflict: 0, invalid: 0 });
  assert.equal(ok.samples[0].current.valid, true);

  // The migration applied cleanly (compacted to 2 items) but fails minItems.
  const invalid = migrateSamples({
    currentSchema: schema,
    samples: [{ arr: ["A", "B", "C"] }],
    mappings: [{ from: "/arr/0", to: "/x" }],
  });
  assert.equal(invalid.samples[0].status, "invalid");
  assert.deepEqual(invalid.samples[0].after, { arr: ["B", "C"], x: "A" });
  assert.equal(invalid.samples[0].current.valid, false);
  assert.equal(invalid.samples[0].current.errors[0].keyword, "minItems");
});

test("migrateSamples fills a default only when the source is missing", () => {  const result = migrateSamples({
    currentSchema: {},
    samples: [
      { a: 1 }, // source present -> moved, default ignored
      {}, // source missing -> default applied
    ],
    mappings: [{ from: "/a", to: "/b", default: 99 }],
  });
  assert.deepEqual(result.samples[0].after, { b: 1 });
  assert.deepEqual(result.samples[1].after, { b: 99 });
  assert.equal(result.samples[1].operations[0].kind, "default");
});

test("migrateSamples treats an explicit null default as a real default", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{}],
    mappings: [{ from: "/missing", to: "/z", default: null }],
  });
  assert.deepEqual(result.samples[0].after, { z: null });
});

test("migrateSamples skips a missing source without a default and still succeeds", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ id: 3, contact: { phone: "000" } }],
    mappings: [{ from: "/phone", to: "/contact/phone" }],
  });
  const item = result.samples[0];
  assert.equal(item.status, "success");
  assert.deepEqual(item.after, { id: 3, contact: { phone: "000" } });
  assert.equal(item.operations[0].kind, "skip");
  assert.match(item.operations[0].reason, /缺失/);
});

test("migrateSamples supports moving the whole sample from the root", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ old: 1 }],
    mappings: [
      { from: "", to: "/payload" },
      { from: "/version", to: "/v", default: 0 },
    ],
  });
  assert.deepEqual(result.samples[0].after, { payload: { old: 1 }, v: 0 });
});

test("migrateSamples honors RFC 6901 escaping (~0, ~1)", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ "a/b": 1, "c~d": 2 }],
    mappings: [
      { from: "/a~1b", to: "/k1" },
      { from: "/c~0d", to: "/k2" },
    ],
  });
  assert.deepEqual(result.samples[0].after, { k1: 1, k2: 2 });
});

test("migrateSamples keeps a conflicting sample byte-for-byte unchanged with reasons", () => {
  const original = { a: 1, b: 2 };
  const result = migrateSamples({
    baselineSchema: BASELINE_SCHEMA,
    currentSchema: {},
    samples: [original],
    mappings: [{ from: "/a", to: "/b" }], // /b already exists, uncovered
  });
  assert.deepEqual(result.summary, { success: 0, conflict: 1, invalid: 0 });
  const item = result.samples[0];
  assert.equal(item.status, "conflict");
  assert.equal(item.after, null);
  assert.deepEqual(item.before, original);
  assert.ok(original.a === 1 && original.b === 2, "input sample must not be mutated");
  assert.equal(item.reasons.length, 1);
  assert.match(item.reasons[0], /\/b/);
  // Conflict samples are still checked against the schemas (on the original).
  assert.equal(item.current.valid, true);
});

test("migrateSamples conflicts on a scalar in the target chain and rolls back", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ a: 1, x: 5, arr: [1] }],
    mappings: [
      { from: "/a", to: "/ok" }, // would be written first…
      { from: "/arr/0", to: "/x/y" }, // …but /x is a scalar -> whole sample rolls back
    ],
  });
  const item = result.samples[0];
  assert.equal(item.status, "conflict");
  assert.deepEqual(item.before, { a: 1, x: 5, arr: [1] });
  assert.ok(item.reasons.some((r) => /标量/.test(r)));
});

test("migrateSamples conflicts on a non-index key or an out-of-range array index", () => {
  const key = migrateSamples({
    currentSchema: {},
    samples: [{ a: 1, list: [] }],
    mappings: [{ from: "/a", to: "/list/k" }],
  });
  assert.equal(key.samples[0].status, "conflict");
  assert.ok(key.samples[0].reasons[0].includes("不是合法数字下标"));

  const oor = migrateSamples({
    currentSchema: {},
    samples: [{ a: 1 }],
    mappings: [{ from: "/a", to: "/out/5" }],
  });
  assert.equal(oor.samples[0].status, "conflict");
  assert.match(oor.samples[0].reasons[0], /越界/);
});

test("migrateSamples reports a per-sample conflict when two moves land on the same target", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ a: 1, b: 2 }],
    mappings: [
      { from: "/a", to: "/z" },
      { from: "/b", to: "/z" },
    ],
  });
  assert.equal(result.samples[0].status, "conflict");
  assert.match(result.samples[0].reasons[0], /写入位置冲突/);
});

test("migrateSamples classifies an applied but non-conforming result as invalid", () => {
  const result = migrateSamples({
    baselineSchema: {},
    currentSchema: OBJECT_SCHEMA,
    samples: [{ id: "oops", phone: 9 }],
    mappings: [
      { from: "/phone", to: "/contact/phone" },
      { from: "/version", to: "/v", default: 1 },
    ],
  });
  assert.deepEqual(result.summary, { success: 0, conflict: 0, invalid: 1 });
  const item = result.samples[0];
  assert.equal(item.status, "invalid");
  assert.deepEqual(item.after, { id: "oops", contact: { phone: 9 }, v: 1 });
  assert.equal(item.current.valid, false);
  const paths = item.current.errors.map((e) => e.pointer);
  assert.ok(paths.includes("/id"));
  assert.ok(paths.includes("/contact/phone"));
});

test("migrateSamples mixes success, conflict and invalid in one run", () => {
  const result = migrateSamples({
    baselineSchema: BASELINE_SCHEMA,
    currentSchema: OBJECT_SCHEMA,
    samples: [
      { id: 1, phone: "123" }, // success
      { id: 2, contact: { phone: "x" } }, // success (missing source skipped)
      { id: 3, phone: "1", contact: { phone: "2" } }, // target pre-exists -> conflict
      { id: 4, phone: 5 }, // migrated but current rejects it -> invalid
    ],
    mappings: [
      { from: "/phone", to: "/contact/phone" },
      { from: "/version", to: "/v", default: 1 },
    ],
  });
  assert.deepEqual(result.summary, { success: 2, conflict: 1, invalid: 1 });
  assert.deepEqual(
    result.samples.map((s) => s.status),
    ["success", "success", "conflict", "invalid"]
  );
});

test("migrateSamples refuses illegal mappings with 422 and per-mapping reasons", () => {
  const cases = [
    { mappings: [{ from: "a", to: "/b" }] },
    { mappings: [{ from: "/a", to: "" }] },
    { mappings: [{ from: "/a", to: "/a" }] },
    { mappings: [{ from: "/a", to: "/x/-/y" }] },
    {
      mappings: [
        { from: "/a", to: "/x" },
        { from: "/a", to: "/y" },
      ],
    },
    {
      mappings: [
        { from: "/a", to: "/x" },
        { from: "/b", to: "/x/y" },
      ],
    },
  ];
  for (const body of cases) {
    assert.throws(
      () => migrateSamples({ currentSchema: {}, samples: [{ a: 1 }], ...body }),
      (err) => err.status === 422 && Array.isArray(err.details.invalidMappings)
    );
  }
});

test("migrateSamples validates request shape with 400", () => {
  assert.throws(
    () => migrateSamples({ samples: [1], mappings: [] }),
    (err) => err.status === 400 && /currentSchema/.test(err.message)
  );
  assert.throws(
    () => migrateSamples({ currentSchema: {}, mappings: [] }),
    (err) => err.status === 400 && /'samples' array/.test(err.message)
  );
  assert.throws(
    () => migrateSamples({ currentSchema: {}, samples: [1] }),
    (err) => err.status === 400 && /'mappings' array/.test(err.message)
  );
  assert.throws(
    () => migrateSamples({ currentSchema: {}, samples: [1], mappings: [{ from: 1 }] }),
    (err) => err.status === 400 && /string 'from' and 'to'/.test(err.message)
  );
});

test(`migrateSamples rejects more than ${MAX_SAMPLES} samples with 400`, () => {
  assert.throws(
    () =>
      migrateSamples({
        currentSchema: {},
        samples: Array.from({ length: MAX_SAMPLES + 1 }, () => 1),
        mappings: [{ from: "/a", to: "/b" }],
      }),
    (err) => err.status === 400 && new RegExp(`${MAX_SAMPLES}`).test(err.message)
  );
  const ok = migrateSamples({
    currentSchema: {},
    samples: Array.from({ length: MAX_SAMPLES }, () => ({})),
    mappings: [{ from: "/a", to: "/b" }],
  });
  assert.equal(ok.total, MAX_SAMPLES);
});

test("migrateSamples rejects an uncompilable current schema with 422", () => {
  assert.throws(
    () =>
      migrateSamples({
        currentSchema: { type: "not-a-type" },
        samples: [1],
        mappings: [{ from: "/a", to: "/b" }],
      }),
    (err) => err.status === 422 && /Invalid schema/.test(err.message)
  );
});

test("migrateSamples works without a baseline schema (baseline is null)", () => {
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ a: 1 }],
    mappings: [{ from: "/a", to: "/b" }],
  });
  assert.equal(result.samples[0].baseline, null);
});

test("migrateSamples deep-clones values so moved subtrees do not share references", () => {
  const shared = { nested: { v: 1 } };
  const result = migrateSamples({
    currentSchema: {},
    samples: [{ a: shared }, { a: { nested: { v: 2 } } }],
    mappings: [{ from: "/a", to: "/b" }],
  });
  result.samples[0].after.b.nested.v = 99;
  assert.equal(shared.nested.v, 1);
  assert.equal(result.samples[1].after.b.nested.v, 2);
});
