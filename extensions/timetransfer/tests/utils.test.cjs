const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { transformSync } = require("esbuild");

const source = readFileSync(path.join(__dirname, "../src/utils.ts"), "utf8");
const compiled = transformSync(source, { loader: "ts", format: "cjs", target: "es2020" }).code;
const moduleObject = { exports: {} };
new Function("module", "exports", compiled)(moduleObject, moduleObject.exports);
const { tryConvert, convertBatch, convertInput } = moduleObject.exports;

function runInTimeZone(timeZone, script) {
  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: timeZone, UTILS_COMPILED: compiled },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("auto mode detects seconds and milliseconds by absolute magnitude", () => {
  assert.equal(tryConvert("1700000000").timestampUnit, "seconds");
  assert.equal(tryConvert("-1700000000").timestampUnit, "seconds");
  assert.equal(tryConvert("1769875200000").timestampUnit, "milliseconds");
  assert.equal(tryConvert("00001769875200000").timestampUnit, "milliseconds");
  assert.equal(tryConvert("20230101").timestampUnit, "seconds");
  assert.equal(tryConvert("1e3"), null);
  assert.equal(tryConvert("1e3", "seconds"), null);
});

test("explicit units override auto detection and milliseconds must be integral", () => {
  assert.equal(tryConvert("170000000000", "seconds").timestampUnit, "seconds");
  assert.equal(tryConvert("1700000000", "milliseconds").timestampUnit, "milliseconds");
  assert.equal(tryConvert("1700000000.0", "milliseconds").timestampUnit, "milliseconds");
  assert.equal(tryConvert("2024-01-01", "seconds"), null);
  assert.equal(tryConvert("20240101", "milliseconds").timestampUnit, "milliseconds");
  assert.equal(tryConvert("100000000000.5"), null);
  assert.equal(tryConvert("8640000000000001", "milliseconds"), null);
});

test("fractional seconds preserve milliseconds and reject nonzero excess precision", () => {
  const script = `
    const module = { exports: {} };
    new Function("module", "exports", process.env.UTILS_COMPILED)(module, module.exports);
    const { tryConvert } = module.exports;
    console.log(JSON.stringify([tryConvert("1.234"), tryConvert("-1.234"), tryConvert("1.2340000"), tryConvert(".5")]));
  `;
  const [positive, negative, trailingZeros, half] = runInTimeZone("UTC", script);
  assert.equal(positive.result, "1970-01-01 00:00:01.234");
  assert.equal(negative.result, "1969-12-31 23:59:58.766");
  assert.equal(trailingZeros.result, "1970-01-01 00:00:01.234");
  assert.equal(half.result, "1970-01-01 00:00:00.500");
  assert.equal(tryConvert("1.2341"), null);
});

test("local dates and date-times use the process timezone in UTC and Shanghai", () => {
  const script = `
    const module = { exports: {} };
    new Function("module", "exports", process.env.UTILS_COMPILED)(module, module.exports);
    const date = module.exports.tryConvert("2024-01-01 12:34:56.007", "date");
    const isoLocal = module.exports.tryConvert("2024-01-01T12:34:56.007", "date");
    const slash = module.exports.tryConvert("2024/01/01T12:34", "date");
    console.log(JSON.stringify({ date, isoLocal, slash }));
  `;
  const utc = runInTimeZone("UTC", script);
  const shanghai = runInTimeZone("Asia/Shanghai", script);
  assert.equal(utc.date.result, String(Date.UTC(2024, 0, 1, 12, 34, 56, 7)));
  assert.equal(utc.isoLocal.result, utc.date.result);
  assert.equal(shanghai.date.result, String(Date.UTC(2024, 0, 1, 4, 34, 56, 7)));
  assert.equal(shanghai.isoLocal.result, shanghai.date.result);
  assert.equal(Number(utc.date.result) - Number(shanghai.date.result), 8 * 60 * 60 * 1000);
  assert.equal(utc.slash.result, String(Date.UTC(2024, 0, 1, 12, 34)));
  assert.equal(shanghai.slash.result, String(Date.UTC(2024, 0, 1, 4, 34)));
});

test("explicit ISO offsets produce the same instant across timezones", () => {
  const script = `
    const module = { exports: {} };
    new Function("module", "exports", process.env.UTILS_COMPILED)(module, module.exports);
    console.log(JSON.stringify(module.exports.tryConvert("2024-01-01T12:34:56.789+08:00", "date")));
  `;
  const utc = runInTimeZone("UTC", script);
  const shanghai = runInTimeZone("Asia/Shanghai", script);
  assert.equal(utc.result, "1704083696789");
  assert.deepEqual(shanghai, utc);
  assert.equal(tryConvert("2024-01-01T04:34:56.789Z", "date").result, utc.result);
});

test("calendar dates, times, and offsets are strictly validated", () => {
  assert.notEqual(tryConvert("20240229", "date"), null);
  assert.notEqual(tryConvert("2000-02-29", "date"), null);
  for (const value of [
    "20230229",
    "20230231",
    "2023-02-31",
    "2024-13-01",
    "2024-01-01 24:00",
    "2024-01-01 12:60",
    "2024-01-01T12:00:00+24:00",
    "2024-01-01T12:00:00+08:60",
    "2024-01-01T12:00:00.0001Z",
  ]) {
    assert.equal(tryConvert(value, "date"), null, value);
  }
  assert.equal(tryConvert("20240101", "auto").type, "timestamp");
  assert.equal(tryConvert("20240101", "date").type, "date");
});

test("batch conversion preserves input order, duplicates, and date-time spaces", () => {
  const batch = convertBatch(" 1700000000, 2024-01-01 12:30;1700000000；bad\n", "auto");
  assert.deepEqual(
    batch.map(({ original }) => original),
    ["1700000000", "2024-01-01 12:30", "1700000000", "bad"],
  );
  assert.equal(batch[0].output.timestampUnit, "seconds");
  assert.equal(batch[1].output.type, "date");
  assert.equal(batch[2].output.result, batch[0].output.result);
  assert.equal(batch[3].output, null);
  assert.deepEqual(
    convertBatch("1 2.5 -3", "seconds").map(({ original }) => original),
    ["1", "2.5", "-3"],
  );
  assert.equal(convertBatch('{"time":1700000000}').length, 1);
  assert.equal(convertBatch("1700000000 1700000001").length, 2);
});

test("date output is epoch milliseconds and timestamp output keeps nonzero milliseconds", () => {
  const date = tryConvert("2024-01-01T00:00:00.007Z", "date");
  const timestamp = tryConvert(date.result, "milliseconds");
  assert.equal(date.result, "1704067200007");
  assert.equal(timestamp.result.endsWith(".007"), true);
  assert.equal(tryConvert("1704067200000", "milliseconds").result.endsWith(".000"), false);
});

test("review regressions: equivalent dates, early timestamps, negatives, and compact date mode", () => {
  const script = `
    const module = { exports: {} };
    new Function("module", "exports", process.env.UTILS_COMPILED)(module, module.exports);
    const { tryConvert } = module.exports;
    console.log(JSON.stringify({
      dates: ["2026-02-01", "2026/02/01", "2026-02-01 00:00:00"].map(value => tryConvert(value)),
      early: tryConvert("31536000"),
      negative: tryConvert("-1"),
      padded: tryConvert("0001769875200"),
      fractional: tryConvert("1769875200.5"),
      compact: tryConvert("20260201", "date"),
      invalid: ["2023-02-29", "2023-02-31", "2026-04-31"].map(value => tryConvert(value))
    }));
  `;
  const results = runInTimeZone("Asia/Shanghai", script);
  assert.deepEqual(
    results.dates.map((value) => value.result),
    Array(3).fill("1769875200000"),
  );
  assert.equal(results.compact.result, "1769875200000");
  assert.equal(results.early.result, "1971-01-01 08:00:00");
  assert.equal(results.negative.result, "1970-01-01 07:59:59");
  assert.equal(results.padded.result, "2026-02-01 00:00:00");
  assert.equal(results.fractional.result, "2026-02-01 00:00:00.500");
  assert.deepEqual(results.invalid, [null, null, null]);
});

test("timezone option controls local dates and timestamp rendering, while explicit zones stay explicit", () => {
  const script = `
    const module = { exports: {} };
    new Function("module", "exports", process.env.UTILS_COMPILED)(module, module.exports);
    const { tryConvert } = module.exports;
    console.log(JSON.stringify({
      localDate: tryConvert("2024-01-01 12:00", "date", { timeZone: "local" }),
      utcDate: tryConvert("2024-01-01 12:00", "date", { timeZone: "utc" }),
      localTimestamp: tryConvert("0", "seconds", { timeZone: "local" }),
      utcTimestamp: tryConvert("0", "seconds", { timeZone: "utc" }),
      explicit: tryConvert("2024-01-01T12:00:00+08:00", "date", { timeZone: "utc" })
    }));
  `;
  const results = runInTimeZone("Asia/Shanghai", script);
  assert.equal(results.localDate.result, "1704081600000");
  assert.equal(results.utcDate.result, "1704110400000");
  assert.equal(results.localTimestamp.result, "1970-01-01 08:00:00");
  assert.equal(results.utcTimestamp.result, "1970-01-01 00:00:00");
  assert.equal(results.explicit.result, "1704081600000");
});

test("date conversion can return exact decimal seconds, including negative subsecond epochs", () => {
  assert.equal(tryConvert("1969-12-31T23:59:59.999Z", "date", { outputUnit: "seconds" }).result, "-0.001");
  assert.equal(tryConvert("2024-01-01T00:00:00.007Z", "date", { outputUnit: "seconds" }).result, "1704067200.007");
  assert.equal(tryConvert("2024-01-01T00:00:00Z", "date", { outputUnit: "seconds" }).result, "1704067200");
  assert.equal(tryConvert("275760-09-13T00:00:00Z", "date", { outputUnit: "seconds" }).result, "8640000000000");
  assert.equal(tryConvert("2024-01-01T00:00:00.007Z", "date").outputUnit, "milliseconds");
});

test("conversion diagnostics distinguish format, range, precision, date, time, timezone, and mode errors", () => {
  const cases = [
    ["", "auto", {}, "empty_input"],
    ['{"time":123}', "auto", {}, "invalid_format"],
    ["20230231", "date", {}, "invalid_date"],
    ["2024-01-01 24:00", "date", {}, "invalid_time"],
    ["2024-01-01T12:00:00+25:00", "date", {}, "invalid_timezone"],
    ["1.0001", "seconds", {}, "sub_millisecond_precision"],
    ["1.5", "milliseconds", {}, "non_integer_milliseconds"],
    ["8640000000000001", "milliseconds", {}, "out_of_range"],
    ["999999-01-01", "date", {}, "out_of_range"],
    ["2024-01-01", "seconds", {}, "mode_mismatch"],
    ["1700000000", "date", {}, "mode_mismatch"],
  ];
  for (const [value, mode, options, code] of cases) {
    const result = convertInput(value, mode, options);
    assert.equal(result.output, null, value);
    assert.equal(result.error.code, code, value);
    assert.equal(typeof result.error.message, "string");
    assert.ok(result.error.message.length > 0);
  }
  assert.equal(convertInput("2024-01-01", "date", { timeZone: "Mars/Phobos" }).error.code, "invalid_timezone");
  assert.equal(convertBatch("bad,20230231", "date")[1].error.code, "invalid_date");
});

test("nonexistent local daylight-saving wall time is rejected but an explicit offset is accepted", () => {
  const script = `
    const module = { exports: {} };
    new Function("module", "exports", process.env.UTILS_COMPILED)(module, module.exports);
    const { convertInput } = module.exports;
    console.log(JSON.stringify({
      missing: convertInput("2024-03-10 02:30", "date", { timeZone: "local" }),
      utc: convertInput("2024-03-10 02:30", "date", { timeZone: "utc" }),
      explicit: convertInput("2024-03-10T02:30:00-05:00", "date", { timeZone: "local" })
    }));
  `;
  const results = runInTimeZone("America/New_York", script);
  assert.equal(results.missing.error.code, "invalid_time");
  assert.equal(results.utc.output.result, String(Date.UTC(2024, 2, 10, 2, 30)));
  assert.equal(results.explicit.output.result, String(Date.UTC(2024, 2, 10, 7, 30)));
});

test("unqualified ISO T timestamps with seconds and fractions stay local, while malformed zones diagnose", () => {
  const local = tryConvert("2026-02-01T00:00:00.500", "date", { timeZone: "utc" });
  const space = tryConvert("2026-02-01 00:00:00.500", "date", { timeZone: "utc" });
  assert.equal(local.result, space.result);
  assert.equal(local.result, "1769904000500");
  assert.equal(convertInput("2026-02-01T00:00:00+0800", "date").error.code, "invalid_timezone");
  assert.equal(convertInput("2026-02-01T00:00:00z", "date").error.code, "invalid_timezone");
  assert.equal(tryConvert("2026-02-01T00:00:00+08:00", "date").result, "1769875200000");
});
