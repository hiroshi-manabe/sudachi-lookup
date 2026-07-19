/// <reference lib="webworker" />

import type { LookupResult } from "./lookup-types";

type Entry = Omit<LookupResult, "splits"> & {
  cost: number;
  aSplit: number[];
  bSplit: number[];
};

type Alias = {
  key: string;
  id: number;
  kind: number;
  cost: number;
  surfaceLength: number;
};

type SearchShard = {
  lower: string;
  upper: string;
  file: string;
  aliases: number;
  bytes: number;
};

type DictionaryManifest = {
  formatVersion: 2;
  dataset: string;
  entries: number;
  aliases: number;
  minFullQueryLength: number;
  bootstrapFile: string;
  bootstrapAliases: number;
  searchShards: SearchShard[];
  records: { span: number; files: string[] };
};

const DICTIONARY_BASES = [
  "/data/releases/full-20260428-v2",
  "/data/releases/core-20260428-v2",
];
const MAX_FULL_ALIASES_FOR_SHORT_QUERY = 10_000;
const MAX_RESULTS = 20;
const MAX_CODE_POINT = String.fromCodePoint(0x10ffff);

let mode: "sample" | "sharded" = "sample";
let dictionaryBase = "";
let dictionaryManifest: DictionaryManifest | null = null;
let sampleAliases: Alias[] = [];
let bootstrapAliases: Alias[] = [];
let entries = new Map<number, Entry>();
let searchCache = new Map<string, Promise<Alias[]>>();
let recordCache = new Map<number, Promise<void>>();
let loading: Promise<void> | null = null;

self.onmessage = async (event: MessageEvent) => {
  try {
    const message = event.data;
    if (message.type === "init") {
      await ensureLoaded();
      self.postMessage({
        type: "ready",
        entries: dictionaryManifest?.entries ?? entries.size,
        aliases: dictionaryManifest?.aliases ?? sampleAliases.length,
        dataset: dictionaryManifest?.dataset ?? "sample",
      });
    }
    if (message.type === "search") {
      await ensureLoaded();
      const results = mode === "sharded"
        ? await searchSharded(message.query)
        : searchSample(message.query);
      self.postMessage({
        type: "results",
        requestId: message.requestId,
        query: message.query,
        results,
      });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Dictionary loading failed",
    });
  }
};

function ensureLoaded() {
  loading ??= loadData();
  return loading;
}

async function loadData() {
  for (const base of DICTIONARY_BASES) {
    const response = await fetch(`${base}/manifest.json`);
    if (!response.ok) continue;
    dictionaryManifest = await response.json() as DictionaryManifest;
    if (dictionaryManifest.formatVersion !== 2) {
      throw new Error(`Unsupported dictionary format: ${dictionaryManifest.formatVersion}`);
    }
    dictionaryBase = base;
    mode = "sharded";
    const bootstrapResponse = await fetch(`${base}/${dictionaryManifest.bootstrapFile}`);
    if (!bootstrapResponse.ok) throw new Error("Dictionary bootstrap index could not be loaded");
    bootstrapAliases = decodeAliases(await bootstrapResponse.arrayBuffer(), 2);
    return;
  }

  const manifestResponse = await fetch("/data/sample/manifest.json");
  if (!manifestResponse.ok) throw new Error("Dictionary manifest could not be loaded");
  const manifest = await manifestResponse.json();
  const [entriesResponse, indexResponse] = await Promise.all([
    fetch(`/data/sample/${manifest.entriesFile}`),
    fetch(`/data/sample/${manifest.indexFile}`),
  ]);
  if (!entriesResponse.ok || !indexResponse.ok) throw new Error("Sample dictionary could not be loaded");
  entries = decodeEntries(await entriesResponse.arrayBuffer(), 1);
  sampleAliases = decodeAliases(await indexResponse.arrayBuffer(), 1);
}

async function searchSharded(rawQuery: string): Promise<LookupResult[]> {
  const manifest = dictionaryManifest!;
  const query = normalize(rawQuery);
  if (!query) return [];
  const variants = [...new Set([query, toHiragana(query), toKatakana(query)])];
  const shardFiles = new Set<string>();
  let useBootstrap = false;

  for (const variant of variants) {
    const shards = routeShards(manifest.searchShards, variant);
    const aliasCount = shards.reduce((total, shard) => total + shard.aliases, 0);
    if ([...variant].length < manifest.minFullQueryLength && aliasCount > MAX_FULL_ALIASES_FOR_SHORT_QUERY) {
      useBootstrap = true;
    } else {
      for (const shard of shards) shardFiles.add(shard.file);
    }
  }

  const loaded = await Promise.all([...shardFiles].map(loadSearchShard));
  const aliasSets = useBootstrap ? [bootstrapAliases, ...loaded] : loaded;
  const candidates = collectCandidates(aliasSets, variants);
  const selectedIds = [...candidates]
    .sort((left, right) =>
      left[1].score - right[1].score ||
      left[1].cost - right[1].cost ||
      left[1].surfaceLength - right[1].surfaceLength ||
      left[0] - right[0],
    )
    .slice(0, MAX_RESULTS)
    .map(([id]) => id);

  await loadRecordIds(selectedIds);
  const splitIds = selectedIds.flatMap((id) => {
    const entry = entries.get(id);
    return entry ? [...entry.aSplit, ...entry.bSplit] : [];
  });
  await loadRecordIds(splitIds);
  return selectedIds.map((id) => toResult(entries.get(id)!)).filter(Boolean);
}

function routeShards(shards: SearchShard[], query: string) {
  const upper = `${query}${MAX_CODE_POINT}`;
  return shards.filter((shard) =>
    compareCodePoints(shard.upper, query) >= 0 && compareCodePoints(shard.lower, upper) <= 0,
  );
}

async function loadSearchShard(file: string) {
  let promise = searchCache.get(file);
  if (!promise) {
    promise = fetch(`${dictionaryBase}/${file}`).then(async (response) => {
      if (!response.ok) throw new Error(`Search shard could not be loaded: ${file}`);
      return decodeAliases(await response.arrayBuffer(), 2);
    });
    searchCache.set(file, promise);
  }
  return promise;
}

async function loadRecordIds(ids: number[]) {
  const manifest = dictionaryManifest!;
  const shardIndexes = new Set(ids.map((id) => Math.floor(id / manifest.records.span)));
  await Promise.all([...shardIndexes].map((index) => {
    let promise = recordCache.get(index);
    if (!promise) {
      const file = manifest.records.files[index];
      if (!file) return Promise.reject(new Error(`Missing record shard ${index}`));
      promise = fetch(`${dictionaryBase}/${file}`).then(async (response) => {
        if (!response.ok) throw new Error(`Record shard could not be loaded: ${file}`);
        for (const [id, entry] of decodeEntries(await response.arrayBuffer(), 2)) {
          entries.set(id, entry);
        }
      });
      recordCache.set(index, promise);
    }
    return promise;
  }));
}

function collectCandidates(aliasSets: Alias[][], variants: string[]) {
  const candidates = new Map<number, { score: number; cost: number; surfaceLength: number }>();
  for (const aliases of aliasSets) {
    for (const variant of variants) {
      let index = lowerBound(aliases, variant);
      while (index < aliases.length && aliases[index].key.startsWith(variant)) {
        const alias = aliases[index];
        const exact = alias.key === variant;
        const score = (exact ? 0 : 20) + [0, 4, 2, 6][alias.kind];
        const previous = candidates.get(alias.id);
        if (!previous || score < previous.score) {
          candidates.set(alias.id, {
            score,
            cost: alias.cost,
            surfaceLength: alias.surfaceLength,
          });
        }
        index += 1;
      }
    }
  }
  return candidates;
}

function searchSample(rawQuery: string): LookupResult[] {
  const query = normalize(rawQuery);
  if (!query) return [];
  const variants = [...new Set([query, toHiragana(query), toKatakana(query)])];
  const candidates = collectCandidates([sampleAliases], variants);
  return [...candidates]
    .map(([id, ranking]) => ({ entry: entries.get(id)!, ranking }))
    .filter(({ entry }) => Boolean(entry))
    .sort((left, right) =>
      left.ranking.score - right.ranking.score ||
      left.entry.cost - right.entry.cost ||
      left.entry.surface.length - right.entry.surface.length ||
      left.entry.id - right.entry.id,
    )
    .slice(0, MAX_RESULTS)
    .map(({ entry }) => toResult(entry));
}

function toResult(entry: Entry): LookupResult {
  return {
    id: entry.id,
    surface: entry.surface,
    readingForm: entry.readingForm,
    normalizedForm: entry.normalizedForm,
    dictionaryForm: entry.dictionaryForm,
    pos: entry.pos,
    splits: entry.aSplit.length || entry.bSplit.length
      ? {
          a: resolveSplit(entry.aSplit, entry.surface),
          b: resolveSplit(entry.bSplit, entry.surface),
          c: [entry.surface],
        }
      : null,
  };
}

function resolveSplit(ids: number[], fallback: string) {
  return ids.length ? ids.map((id) => entries.get(id)?.surface ?? `#${id}`) : [fallback];
}

function lowerBound(aliases: Alias[], query: string) {
  let low = 0;
  let high = aliases.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareCodePoints(aliases[middle].key, query) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function compareCodePoints(left: string, right: string) {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index].codePointAt(0)! - rightPoints[index].codePointAt(0)!;
    if (difference) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("ja-JP").trim();
}

function toHiragana(value: string) {
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : character;
  }).join("");
}

function toKatakana(value: string) {
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x3041 && code <= 0x3096 ? String.fromCharCode(code + 0x60) : character;
  }).join("");
}

function decodeEntries(buffer: ArrayBuffer, version: 1 | 2) {
  const reader = new BinaryReader(buffer);
  reader.magic(version === 1 ? "SDLX" : "SDRE");
  reader.version(version);
  const count = reader.u32();
  const decoded = new Map<number, Entry>();
  for (let index = 0; index < count; index += 1) {
    const id = reader.u32();
    const cost = version === 1 ? reader.u16() : reader.i16();
    const surface = reader.string();
    const readingForm = reader.string();
    const normalizedForm = reader.string();
    const dictionaryForm = reader.string();
    const pos = reader.string();
    const aSplit = reader.ids();
    const bSplit = reader.ids();
    decoded.set(id, {
      id, cost, surface, readingForm, normalizedForm, dictionaryForm, pos, aSplit, bSplit,
    });
  }
  reader.done();
  return decoded;
}

function decodeAliases(buffer: ArrayBuffer, version: 1 | 2) {
  const reader = new BinaryReader(buffer);
  reader.magic(version === 1 ? "SDIX" : "SDSH");
  reader.version(version);
  const count = reader.u32();
  const decoded: Alias[] = [];
  for (let index = 0; index < count; index += 1) {
    const key = reader.string();
    const id = reader.u32();
    const kind = reader.u8();
    const cost = version === 1 ? 0 : reader.i16();
    const surfaceLength = version === 1 ? 0 : reader.u16();
    decoded.push({ key, id, kind, cost, surfaceLength });
  }
  reader.done();
  return decoded;
}

class BinaryReader {
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;
  private decoder = new TextDecoder();

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  magic(expected: string) {
    const actual = this.decoder.decode(this.bytes.subarray(this.offset, this.offset + 4));
    this.offset += 4;
    if (actual !== expected) throw new Error(`Invalid dictionary magic: ${actual}`);
  }

  version(expected: number) {
    const version = this.u16();
    if (version !== expected) throw new Error(`Unsupported dictionary format: ${version}`);
  }

  u8() {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16() {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  i16() {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  string() {
    const length = this.u16();
    const value = this.decoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  ids() {
    const count = this.u8();
    return Array.from({ length: count }, () => this.u32());
  }

  done() {
    if (this.offset !== this.view.byteLength) throw new Error("Trailing bytes in dictionary shard");
  }
}
