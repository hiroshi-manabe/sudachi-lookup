import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSample } from "../tools/dictionary/build-sample.mjs";

test("builds a deterministic binary sample with valid split references", async () => {
  const first = await buildSample();
  const second = await buildSample();

  assert.equal(first.entries.length, 29);
  assert.ok(first.aliases.length > first.entries.length);
  assert.deepEqual(first.entriesBuffer, second.entriesBuffer);
  assert.deepEqual(first.indexBuffer, second.indexBuffer);

  const electionCommittee = first.entries.find((entry) => entry.surface === "選挙管理委員会");
  assert.deepEqual(electionCommittee.aSplit, [1, 2, 3, 4]);
  assert.deepEqual(electionCommittee.bSplit, [1, 2, 5]);

  const index = await readFile("public/data/sample/index.bin");
  assert.equal(index.subarray(0, 4).toString("utf8"), "SDIX");
});

test("indexes normalized, dictionary, and both kana reading forms", async () => {
  const { aliases } = await buildSample();
  const keys = new Set(aliases.map((alias) => alias.key));

  assert.ok(keys.has("付属"));
  assert.ok(keys.has("食べる"));
  assert.ok(keys.has("センキョカンリイインカイ"));
  assert.ok(keys.has("せんきょかんりいいんかい"));
  assert.ok(keys.has("summer"));
  assert.ok(keys.has("今日"));
  assert.ok(keys.has("きょう"));
  assert.ok(keys.has("こんにち"));
});
