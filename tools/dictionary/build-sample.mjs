import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(root, "tools/dictionary/fixtures/sample.json");
const outputDirectory = resolve(root, "public/data/sample");

export async function buildSample() {
  const entries = JSON.parse(await readFile(sourcePath, "utf8"));
  validateEntries(entries);
  const aliases = buildAliases(entries);
  const entriesBuffer = encodeEntries(entries);
  const indexBuffer = encodeAliases(aliases);
  const manifest = {
    formatVersion: 1,
    dataset: "sample",
    entries: entries.length,
    aliases: aliases.length,
    entriesFile: "entries.bin",
    indexFile: "index.bin",
  };

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, manifest.entriesFile), entriesBuffer),
    writeFile(resolve(outputDirectory, manifest.indexFile), indexBuffer),
    writeFile(resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);

  return { entries, aliases, manifest, entriesBuffer, indexBuffer };
}

export function encodeEntries(entries) {
  const writer = new BinaryWriter();
  writer.magic("SDLX");
  writer.u16(1);
  writer.u32(entries.length);
  for (const entry of entries) {
    writer.u32(entry.id);
    writer.u16(entry.rank);
    writer.string(entry.surface);
    writer.string(entry.readingForm);
    writer.string(entry.normalizedForm);
    writer.string(entry.dictionaryForm);
    writer.string(entry.pos);
    writer.ids(entry.aSplit);
    writer.ids(entry.bSplit);
  }
  return writer.finish();
}

export function encodeAliases(aliases) {
  const writer = new BinaryWriter();
  writer.magic("SDIX");
  writer.u16(1);
  writer.u32(aliases.length);
  for (const alias of aliases) {
    writer.string(alias.key);
    writer.u32(alias.id);
    writer.u8(alias.kind);
  }
  return writer.finish();
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
    for (const splitId of [...entry.aSplit, ...entry.bSplit]) {
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

  ids(values) {
    if (values.length > 0xff) throw new Error("Split exceeds format limit");
    this.u8(values.length);
    for (const value of values) this.u32(value);
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
