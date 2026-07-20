import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { releaseConfig, root } from "./release-config.mjs";

const editions = ["small", "core", "full"];
const paths = Object.fromEntries(editions.map((edition) => [
  edition,
  resolve(root, "reports", `${edition}-${releaseConfig.dictionaryVersion}`, "entries.jsonl.gz"),
]));

await Promise.all(editions.map(async (edition) => {
  await access(paths[edition]).catch(() => {
    throw new Error(`Missing ${edition} neutral export: ${paths[edition]}`);
  });
}));

const iterators = Object.fromEntries(editions.map((edition) => [
  edition,
  createInterface({
    input: createReadStream(paths[edition]).pipe(createGunzip()),
    crlfDelay: Infinity,
  })[Symbol.asyncIterator](),
]));
const expected = Object.fromEntries(editions.map((edition) => [
  edition,
  releaseConfig.editions[edition].sourceEntries,
]));

for (let index = 0; index < expected.full; index += 1) {
  const full = await iterators.full.next();
  if (full.done) throw new Error(`Full export ended at ${index}, expected ${expected.full} records`);

  if (index < expected.core) {
    const core = await iterators.core.next();
    if (core.done) throw new Error(`Core export ended at ${index}, expected ${expected.core} records`);
    if (core.value !== full.value) throw new Error(`Core and Full differ at word ID ${index}`);
  }

  if (index < expected.small) {
    const small = await iterators.small.next();
    if (small.done) throw new Error(`Small export ended at ${index}, expected ${expected.small} records`);
    if (small.value !== full.value) throw new Error(`Small and Full differ at word ID ${index}`);
  }
}

for (const edition of editions) {
  const trailing = await iterators[edition].next();
  if (!trailing.done) throw new Error(`${edition} export exceeds ${expected[edition]} records`);
}

console.log(
  `Verified cumulative word-ID ranges: Small 0–${expected.small - 1}, ` +
  `Core ${expected.small}–${expected.core - 1}, Full ${expected.core}–${expected.full - 1}.`,
);
