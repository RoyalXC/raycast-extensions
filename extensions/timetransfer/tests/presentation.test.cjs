const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildSync } = require("esbuild");
const Module = require("node:module");
const path = require("node:path");

function loadSource(name) {
  const bundle = buildSync({
    entryPoints: [path.join(__dirname, "../src", name)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const compiled = new Module(name);
  compiled._compile(bundle.outputFiles[0].text, `${name}.js`);
  return compiled.exports;
}

const { DEFAULT_SETTINGS, normalizeSettings } = loadSource("settings.ts");
const { buildResultTable } = loadSource("table.ts");
const { convertBatch } = loadSource("utils.ts");

test("saved conversion settings survive JSON storage", () => {
  const saved = { mode: "date", outputUnit: "seconds", timeZone: "utc", closeAfterCopy: false };
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(saved))), saved);
});

test("invalid saved fields recover independently without discarding valid choices", () => {
  for (const value of [undefined, null, "bad cache", []]) {
    assert.deepEqual(normalizeSettings(value), DEFAULT_SETTINGS);
  }
  assert.deepEqual(
    normalizeSettings({ mode: "old-mode", outputUnit: "seconds", timeZone: "Mars", closeAfterCopy: false }),
    {
      mode: "auto",
      outputUnit: "seconds",
      timeZone: "local",
      closeAfterCopy: false,
    },
  );
});

test("TSV copy preserves input order, duplicates, and errors with one row per entry", () => {
  const items = convertBatch("2026-02-01T00:00:00Z,invalid,2026-02-01T00:00:00Z");
  const rows = buildResultTable(items)
    .split("\n")
    .map((row) => row.split("\t"));
  assert.deepEqual(rows[0], ["原值", "结果", "状态"]);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], ["2026-02-01T00:00:00Z", "1769904000000", "成功"]);
  assert.equal(rows[2][0], "invalid");
  assert.equal(rows[2][1], "");
  assert.ok(rows[2][2].length > 0);
  assert.deepEqual(rows[3], rows[1]);
});

test("TSV cells cannot create extra rows or columns", () => {
  const text = buildResultTable([
    { original: "a\tb\nc", output: null, error: { code: "invalid_format", message: "error\tdetail" } },
  ]);
  assert.deepEqual(
    text.split("\n").map((row) => row.split("\t")),
    [
      ["原值", "结果", "状态"],
      ["a b c", "", "error detail"],
    ],
  );
});

test("TSV copy uses the selected output unit and retains fractional seconds", () => {
  const items = convertBatch("2026-02-01T00:00:00.500Z", "date", { outputUnit: "seconds", timeZone: "utc" });
  assert.equal(buildResultTable(items), "原值\t结果\t状态\n2026-02-01T00:00:00.500Z\t1769904000.5\t成功");
});
