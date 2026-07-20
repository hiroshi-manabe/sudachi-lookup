/// <reference lib="webworker" />

import type { DictionaryEdition, LookupResult } from "./lookup-types";
import releaseConfig from "../config/dictionary-release.json";

type Entry = Omit<LookupResult, "edition" | "splits" | "unit" | "structure"> & {
  cost: number;
  aBoundaries: number[];
  bBoundaries: number[];
  structureBoundaries: number[];
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

type StructurePosition = "first" | "last";
type StructureShard = {
  lower: number;
  upper: number;
  file: string;
  components: number;
  firstRelationships: number;
  lastRelationships: number;
  bytes: number;
  decodedBytes: number;
};
type StructureManifest = {
  compression: "gzip";
  identity: string;
  positions: ["first", "last"];
  components: number;
  firstRelationships: number;
  lastRelationships: number;
  shards: StructureShard[];
};

type DictionaryManifest = {
  formatVersion: number;
  splitEncoding: "u8-code-point-boundaries";
  headwordFilter: "dictionary-form-word-id";
  kanaRanking: "literal-script-tiebreak";
  dataset: string;
  entries: number;
  searchableEntries: number;
  filteredInflectionEntries: number;
  editionMembership: {
    identity: "minimum-sudachidict-edition-by-word-id";
    smallUpperExclusive: number;
    coreUpperExclusive: number;
  };
  aliases: number;
  posTableFile: string;
  posCount: number;
  posEncoding: "sudachi-u16";
  posCompression: "gzip";
  bootstrapFile: string;
  bootstrapPrefixes: number;
  bootstrapRecords: number;
  bootstrapCandidatePrefixes: number;
  bootstrapBytes: number;
  bootstrapDecodedBytes: number;
  bootstrapBudgetBytes: number;
  bootstrapCompression: "gzip";
  bootstrapMinSearchBytes: number;
  bootstrapMinBroadAliases: number;
  bootstrapMinDescentAliases: number;
  bootstrapMinRecordBytes: number;
  searchShards: SearchShard[];
  records: { span: number; files: string[] };
  structureMatches: StructureManifest;
};

const FORMAT_VERSION = releaseConfig.browserFormatVersion;
const DICTIONARY_BASES = ["full", "core"].map(
  (edition) => `/data/releases/${edition}-${releaseConfig.dictionaryVersion}-v${FORMAT_VERSION}`,
);
const INITIAL_RESULTS = 20;
const PAGE_RESULTS = 50;
const MAX_CODE_POINT = String.fromCodePoint(0x10ffff);

type SearchPlan = {
  variants: string[];
  initialShardFiles: string[];
  allShardFiles: string[];
  deferredFullSearch: boolean;
  bootstrapIds: number[] | null;
};

type SearchSession = {
  requestId: number;
  query: string;
  sentIds: Set<number>;
  remainingIds: number[];
  deferredFullSearch: boolean;
  kind: "text" | "structure";
};

let mode: "sample" | "sharded" = "sample";
let dictionaryBase = "";
let dictionaryManifest: DictionaryManifest | null = null;
let sampleAliases: Alias[] = [];
let posTable = new Map<number, string>();
let bootstrapResults = new Map<string, number[]>();
let entries = new Map<number, Entry>();
let searchCache = new Map<string, Promise<Alias[]>>();
let recordCache = new Map<number, Promise<void>>();
let loading: Promise<void> | null = null;
let activeRequestId = 0;
let activeSession: SearchSession | null = null;
let structureManifest: StructureManifest | null = null;
let structureCache = new Map<string, Promise<Map<number, { first: number[]; last: number[] }>>>();

self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      await ensureLoaded();
      self.postMessage({
        type: "ready",
        entries: dictionaryManifest?.searchableEntries ?? entries.size,
        aliases: dictionaryManifest?.aliases ?? sampleAliases.length,
        dataset: dictionaryManifest?.dataset ?? "sample",
      });
    }
    if (message.type === "search") {
      activeRequestId = message.requestId;
      activeSession = null;
      await ensureLoaded();
      if (message.requestId !== activeRequestId) return;
      const page = await startSearch(message.requestId, message.query);
      if (message.requestId !== activeRequestId) return;
      activeSession = page.session;
      self.postMessage({
        type: "result-slots",
        requestId: message.requestId,
        query: message.query,
        ids: page.ids,
        append: false,
        hasMore: page.hasMore,
      });
      await streamResults(page.ids, message.requestId, message.query);
    }
    if (message.type === "structure-search") {
      activeRequestId = message.requestId;
      activeSession = null;
      await ensureLoaded();
      if (message.requestId !== activeRequestId) return;
      const page = await startStructureSearch(message.requestId, message.componentId, message.position);
      if (message.requestId !== activeRequestId) return;
      activeSession = page.session;
      const component = toResult(await loadEntry(message.componentId));
      if (message.requestId !== activeRequestId) return;
      self.postMessage({
        type: "structure-component",
        requestId: message.requestId,
        component,
      });
      self.postMessage({
        type: "result-slots",
        requestId: message.requestId,
        query: "",
        ids: page.ids,
        append: false,
        hasMore: page.hasMore,
      });
      await streamResults(page.ids, message.requestId, "");
    }
    if (message.type === "more") {
      const session = activeSession;
      if (!session || message.requestId !== activeRequestId) return;
      const page = await continueSearch(session);
      if (message.requestId !== activeRequestId) return;
      self.postMessage({
        type: "result-slots",
        requestId: message.requestId,
        query: session.kind === "text" ? session.query : "",
        ids: page.ids,
        append: true,
        hasMore: page.hasMore,
      });
      await streamResults(page.ids, message.requestId, session.kind === "text" ? session.query : "");
    }
  } catch (error) {
    if (message.requestId && message.requestId !== activeRequestId) return;
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "辞書の読み込みに失敗しました",
      requestId: message.requestId,
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
    if (!response.ok || !isJsonResponse(response)) continue;
    dictionaryManifest = await response.json() as DictionaryManifest;
    if (
      dictionaryManifest.formatVersion !== FORMAT_VERSION ||
      dictionaryManifest.splitEncoding !== "u8-code-point-boundaries" ||
      dictionaryManifest.headwordFilter !== "dictionary-form-word-id" ||
      dictionaryManifest.kanaRanking !== "literal-script-tiebreak" ||
      dictionaryManifest.posEncoding !== "sudachi-u16" ||
      dictionaryManifest.posCompression !== "gzip" ||
      dictionaryManifest.bootstrapCompression !== "gzip"
    ) {
      throw new Error(`対応していない辞書形式です: ${dictionaryManifest.formatVersion}`);
    }
    dictionaryBase = base;
    structureManifest = dictionaryManifest.structureMatches;
    mode = "sharded";
    const [bootstrapResponse, posResponse] = await Promise.all([
      fetch(`${base}/${dictionaryManifest.bootstrapFile}`),
      fetch(`${base}/${dictionaryManifest.posTableFile}`),
    ]);
    if (!bootstrapResponse.ok) throw new Error("辞書の初期インデックスを読み込めませんでした");
    if (!posResponse.ok) throw new Error("辞書の品詞表を読み込めませんでした");
    const [bootstrapBuffer, posBuffer] = await Promise.all([
      decompressGzip(bootstrapResponse, "辞書の初期インデックス"),
      decompressGzip(posResponse, "辞書の品詞表"),
    ]);
    posTable = decodePosTable(posBuffer, dictionaryManifest.posCount);
    const bootstrap = decodeBootstrap(bootstrapBuffer);
    bootstrapResults = bootstrap.results;
    entries = bootstrap.entries;
    return;
  }

  const manifestResponse = await fetch("/data/sample/manifest.json");
  if (!manifestResponse.ok) throw new Error("辞書マニフェストを読み込めませんでした");
  if (!isJsonResponse(manifestResponse)) {
    throw new Error("辞書マニフェストがJSONではありません");
  }
  const manifest = await manifestResponse.json();
  structureManifest = manifest.structureMatches;
  dictionaryBase = "/data/sample";
  const [entriesResponse, indexResponse] = await Promise.all([
    fetch(`/data/sample/${manifest.entriesFile}`),
    fetch(`/data/sample/${manifest.indexFile}`),
  ]);
  if (!entriesResponse.ok || !indexResponse.ok) throw new Error("サンプル辞書を読み込めませんでした");
  entries = decodeEntries(await entriesResponse.arrayBuffer(), 2);
  sampleAliases = decodeAliases(await indexResponse.arrayBuffer(), 2);
}

function isJsonResponse(response: Response) {
  return response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
}

async function decompressGzip(response: Response, label: string) {
  if (!response.body || typeof DecompressionStream === "undefined") {
    throw new Error(`このブラウザでは${label}を展開できません`);
  }
  const decompressed = response.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressed).arrayBuffer();
}

async function startSearch(requestId: number, rawQuery: string) {
  const query = normalize(rawQuery);
  if (!query) {
    const session: SearchSession = {
      requestId, query: rawQuery, sentIds: new Set(), remainingIds: [], deferredFullSearch: false, kind: "text",
    };
    return { ids: [], hasMore: false, session };
  }

  let rankedIds: number[];
  let deferredFullSearch = false;
  if (mode === "sharded") {
    const plan = createSearchPlan(rawQuery);
    if (plan.bootstrapIds) {
      rankedIds = plan.bootstrapIds;
    } else {
      const loaded = await Promise.all(plan.initialShardFiles.map(loadSearchShard));
      rankedIds = rankCandidates(loaded, plan.variants);
    }
    deferredFullSearch = plan.deferredFullSearch;
  } else {
    rankedIds = rankSampleCandidates(queryVariants(rawQuery));
  }

  const selectedIds = rankedIds.slice(0, INITIAL_RESULTS);
  const session: SearchSession = {
    requestId,
    query: rawQuery,
    sentIds: new Set(selectedIds),
    remainingIds: rankedIds.slice(INITIAL_RESULTS),
    deferredFullSearch,
    kind: "text",
  };
  return {
    ids: selectedIds,
    hasMore: session.remainingIds.length > 0 || session.deferredFullSearch,
    session,
  };
}

async function startStructureSearch(
  requestId: number,
  componentId: number,
  position: StructurePosition,
) {
  const manifest = structureManifest;
  if (!manifest) throw new Error("構造一致データがありません");
  const shard = manifest.shards.find((item) => componentId >= item.lower && componentId <= item.upper);
  let rankedIds: number[] = [];
  if (shard) {
    const postings = await loadStructureShard(shard.file);
    rankedIds = postings.get(componentId)?.[position] ?? [];
  }
  const selectedIds = rankedIds.slice(0, INITIAL_RESULTS);
  const session: SearchSession = {
    requestId,
    query: "",
    sentIds: new Set(selectedIds),
    remainingIds: rankedIds.slice(INITIAL_RESULTS),
    deferredFullSearch: false,
    kind: "structure",
  };
  return { ids: selectedIds, hasMore: session.remainingIds.length > 0, session };
}

async function continueSearch(session: SearchSession) {
  if (session.deferredFullSearch) {
    const plan = createSearchPlan(session.query);
    const loaded = await Promise.all(plan.allShardFiles.map(loadSearchShard));
    session.remainingIds = rankCandidates(loaded, plan.variants)
      .filter((id) => !session.sentIds.has(id));
    session.deferredFullSearch = false;
  }

  const selectedIds = session.remainingIds.splice(0, PAGE_RESULTS);
  for (const id of selectedIds) session.sentIds.add(id);
  return { ids: selectedIds, hasMore: session.remainingIds.length > 0 };
}

function createSearchPlan(rawQuery: string): SearchPlan {
  const manifest = dictionaryManifest!;
  const query = normalize(rawQuery);
  const variants = queryVariants(query);
  const bootstrapIds = bootstrapResults.get(query) ?? null;
  const initialShardFiles = new Set<string>();
  const allShardFiles = new Set<string>();
  const deferredFullSearch = bootstrapIds !== null;

  for (const variant of variants) {
    const shards = routeShards(manifest.searchShards, variant);
    for (const shard of shards) allShardFiles.add(shard.file);
    if (!deferredFullSearch) {
      for (const shard of shards) initialShardFiles.add(shard.file);
    }
  }

  return {
    variants,
    initialShardFiles: [...initialShardFiles],
    allShardFiles: [...allShardFiles],
    deferredFullSearch,
    bootstrapIds,
  };
}

function rankCandidates(aliasSets: Alias[][], variants: string[]) {
  return [...collectCandidates(aliasSets, variants)]
    .sort((left, right) =>
      left[1].score - right[1].score ||
      left[1].cost - right[1].cost ||
      left[1].surfaceLength - right[1].surfaceLength ||
      left[0] - right[0],
    )
    .map(([id]) => id);
}

function rankSampleCandidates(variants: string[]) {
  return [...collectCandidates([sampleAliases], variants)]
    .map(([id, ranking]) => ({ entry: entries.get(id), ranking }))
    .filter((candidate): candidate is { entry: Entry; ranking: typeof candidate.ranking } =>
      Boolean(candidate.entry),
    )
    .sort((left, right) =>
      left.ranking.score - right.ranking.score ||
      left.entry.cost - right.entry.cost ||
      left.entry.surface.length - right.entry.surface.length ||
      left.entry.id - right.entry.id,
    )
    .map(({ entry }) => entry.id);
}

async function streamResults(selectedIds: number[], requestId: number, query: string) {
  const readyIds = selectedIds.filter((id) => entries.has(id));
  const missingIds = selectedIds.filter((id) => !entries.has(id));

  postResultBatch(readyIds, requestId, query, missingIds.length === 0);
  if (missingIds.length === 0 || mode === "sample") return;

  const manifest = dictionaryManifest!;
  const idsByShard = new Map<number, number[]>();
  for (const id of missingIds) {
    const shardIndex = Math.floor(id / manifest.records.span);
    const ids = idsByShard.get(shardIndex) ?? [];
    ids.push(id);
    idsByShard.set(shardIndex, ids);
  }

  await Promise.all([...idsByShard].map(async ([shardIndex, ids]) => {
    await loadRecordShard(shardIndex);
    if (requestId !== activeRequestId) return;
    postResultBatch(ids, requestId, query, false);
  }));

  if (requestId === activeRequestId) postResultBatch([], requestId, query, true);
}

function postResultBatch(ids: number[], requestId: number, query: string, complete: boolean) {
  self.postMessage({
    type: "result-batch",
    requestId,
    query,
    results: ids.map((id) => entries.get(id)).filter(Boolean).map((entry) => toResult(entry!)),
    complete,
  });
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
      if (!response.ok) throw new Error(`検索データを読み込めませんでした: ${file}`);
      return decodeAliases(await response.arrayBuffer(), FORMAT_VERSION);
    });
    searchCache.set(file, promise);
  }
  return promise;
}

async function loadStructureShard(file: string) {
  let promise = structureCache.get(file);
  if (!promise) {
    promise = fetch(`${dictionaryBase}/${file}`).then(async (response) => {
      if (!response.ok) throw new Error(`構造一致データを読み込めませんでした: ${file}`);
      return decodeStructureMatches(await decompressGzip(response, "構造一致データ"));
    });
    structureCache.set(file, promise);
  }
  return promise;
}

async function loadEntry(id: number) {
  const present = entries.get(id);
  if (present) return present;
  if (mode === "sample") throw new Error(`辞書データが見つかりません: ${id}`);
  const manifest = dictionaryManifest!;
  if (!Number.isInteger(id) || id < 0 || id >= manifest.entries) {
    throw new Error(`辞書データが見つかりません: ${id}`);
  }
  await loadRecordShard(Math.floor(id / manifest.records.span));
  const loaded = entries.get(id);
  if (!loaded) throw new Error(`辞書データが見つかりません: ${id}`);
  return loaded;
}

function loadRecordShard(index: number) {
  const manifest = dictionaryManifest!;
  let promise = recordCache.get(index);
  if (!promise) {
    const file = manifest.records.files[index];
    if (!file) return Promise.reject(new Error(`辞書データが見つかりません: ${index}`));
    promise = fetch(`${dictionaryBase}/${file}`).then(async (response) => {
      if (!response.ok) throw new Error(`辞書データを読み込めませんでした: ${file}`);
      for (const [id, entry] of decodeEntries(await response.arrayBuffer(), FORMAT_VERSION)) {
        entries.set(id, entry);
      }
    });
    recordCache.set(index, promise);
  }
  return promise;
}

function collectCandidates(aliasSets: Alias[][], variants: string[]) {
  const candidates = new Map<number, { score: number; cost: number; surfaceLength: number }>();
  const literalQuery = variants[0];
  for (const aliases of aliasSets) {
    for (const variant of variants) {
      let index = lowerBound(aliases, variant);
      while (index < aliases.length && aliases[index].key.startsWith(variant)) {
        const alias = aliases[index];
        const exact = alias.key === variant;
        const baseScore = (exact ? 0 : 20) + [0, 4, 2, 6][alias.kind];
        const score = baseScore * 2 + Number(variant !== literalQuery);
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

function queryVariants(rawQuery: string) {
  const query = normalize(rawQuery);
  return [...new Set([query, toHiragana(query), toKatakana(query)])];
}

function toResult(entry: Entry): LookupResult {
  const unit = entry.bBoundaries.length ? "C" : entry.aBoundaries.length ? "B" : "A";
  return {
    id: entry.id,
    surface: entry.surface,
    readingForm: entry.readingForm,
    normalizedForm: entry.normalizedForm,
    dictionaryForm: entry.dictionaryForm,
    pos: entry.pos,
    edition: editionForEntry(entry.id),
    unit,
    structure: unit === "A"
      ? [entry.surface]
      : splitSurface(entry.surface, entry.structureBoundaries),
    splits: unit === "C"
      ? {
          b: splitSurface(entry.surface, entry.bBoundaries),
          a: splitSurface(entry.surface, entry.aBoundaries),
        }
      : unit === "B"
        ? { a: splitSurface(entry.surface, entry.aBoundaries) }
        : null,
  };
}

function editionForEntry(id: number): DictionaryEdition | null {
  const membership = dictionaryManifest?.editionMembership;
  if (!membership) return null;
  if (id < membership.smallUpperExclusive) return "Small";
  if (id < membership.coreUpperExclusive) return "Core";
  return "Full";
}

function splitSurface(surface: string, boundaries: number[]) {
  if (!boundaries.length) return [surface];
  const characters = Array.from(surface);
  const segments: string[] = [];
  let start = 0;
  for (const boundary of boundaries) {
    segments.push(characters.slice(start, boundary).join(""));
    start = boundary;
  }
  segments.push(characters.slice(start).join(""));
  return segments;
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

function decodeEntries(buffer: ArrayBuffer, version: number) {
  const reader = new BinaryReader(buffer);
  reader.magic(version === 2 ? "SDLX" : "SDRE");
  reader.version(version);
  const count = reader.u32();
  const decoded = new Map<number, Entry>();
  for (let index = 0; index < count; index += 1) {
    const [id, entry] = decodeEntry(reader, version);
    decoded.set(id, entry);
  }
  reader.done();
  return decoded;
}

function decodeAliases(buffer: ArrayBuffer, version: number) {
  const reader = new BinaryReader(buffer);
  reader.magic(version === 2 ? "SDIX" : "SDSH");
  reader.version(version);
  const count = reader.u32();
  const decoded: Alias[] = [];
  for (let index = 0; index < count; index += 1) {
    const key = reader.string();
    const id = reader.u32();
    const kind = reader.u8();
    const cost = version === 2 ? 0 : reader.i16();
    const surfaceLength = version === 2 ? 0 : reader.u16();
    decoded.push({ key, id, kind, cost, surfaceLength });
  }
  reader.done();
  return decoded;
}

function decodeStructureMatches(buffer: ArrayBuffer) {
  const reader = new BinaryReader(buffer);
  reader.magic("SDSM");
  reader.version(FORMAT_VERSION);
  const count = reader.u32();
  const decoded = new Map<number, { first: number[]; last: number[] }>();
  for (let index = 0; index < count; index += 1) {
    const componentId = reader.u32();
    const firstCount = reader.u32();
    const lastCount = reader.u32();
    const first = Array.from({ length: firstCount }, () => reader.u32());
    const last = Array.from({ length: lastCount }, () => reader.u32());
    if (decoded.has(componentId)) throw new Error(`構造一致IDが重複しています: ${componentId}`);
    decoded.set(componentId, { first, last });
  }
  reader.done();
  return decoded;
}

function decodeBootstrap(buffer: ArrayBuffer) {
  const reader = new BinaryReader(buffer);
  reader.magic("SDBP");
  reader.version(FORMAT_VERSION);
  const count = reader.u32();
  const results = new Map<string, number[]>();
  for (let index = 0; index < count; index += 1) {
    const prefix = reader.string();
    const resultCount = reader.u8();
    const ids = [];
    for (let resultIndex = 0; resultIndex < resultCount; resultIndex += 1) {
      ids.push(reader.u32());
    }
    if (results.has(prefix)) throw new Error(`初期インデックスの接頭辞が重複しています: ${prefix}`);
    results.set(prefix, ids);
  }
  const recordCount = reader.u32();
  const bootstrapEntries = new Map<number, Entry>();
  for (let index = 0; index < recordCount; index += 1) {
    const [id, entry] = decodeEntry(reader, FORMAT_VERSION);
    bootstrapEntries.set(id, entry);
  }
  reader.done();
  for (const [prefix, ids] of results) {
    if (ids.some((id) => !bootstrapEntries.has(id))) {
      throw new Error(`初期インデックスに「${prefix}」の辞書データがありません`);
    }
  }
  return { results, entries: bootstrapEntries };
}

function decodeEntry(reader: BinaryReader, version: number): [number, Entry] {
  const id = reader.u32();
  const cost = version === 2 ? reader.u16() : reader.i16();
  const surface = reader.string();
  const readingForm = reader.string();
  const normalizedForm = reader.string();
  const dictionaryForm = reader.string();
  const pos = version === 2 ? reader.string() : resolvePos(reader.u16());
  const aBoundaries = reader.boundaries();
  const bBoundaries = reader.boundaries();
  const structureBoundaries = reader.boundaries();
  return [id, {
    id, cost, surface, readingForm, normalizedForm, dictionaryForm, pos,
    aBoundaries, bBoundaries, structureBoundaries,
  }];
}

function decodePosTable(buffer: ArrayBuffer, expectedCount: number) {
  const reader = new BinaryReader(buffer);
  reader.magic("SDPO");
  reader.version(FORMAT_VERSION);
  const count = reader.u32();
  if (count !== expectedCount) throw new Error("辞書の品詞数がマニフェストと一致しません");
  const decoded = new Map<number, string>();
  for (let index = 0; index < count; index += 1) {
    const id = reader.u16();
    if (decoded.has(id)) throw new Error(`辞書の品詞IDが重複しています: ${id}`);
    decoded.set(id, reader.string());
  }
  reader.done();
  return decoded;
}

function resolvePos(id: number) {
  const pos = posTable.get(id);
  if (pos === undefined) throw new Error(`辞書の品詞IDが見つかりません: ${id}`);
  return pos;
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
    if (actual !== expected) throw new Error(`辞書データの識別子が不正です: ${actual}`);
  }

  version(expected: number) {
    const version = this.u16();
    if (version !== expected) throw new Error(`対応していない辞書形式です: ${version}`);
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

  boundaries() {
    const count = this.u8();
    const values = [];
    for (let index = 0; index < count; index += 1) values.push(this.u8());
    return values;
  }

  done() {
    if (this.offset !== this.view.byteLength) throw new Error("辞書データの末尾に不正なデータがあります");
  }
}
