import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";
import { datasetName, releaseConfig, root, selectedEdition } from "./release-config.mjs";

const edition = selectedEdition();
const formatVersion = releaseConfig.browserFormatVersion;
const dataset = datasetName(edition);
const directory = resolve(root, "public/data/releases", dataset);
const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));

if (manifest.formatVersion !== formatVersion) throw new Error("Unexpected web format version");
if (manifest.splitEncoding !== "u8-code-point-boundaries") {
  throw new Error("Unexpected split encoding");
}
if (manifest.headwordFilter !== "dictionary-form-word-id") {
  throw new Error("Unexpected headword filter");
}
if (manifest.kanaRanking !== "literal-script-tiebreak") {
  throw new Error("Unexpected kana ranking");
}
if (manifest.posEncoding !== "sudachi-u16") throw new Error("Unexpected POS encoding");
if (manifest.posCompression !== "gzip") throw new Error("Unexpected POS compression");
const posFile = await readFile(resolve(directory, manifest.posTableFile));
if (posFile.byteLength !== manifest.posTableBytes) throw new Error("POS byte count does not match");
const posDecoded = gunzipSync(posFile);
if (posDecoded.byteLength !== manifest.posTableDecodedBytes) {
  throw new Error("Decoded POS byte count does not match");
}
const posIds = validatePosTable(posDecoded, manifest.posCount);
if (manifest.searchableEntries + manifest.filteredInflectionEntries !== manifest.entries) {
  throw new Error("Headword counts do not cover every source record");
}
if (manifest.dataset !== dataset) throw new Error("Manifest dataset does not match directory");
if (manifest.records.files.length !== Math.ceil(manifest.entries / manifest.records.span)) {
  throw new Error("Record shard count does not cover every entry");
}
if (manifest.bootstrapCompression !== "gzip") throw new Error("Unexpected bootstrap compression");
const bootstrapFile = await readFile(resolve(directory, manifest.bootstrapFile));
const bootstrapBytes = bootstrapFile.byteLength;
if (bootstrapBytes !== manifest.bootstrapBytes) throw new Error("Bootstrap byte count does not match");
const bootstrapDecoded = gunzipSync(bootstrapFile);
if (bootstrapDecoded.byteLength !== manifest.bootstrapDecodedBytes) {
  throw new Error("Decoded bootstrap byte count does not match");
}
if (bootstrapDecoded.byteLength > manifest.bootstrapBudgetBytes) {
  throw new Error("Bootstrap exceeds decoded byte budget");
}
if (
  bootstrapDecoded.toString("utf8", 0, 4) !== "SDBP" ||
  bootstrapDecoded.readUInt16LE(4) !== formatVersion ||
  bootstrapDecoded.readUInt32LE(6) !== manifest.bootstrapPrefixes
) {
  throw new Error("Invalid bootstrap header");
}
validateBootstrap(bootstrapDecoded, manifest, posIds);

let aliasCount = 0;
let previousLower = "";
for (const shard of manifest.searchShards) {
  if (previousLower && previousLower > shard.lower) throw new Error("Search ranges are not sorted");
  if (shard.lower > shard.upper) throw new Error(`Invalid search range in ${shard.file}`);
  const header = await readHeader(resolve(directory, shard.file));
  if (header.magic !== "SDSH" || header.version !== formatVersion || header.count !== shard.aliases) {
    throw new Error(`Invalid search shard header: ${shard.file}`);
  }
  aliasCount += shard.aliases;
  previousLower = shard.lower;
}
if (aliasCount !== manifest.aliases) throw new Error("Search shards do not contain every alias");

let entryCount = 0;
for (const file of manifest.records.files) {
  entryCount += await validateRecordShard(resolve(directory, file), entryCount, posIds);
}
if (entryCount !== manifest.entries) throw new Error("Record shards do not contain every entry");

const structureTotals = await validateStructureMatches(manifest.structureMatches, manifest.entries);
if (
  structureTotals.components !== manifest.structureMatches.components ||
  structureTotals.first !== manifest.structureMatches.firstRelationships ||
  structureTotals.last !== manifest.structureMatches.lastRelationships
) throw new Error("Structure Match totals do not match the manifest");

const totalFiles = manifest.searchShards.length + manifest.records.files.length +
  manifest.structureMatches.shards.length + 3;
console.log(
  `Validated ${dataset}: ${manifest.searchableEntries} searchable entries, ` +
  `${manifest.aliases} aliases, ` +
  `${manifest.bootstrapPrefixes} bootstrap prefixes in ${manifest.bootstrapBytes} bytes, ` +
  `${structureTotals.components} Structure Match components, ` +
  `${totalFiles} dictionary files.`,
);

async function validateStructureMatches(structure, entryCount) {
  if (structure.compression !== "gzip") throw new Error("Unexpected Structure Match compression");
  if (structure.identity !== "canonical-dictionary-form-word-id") {
    throw new Error("Unexpected Structure Match identity");
  }
  if (structure.positions.join(",") !== "first,last") throw new Error("Unexpected Structure Match positions");
  let previousUpper = -1;
  let components = 0;
  let first = 0;
  let last = 0;
  for (const shard of structure.shards) {
    if (shard.lower <= previousUpper || shard.lower > shard.upper) {
      throw new Error(`Invalid Structure Match range: ${shard.file}`);
    }
    const compressed = await readFile(resolve(directory, shard.file));
    if (compressed.byteLength !== shard.bytes) throw new Error(`Structure Match byte count differs: ${shard.file}`);
    const bytes = gunzipSync(compressed);
    if (bytes.byteLength !== shard.decodedBytes) throw new Error(`Decoded Structure Match size differs: ${shard.file}`);
    if (bytes.toString("utf8", 0, 4) !== "SDSM" || bytes.readUInt16LE(4) !== formatVersion) {
      throw new Error(`Invalid Structure Match header: ${shard.file}`);
    }
    const count = bytes.readUInt32LE(6);
    if (count !== shard.components) throw new Error(`Structure Match component count differs: ${shard.file}`);
    let offset = 10;
    let previousComponent = -1;
    let shardFirst = 0;
    let shardLast = 0;
    for (let index = 0; index < count; index += 1) {
      const component = bytes.readUInt32LE(offset);
      const firstCount = bytes.readUInt32LE(offset + 4);
      const lastCount = bytes.readUInt32LE(offset + 8);
      offset += 12;
      if (component <= previousComponent || component >= entryCount) throw new Error(`Invalid Structure Match component ${component}`);
      const seenFirst = new Set();
      const seenLast = new Set();
      for (let relation = 0; relation < firstCount; relation += 1) {
        const parent = bytes.readUInt32LE(offset);
        offset += 4;
        if (parent >= entryCount || seenFirst.has(parent)) throw new Error(`Invalid first Structure Match parent ${parent}`);
        seenFirst.add(parent);
      }
      for (let relation = 0; relation < lastCount; relation += 1) {
        const parent = bytes.readUInt32LE(offset);
        offset += 4;
        if (parent >= entryCount || seenLast.has(parent)) throw new Error(`Invalid last Structure Match parent ${parent}`);
        seenLast.add(parent);
      }
      shardFirst += firstCount;
      shardLast += lastCount;
      previousComponent = component;
    }
    if (offset !== bytes.length) throw new Error(`Trailing Structure Match bytes: ${shard.file}`);
    if (previousComponent !== shard.upper || shardFirst !== shard.firstRelationships || shardLast !== shard.lastRelationships) {
      throw new Error(`Structure Match shard metadata differs: ${shard.file}`);
    }
    components += count;
    first += shardFirst;
    last += shardLast;
    previousUpper = shard.upper;
  }
  return { components, first, last };
}

async function readHeader(path) {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(10);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) throw new Error(`Truncated binary header: ${path}`);
    return {
      magic: bytes.toString("utf8", 0, 4),
      version: bytes.readUInt16LE(4),
      count: bytes.readUInt32LE(6),
    };
  } finally {
    await file.close();
  }
}

function validateBootstrap(bytes, manifest, posIds) {
  const count = bytes.readUInt32LE(6);
  let offset = 10;
  let previousPrefix = "";
  const prefixes = new Set();
  const referencedIds = new Set();
  for (let index = 0; index < count; index += 1) {
    const prefixLength = bytes.readUInt16LE(offset);
    offset += 2;
    const prefix = bytes.toString("utf8", offset, offset + prefixLength);
    offset += prefixLength;
    if (!prefix || (previousPrefix && previousPrefix >= prefix)) {
      throw new Error("Bootstrap prefixes are empty, duplicated, or unsorted");
    }
    prefixes.add(prefix);
    const resultCount = bytes.readUInt8(offset);
    offset += 1;
    if (!resultCount || resultCount > 20) throw new Error(`Invalid bootstrap result count for ${prefix}`);
    const ids = new Set();
    for (let resultIndex = 0; resultIndex < resultCount; resultIndex += 1) {
      const id = bytes.readUInt32LE(offset);
      offset += 4;
      if (id >= manifest.entries || ids.has(id)) throw new Error(`Invalid bootstrap result for ${prefix}`);
      ids.add(id);
      referencedIds.add(id);
    }
    previousPrefix = prefix;
  }
  const recordCount = bytes.readUInt32LE(offset);
  offset += 4;
  if (recordCount !== manifest.bootstrapRecords) throw new Error("Bootstrap record count does not match");
  const recordIds = new Set();
  const readString = () => {
    const length = bytes.readUInt16LE(offset);
    offset += 2;
    const value = bytes.toString("utf8", offset, offset + length);
    offset += length;
    return value;
  };
  for (let index = 0; index < recordCount; index += 1) {
    const id = bytes.readUInt32LE(offset);
    offset += 4;
    if (id >= manifest.entries || recordIds.has(id)) throw new Error("Invalid bootstrap record ID");
    recordIds.add(id);
    offset += 2; // cost
    const surface = readString();
    readString(); // reading
    readString(); // normalized form
    readString(); // dictionary form
    const posId = bytes.readUInt16LE(offset);
    offset += 2;
    if (!posIds.has(posId)) throw new Error(`Unknown bootstrap POS ID ${posId}`);
    const surfaceLength = Array.from(surface).length;
    for (let split = 0; split < 3; split += 1) {
      const boundaryCount = bytes.readUInt8(offset);
      offset += 1;
      let previous = 0;
      for (let boundaryIndex = 0; boundaryIndex < boundaryCount; boundaryIndex += 1) {
        const boundary = bytes.readUInt8(offset);
        offset += 1;
        if (boundary <= previous || boundary >= surfaceLength) {
          throw new Error(`Invalid bootstrap split boundary for record ${id}`);
        }
        previous = boundary;
      }
    }
  }
  for (const id of referencedIds) {
    if (!recordIds.has(id)) throw new Error(`Bootstrap result ${id} has no embedded record`);
  }
  if (edition === "core") {
    for (const prefix of ["い", "イ", "あい", "アイ", "あお", "アオ", "あきの", "アキノ"]) {
      if (!prefixes.has(prefix)) throw new Error(`Required Core bootstrap prefix is missing: ${prefix}`);
    }
  }
  if (offset !== bytes.length) throw new Error("Trailing bytes in bootstrap index");
}

async function validateRecordShard(path, firstExpectedId, posIds) {
  const bytes = await readFile(path);
  let offset = 0;
  const magic = bytes.toString("utf8", offset, offset + 4);
  offset += 4;
  const version = bytes.readUInt16LE(offset);
  offset += 2;
  const count = bytes.readUInt32LE(offset);
  offset += 4;
  if (magic !== "SDRE" || version !== formatVersion) throw new Error(`Invalid record shard header: ${path}`);

  const readString = () => {
    const length = bytes.readUInt16LE(offset);
    offset += 2;
    const value = bytes.toString("utf8", offset, offset + length);
    offset += length;
    return value;
  };
  const readBoundaries = (surfaceLength) => {
    const length = bytes.readUInt8(offset);
    offset += 1;
    let previous = 0;
    for (let index = 0; index < length; index += 1) {
      const boundary = bytes.readUInt8(offset);
      offset += 1;
      if (boundary <= previous || boundary >= surfaceLength) {
        throw new Error(`Invalid split boundary ${boundary} in ${path}`);
      }
      previous = boundary;
    }
  };

  for (let index = 0; index < count; index += 1) {
    const id = bytes.readUInt32LE(offset);
    offset += 4;
    if (id !== firstExpectedId + index) throw new Error(`Unexpected record ID ${id} in ${path}`);
    offset += 2; // cost
    const surface = readString();
    readString(); // reading
    readString(); // normalized form
    readString(); // dictionary form
    const posId = bytes.readUInt16LE(offset);
    offset += 2;
    if (!posIds.has(posId)) throw new Error(`Unknown POS ID ${posId} in ${path}`);
    const surfaceLength = Array.from(surface).length;
    readBoundaries(surfaceLength);
    readBoundaries(surfaceLength);
    readBoundaries(surfaceLength);
  }
  if (offset !== bytes.length) throw new Error(`Trailing bytes in record shard: ${path}`);
  return count;
}

function validatePosTable(bytes, expectedCount) {
  if (
    bytes.toString("utf8", 0, 4) !== "SDPO" ||
    bytes.readUInt16LE(4) !== formatVersion ||
    bytes.readUInt32LE(6) !== expectedCount
  ) {
    throw new Error("Invalid POS table header");
  }
  let offset = 10;
  const ids = new Set();
  for (let index = 0; index < expectedCount; index += 1) {
    const id = bytes.readUInt16LE(offset);
    offset += 2;
    if (ids.has(id)) throw new Error(`Duplicate POS ID ${id}`);
    ids.add(id);
    const length = bytes.readUInt16LE(offset);
    offset += 2 + length;
  }
  if (offset !== bytes.length) throw new Error("Trailing bytes in POS table");
  return ids;
}
