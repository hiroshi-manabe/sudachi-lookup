import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "../..");
const edition = process.env.SUDACHI_EDITION ?? "core";
const version = process.env.SUDACHI_VERSION ?? "20260428";
const release = process.env.SUDACHI_RELEASE ?? `${edition}-${version}`;
const dataset = `${release}-v2`;
const directory = resolve(root, "public/data/releases", dataset);
const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));

if (manifest.formatVersion !== 2) throw new Error("Unexpected web format version");
if (manifest.dataset !== dataset) throw new Error("Manifest dataset does not match directory");
if (manifest.records.files.length !== Math.ceil(manifest.entries / manifest.records.span)) {
  throw new Error("Record shard count does not cover every entry");
}

let aliasCount = 0;
let previousLower = "";
for (const shard of manifest.searchShards) {
  if (previousLower && previousLower > shard.lower) throw new Error("Search ranges are not sorted");
  if (shard.lower > shard.upper) throw new Error(`Invalid search range in ${shard.file}`);
  const header = await readHeader(resolve(directory, shard.file));
  if (header.magic !== "SDSH" || header.version !== 2 || header.count !== shard.aliases) {
    throw new Error(`Invalid search shard header: ${shard.file}`);
  }
  aliasCount += shard.aliases;
  previousLower = shard.lower;
}
if (aliasCount !== manifest.aliases) throw new Error("Search shards do not contain every alias");

let entryCount = 0;
for (const file of manifest.records.files) {
  const header = await readHeader(resolve(directory, file));
  if (header.magic !== "SDRE" || header.version !== 2) {
    throw new Error(`Invalid record shard header: ${file}`);
  }
  entryCount += header.count;
}
if (entryCount !== manifest.entries) throw new Error("Record shards do not contain every entry");

const totalFiles = manifest.searchShards.length + manifest.records.files.length + 2;
console.log(
  `Validated ${dataset}: ${manifest.entries} entries, ${manifest.aliases} aliases, ` +
  `${totalFiles} dictionary files.`,
);

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
