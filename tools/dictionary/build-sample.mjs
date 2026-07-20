import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { releaseConfig } from "./release-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(root, "tools/dictionary/fixtures/sample.json");
const outputDirectory = resolve(root, "public/data/sample");

export async function buildSample() {
  const entries = JSON.parse(await readFile(sourcePath, "utf8"));
  validateEntries(entries);
  const aliases = buildAliases(entries);
  const entriesBuffer = encodeEntries(entries);
  const indexBuffer = encodeAliases(aliases);
  const structureBuffer = encodeStructureMatches(entries);
  const compressedStructureBuffer = gzipSync(structureBuffer);
  const structurePostings = buildStructurePostings(entries);
  const manifest = {
    formatVersion: 2,
    dataset: "sample",
    entries: entries.length,
    aliases: aliases.length,
    entriesFile: "entries.bin",
    indexFile: "index.bin",
    structureMatches: {
      compression: "gzip",
      identity: "sample-entry-id",
      positions: ["first", "last"],
      components: structurePostings.length,
      firstRelationships: structurePostings.reduce((count, item) => count + item.first.length, 0),
      lastRelationships: structurePostings.reduce((count, item) => count + item.last.length, 0),
      shards: [{
        lower: structurePostings[0].id,
        upper: structurePostings.at(-1).id,
        file: "structure/00000.bin.gz",
        components: structurePostings.length,
        firstRelationships: structurePostings.reduce((count, item) => count + item.first.length, 0),
        lastRelationships: structurePostings.reduce((count, item) => count + item.last.length, 0),
        bytes: compressedStructureBuffer.length,
        decodedBytes: structureBuffer.length,
      }],
    },
  };

  await mkdir(outputDirectory, { recursive: true });
  await mkdir(resolve(outputDirectory, "structure"), { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, manifest.entriesFile), entriesBuffer),
    writeFile(resolve(outputDirectory, manifest.indexFile), indexBuffer),
    writeFile(resolve(outputDirectory, manifest.structureMatches.shards[0].file), compressedStructureBuffer),
    writeFile(resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);

  return { entries, aliases, manifest, entriesBuffer, indexBuffer, structureBuffer };
}

export function encodeEntries(entries) {
  const surfaces = new Map(entries.map((entry) => [entry.id, entry.surface]));
  const writer = new BinaryWriter();
  writer.magic("SDLX");
  writer.u16(2);
  writer.u32(entries.length);
  for (const entry of entries) {
    writer.u32(entry.id);
    writer.u16(entry.rank);
    writer.string(entry.surface);
    writer.string(entry.readingForm);
    writer.string(entry.normalizedForm);
    writer.string(entry.dictionaryForm);
    writer.string(entry.pos);
    writer.boundaries(splitBoundaries(entry.surface, entry.aSplit, surfaces));
    writer.boundaries(splitBoundaries(entry.surface, entry.bSplit, surfaces));
    writer.boundaries(splitBoundaries(
      entry.surface,
      entry.structure ?? (entry.bSplit.length ? entry.bSplit : entry.aSplit),
      surfaces,
    ));
  }
  return writer.finish();
}

export function encodeAliases(aliases) {
  const writer = new BinaryWriter();
  writer.magic("SDIX");
  writer.u16(2);
  writer.u32(aliases.length);
  for (const alias of aliases) {
    writer.string(alias.key);
    writer.u32(alias.id);
    writer.u8(alias.kind);
  }
  return writer.finish();
}

export function buildStructurePostings(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const postings = new Map();
  for (const entry of entries) {
    const structure = entry.structure ?? (entry.bSplit.length ? entry.bSplit : entry.aSplit);
    if (structure.length < 2) continue;
    const first = postings.get(structure[0]) ?? { id: structure[0], first: [], last: [] };
    first.first.push(entry.id);
    postings.set(first.id, first);
    const lastId = structure.at(-1);
    const last = postings.get(lastId) ?? { id: lastId, first: [], last: [] };
    last.last.push(entry.id);
    postings.set(last.id, last);
  }
  const rank = (left, right) => {
    const a = byId.get(left);
    const b = byId.get(right);
    return a.rank - b.rank || [...a.surface].length - [...b.surface].length || left - right;
  };
  return [...postings.values()].map((item) => ({
    ...item,
    first: [...new Set(item.first)].sort(rank),
    last: [...new Set(item.last)].sort(rank),
  })).sort((left, right) => left.id - right.id);
}

export function encodeStructureMatches(entries) {
  const postings = buildStructurePostings(entries);
  const writer = new BinaryWriter();
  writer.magic("SDSM");
  writer.u16(releaseConfig.browserFormatVersion);
  writer.u32(postings.length);
  for (const item of postings) {
    writer.u32(item.id);
    writer.u32(item.first.length);
    writer.u32(item.last.length);
    for (const id of item.first) writer.u32(id);
    for (const id of item.last) writer.u32(id);
  }
  return writer.finish();
}

export function splitBoundaries(surface, ids, surfaces) {
  if (!ids.length) return [];
  if (ids.length < 2) throw new Error("A split must contain at least two components");
  const surfaceLength = [...surface].length;
  let consumed = 0;
  const boundaries = [];
  for (let index = 0; index < ids.length; index += 1) {
    const component = surfaces.get(ids[index]);
    if (component === undefined) throw new Error(`Missing split component ${ids[index]}`);
    consumed += [...component].length;
    if (index + 1 < ids.length) {
      if (consumed <= (boundaries.at(-1) ?? 0) || consumed >= surfaceLength || consumed > 0xff) {
        throw new Error(`Invalid split boundary ${consumed} for ${surface}`);
      }
      boundaries.push(consumed);
    }
  }
  if (consumed !== surfaceLength) {
    throw new Error(`Split components do not cover ${surface}`);
  }
  return boundaries;
}

export function buildAliases(entries) {
  const aliases = new Map();
  for (const entry of entries) {
    const candidates = [
      [entry.surface, 0],
      [entry.dictionaryForm, 1],
      [entry.normalizedForm, 2],
      [entry.readingForm, 3],
      [toHiragana(entry.readingForm), 3],
    ];
    for (const [value, kind] of candidates) {
      const key = normalize(value);
      aliases.set(`${key}\0${entry.id}\0${kind}`, { key, id: entry.id, kind });
    }
  }
  return [...aliases.values()].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : left.id - right.id || left.kind - right.kind,
  );
}

function validateEntries(entries) {
  const ids = new Set(entries.map((entry) => entry.id));
  if (ids.size !== entries.length) throw new Error("Fixture entry IDs must be unique");
  for (const entry of entries) {
    for (const splitId of [...entry.aSplit, ...entry.bSplit, ...(entry.structure ?? [])]) {
      if (!ids.has(splitId)) throw new Error(`Entry ${entry.id} references missing split ${splitId}`);
    }
  }
}

function normalize(value) {
  return value.normalize("NFKC").toLocaleLowerCase("ja-JP").trim();
}

function toHiragana(value) {
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : character;
  }).join("");
}

class BinaryWriter {
  constructor() {
    this.parts = [];
    this.encoder = new TextEncoder();
  }

  magic(value) {
    this.parts.push(this.encoder.encode(value));
  }

  u8(value) {
    const buffer = new Uint8Array(1);
    new DataView(buffer.buffer).setUint8(0, value);
    this.parts.push(buffer);
  }

  u16(value) {
    const buffer = new Uint8Array(2);
    new DataView(buffer.buffer).setUint16(0, value, true);
    this.parts.push(buffer);
  }

  u32(value) {
    const buffer = new Uint8Array(4);
    new DataView(buffer.buffer).setUint32(0, value, true);
    this.parts.push(buffer);
  }

  string(value) {
    const bytes = this.encoder.encode(value);
    if (bytes.length > 0xffff) throw new Error("String exceeds format limit");
    this.u16(bytes.length);
    this.parts.push(bytes);
  }

  boundaries(values) {
    if (values.length > 0xff) throw new Error("Split exceeds format limit");
    this.u8(values.length);
    for (const value of values) this.u8(value);
  }

  finish() {
    const length = this.parts.reduce((total, part) => total + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of this.parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildSample();
  console.log(
    `Built ${result.manifest.entries} entries and ${result.manifest.aliases} aliases ` +
    `(${result.entriesBuffer.length + result.indexBuffer.length} bytes).`,
  );
}
