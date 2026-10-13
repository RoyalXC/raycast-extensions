const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildSync } = require("esbuild");
const Module = require("node:module");
const path = require("node:path");

const bundle = buildSync({
  entryPoints: [path.join(__dirname, "../src/input.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
});
const compiled = new Module("input-validation");
compiled._compile(bundle.outputFiles[0].text, "input-validation.js");
const { initializeInput, InputReadTimeoutError, prepareSearchText, withReadTimeout } = compiled.exports;

test("multiline clipboard dates keep their boundaries in the single-line search field", () => {
  assert.equal(
    prepareSearchText("2026-02-01 00:00:00\r\n2026-02-02 00:00:00\t1769875200"),
    "2026-02-01 00:00:00, 2026-02-02 00:00:00, 1769875200",
  );
  assert.equal(prepareSearchText("2026-02-01 00:00:00"), "2026-02-01 00:00:00");
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("selection takes priority even if the clipboard completes first", async () => {
  const selection = deferred();
  const received = [];
  const pending = initializeInput({
    readSelection: () => selection.promise,
    readClipboard: async () => "1769961600",
    isCurrent: () => true,
    onInput: (...args) => received.push(args),
  });
  await Promise.resolve();
  assert.deepEqual(received, []);
  selection.resolve("1769875200");
  await pending;
  assert.deepEqual(received, [["1769875200", "selection"]]);
});

test("missing or empty selection falls back to the clipboard", async () => {
  for (const readSelection of [
    async () => "  ",
    async () => {
      throw new Error("no selection");
    },
  ]) {
    const received = [];
    await initializeInput({
      readSelection,
      readClipboard: async () => "1769875200\n1769961600",
      isCurrent: () => true,
      onInput: (...args) => received.push(args),
    });
    assert.deepEqual(received, [["1769875200\n1769961600", "clipboard"]]);
  }
});

test("manual edits survive a delayed initial read", async () => {
  const selection = deferred();
  let revision = 0;
  const initialRevision = revision;
  let displayedText = "";
  const pending = initializeInput({
    readSelection: () => selection.promise,
    readClipboard: async () => "1769961600",
    isCurrent: () => revision === initialRevision,
    onInput: (text) => {
      displayedText = text;
    },
  });
  revision += 1;
  displayedText = "user input";
  selection.resolve("1769875200");
  await pending;
  assert.equal(displayedText, "user input");
});

test("an unmounted command receives no initial input", async () => {
  const selection = deferred();
  let active = true;
  const received = [];
  const pending = initializeInput({
    readSelection: () => selection.promise,
    readClipboard: async () => "1769961600",
    isCurrent: () => active,
    onInput: (...args) => received.push(args),
  });
  active = false;
  selection.resolve("1769875200");
  await pending;
  assert.deepEqual(received, []);
});

test("clipboard failure is reported only when it is needed", async () => {
  const failure = new Error("clipboard unavailable");
  const received = [];
  await initializeInput({
    readSelection: async () => "1769875200",
    readClipboard: async () => {
      throw failure;
    },
    isCurrent: () => true,
    onInput: (...args) => received.push(args),
  });
  assert.deepEqual(received, [["1769875200", "selection"]]);
  await assert.rejects(
    initializeInput({
      readSelection: async () => "",
      readClipboard: async () => {
        throw failure;
      },
      isCurrent: () => true,
      onInput: () => assert.fail("unexpected input"),
    }),
    failure,
  );
});

test("empty clipboard leaves input empty", async () => {
  for (const text of [undefined, "", "  "]) {
    await initializeInput({
      readSelection: async () => "",
      readClipboard: async () => text,
      isCurrent: () => true,
      onInput: () => assert.fail("unexpected input"),
    });
  }
});

test("selection timeout falls back to the clipboard", async () => {
  const received = [];
  await initializeInput({
    readSelection: () => new Promise(() => {}),
    readClipboard: async () => "1769875200",
    isCurrent: () => true,
    onInput: (...args) => received.push(args),
    timeoutMs: 10,
  });
  assert.deepEqual(received, [["1769875200", "clipboard"]]);
});

test("clipboard timeout is reported when fallback is needed", async () => {
  await assert.rejects(
    initializeInput({
      readSelection: async () => "",
      readClipboard: () => new Promise(() => {}),
      isCurrent: () => true,
      onInput: () => assert.fail("unexpected input"),
      timeoutMs: 10,
    }),
    InputReadTimeoutError,
  );
});

test("ready selection does not wait for clipboard and late rejection is handled", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  const cleared = [];
  global.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  global.clearTimeout = (timer) => cleared.push(timer);
  try {
    const received = [];
    let rejectClipboard;
    const clipboard = new Promise((_, reject) => {
      rejectClipboard = reject;
    });
    await initializeInput({
      readSelection: async () => "selected",
      readClipboard: () => clipboard,
      isCurrent: () => true,
      onInput: (...args) => received.push(args),
      timeoutMs: 1000,
    });
    assert.deepEqual(received, [["selected", "selection"]]);
    assert.ok(cleared.includes(1), "selection timer is cleared after success");
    assert.equal(cleared.includes(2), false, "selection returns while the clipboard read is pending");
    assert.equal(timers.length, 2);
    rejectClipboard(new Error("late clipboard failure"));
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(cleared.includes(2), "late clipboard failure is handled and its timer is cleared");
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("late selection after timeout cannot overwrite clipboard fallback", async () => {
  const selection = deferred();
  const received = [];
  await initializeInput({
    readSelection: () => selection.promise,
    readClipboard: async () => "clipboard value",
    isCurrent: () => true,
    onInput: (...args) => received.push(args),
    timeoutMs: 10,
  });
  selection.resolve("late selection");
  await Promise.resolve();
  assert.deepEqual(received, [["clipboard value", "clipboard"]]);
});

test("withReadTimeout clears its timer on success and failure", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const cleared = [];
  let nextTimer = 0;
  global.setTimeout = () => ++nextTimer;
  global.clearTimeout = (timer) => cleared.push(timer);
  try {
    assert.equal(await withReadTimeout(async () => "value", 1000), "value");
    await assert.rejects(
      withReadTimeout(async () => {
        throw new Error("read failed");
      }, 1000),
      /read failed/,
    );
    assert.deepEqual(cleared, [1, 2]);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});
