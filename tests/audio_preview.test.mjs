import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../audio-preview.html"), "utf8");
function between(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, "missing source boundary: " + from);
  return source.slice(a, b);
}
const helpers = between("function csvEsc(", "async function exportCrate()");
const exporter = between("async function exportToDir()", "function saveCsvOnly()");
function harness(crate, directory) {
  const messages = [];
  const api = new Function("crate", "window", "alert",
    helpers + "\n" + exporter + "\nreturn { exportToDir, uniqueName, csvEsc, crateRows };"
  )(crate, { showDirectoryPicker: async () => directory }, msg => messages.push(msg));
  return { ...api, messages };
}
function fakeDirectory(existing, onWrite = () => {}) {
  return {
    async *entries() {
      for(const name of existing.keys()) yield [name, {}];
    },
    async getFileHandle(name, options) {
      assert.equal(options.create, true);
      if(!existing.has(name)) existing.set(name, null);
      return {
        async createWritable() {
          return {
            async write(value) { existing.set(name, value); onWrite(name); },
            async close() {}
          };
        }
      };
    }
  };
}

test("export never overwrites existing files or crate.csv", async () => {
  const files = new Map([
    ["VOICE.WAV", "old wave"],
    ["crate.csv", "old index"],
    ["voice (2).wav", "old second"],
    ["folder", "old folder"]
  ]);
  const original = new Map(files);
  const crate = [
    { name: "voice.wav", path: "a/voice.wav", memo: "=HYPERLINK(1)", file: "new wave" },
    { name: "voice.wav", path: "b/voice.wav", memo: "comparison", file: "new wave 2" }
  ];
  const { exportToDir, messages } = harness(crate, fakeDirectory(files));
  await exportToDir();
  for(const [name, value] of original) assert.equal(files.get(name), value, "overwritten: " + name);
  assert.equal(files.get("voice (3).wav"), "new wave");
  assert.equal(files.get("voice (4).wav"), "new wave 2");
  const csv = files.get("crate (2).csv");
  assert.match(csv, /a\/voice.wav/);
  assert.match(csv, /b\/voice.wav/);
  assert.match(csv, /'=HYPERLINK\(1\)/);
  assert.match(messages[0], /기존 파일 유지/);
});

test("export snapshots crate order during asynchronous writes", async () => {
  const crate = [
    { name: "a.wav", path: "a.wav", memo: "", file: "A" },
    { name: "b.wav", path: "b.wav", memo: "", file: "B" }
  ];
  const files = new Map();
  const dir = fakeDirectory(files, name => { if(name === "a.wav") crate.pop(); });
  const { exportToDir } = harness(crate, dir);
  await exportToDir();
  assert.equal(files.get("a.wav"), "A");
  assert.equal(files.get("b.wav"), "B");
  assert.match(files.get("crate.csv"), /b.wav/);
});

test("CSV spreadsheet formulas and quotes are escaped", () => {
  const { csvEsc, uniqueName } = harness([], fakeDirectory(new Map()));
  assert.equal(csvEsc("+SUM(1,2)"), "'+SUM(1,2)");
  assert.equal(csvEsc("-1+1"), "'-1+1");
  assert.equal(csvEsc('name "quoted"'), '"name ""quoted"""');
  const used = new Set(["file.wav"]);
  assert.equal(uniqueName("File.wav", used), "File (2).wav");
});

test("playback controls and crate actions remain available", () => {
  for(const mode of ["once", "continue", "repeat"]) {
    assert.match(source, new RegExp('data-mode="' + mode + '"'));
  }
  for(const id of ["prev", "play", "next", "rate-select", "status"]) {
    assert.match(source, new RegExp('id="' + id + '"'));
  }
  for(const action of ["playCrateItem", "moveCrate", "syncCrateQueue", "updateNavigation"]) {
    assert.ok(source.includes("function " + action + "("));
  }
});
