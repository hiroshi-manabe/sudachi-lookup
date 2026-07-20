# Sudachi Lookup: Product and Architecture Specification

## 1. Purpose

Sudachi Lookup will make the Sudachi Japanese lexicon searchable without a
server-side search service. Once the static application and relevant data
shards have been downloaded, queries stay inside the browser.

The defining interaction is immediate lookup while typing. A result that is a
Sudachi C unit can be expanded to show its B and A segmentation, for example:

```text
A  選挙 / 管理 / 委員 / 会
B  選挙 / 管理 / 委員会
C  選挙管理委員会
```

This is a lexicon browser, not initially a general-purpose morphological
analyzer for arbitrary sentences. Full tokenization can be considered later,
but it should not complicate the first data format or delivery model.

## 2. Goals

- Run search and ranking entirely in the browser.
- Update results quickly enough to follow normal typing and Japanese IME use.
- Search surface, dictionary, normalized, and reading forms.
- Match readings entered in either hiragana or katakana.
- Preserve homographs and other distinct Sudachi dictionary records.
- Present A, B, and C segmentation using Sudachi's own split metadata.
- Deploy as immutable static assets on Cloudflare Pages.
- Make dictionary generation reproducible from a pinned upstream release.
- Keep initial transfer, incremental transfer, and browser memory bounded.

## 3. Non-goals for the first release

- Arbitrary substring, typo-tolerant, or semantic search
- Server-side APIs, authentication, accounts, or synchronized history
- Editing or maintaining user dictionaries in the browser
- Reimplementing the complete Sudachi tokenizer in JavaScript
- Shipping all SudachiDict editions on the first deployment
- Treating surface text as a unique dictionary identifier

## 4. Key decisions

### 4.1 Generate a lookup-specific dataset

The deployed data will be an offline derivative of a pinned SudachiDict
release, not the original compiled dictionary. The lookup product needs sorted
search keys and random access to entry details; it does not need the tokenizer's
connection matrix and every runtime structure.

This separation also avoids relying on an unfinished browser-WASM path. As of
July 2026, browser and JavaScript-environment support remains an open request in
the sudachi.rs project:
[sudachi.rs issue list](https://github.com/WorksApplications/sudachi.rs/issues).

### 4.2 Use compact binary shards, not JavaScript or JSON records

Large JavaScript modules force the browser to parse source code and allocate a
large object graph. JSON has similar allocation costs and repeats field names
and strings. The production format should instead use `ArrayBuffer`, typed
arrays, integer offsets, shared string tables, and variable-length integers
where measurements show a benefit.

The first prototype may use MessagePack or CBOR to establish correctness.
Before stabilizing the format, compare that output with a small custom binary
encoding. The custom format is justified only if it materially reduces bytes,
decode time, or memory.

### 4.3 Route prefix queries to bounded static files

A single database or monolithic index makes first-load performance depend on
downloading most or all of the corpus. Instead, search assets will be partitioned
by normalized leading characters and subdivided until each compressed shard is
below a configured size ceiling.

The routing scheme must be prefix-preserving. Hash-sharding the search keys
would distribute a prefix query across every shard and is therefore unsuitable.

### 4.4 Preserve Sudachi word identities and resolve browser split boundaries

Sudachi can contain multiple entries with the same surface. Each extracted
dictionary record therefore receives an internal stable ID derived from the
pinned input, while UI-level grouping remains optional.

Sudachi WordInfo exposes Structure and A- and B-unit split data. The extraction
stage preserves those relationships as word IDs for validation. Browser format
v4 resolves them to compact cumulative code-point boundaries within the parent
surface, avoiding component-record requests while retaining Sudachi's authored
segmentation. The encoding and measured invariants are documented in
[Compact Split Boundary Format](split-boundary-format.md). The available
upstream fields are documented in
[SudachiPy WordInfo subsetting](https://worksapplications.github.io/sudachi.rs/python/topics/subsetting.html).

### 4.5 Use SudachiDict Core first

Core should provide enough breadth to validate search quality and storage
behavior without beginning with the largest edition. Small and Full can later
be generated from the same pipeline and offered as deployment choices or
optional data packs.

The subsequent Full feasibility run showed that the same v3 pipeline produces
4,293 Full dictionary files and keeps every file below 1 MiB raw. Core and Full
together remain below the Cloudflare Pages Free-plan file allowance. Pages is
therefore the default host for both editions; object storage is a contingency,
not a prerequisite.

### 4.6 Publish canonical headwords, not tokenizer inflection records

The neutral export remains a lossless representation of the pinned Sudachi
lexicon, while browser-data format v5 exposes canonical dictionary-form
identities rather than every conjugation-state record used during tokenization.
Filtering uses the upstream dictionary-form word ID and preserves distinct
homographs; surface-string grouping is insufficient. Browser record shards
remain lossless in Stage 1, so record compaction can be evaluated separately.
The staged policy and its validation requirements are defined in
[Canonical Headword Filtering](canonical-headword-filtering.md).

## 5. Logical data model

The following TypeScript describes semantics, not the on-disk encoding:

```ts
type EntryId = number

interface Entry {
  id: EntryId
  sourceWordId: number
  canonicalSourceWordId: number
  surface: string
  normalizedForm: string
  dictionaryForm: string
  readingForm: string
  posId: number
  structureBoundaries: number[]
  aBoundaries: number[]
  bBoundaries: number[]
  synonymGroupIds?: number[]
  rankingSignal?: number
}

interface SearchAlias {
  key: string
  entryId: EntryId
  kind: "surface" | "dictionary" | "normalized" | "reading"
}
```

Boundary arrays are empty when the corresponding segmentation is absent. Each
value is a cumulative Unicode code-point offset in the parent surface. The
offline generator validates the original referenced word IDs and component
lengths before emitting one-byte browser boundaries. Component labels are
reconstructed from the parent surface, preserving contextual capitalization and
orthography without fetching referenced records.

Format v9 preserves Sudachi's original `u16` POS ID in every browser record.
One gzip-compressed `pos.bin.gz` table maps the used IDs to their full joined
component strings. The Worker loads it alongside the bootstrap and resolves
record IDs to shared JavaScript strings, so the UI contract remains unchanged.
Empty or identical forms may still be represented as references to `surface`
rather than duplicate strings in a future format.

## 6. Query normalization

At index-generation time, emit aliases for the useful Sudachi forms. At query
time:

1. Apply Unicode NFKC normalization.
2. Lowercase Latin text consistently with the index generator.
3. Retain the normalized literal query for surface lookup.
4. Produce katakana and hiragana variants for reading lookup.
5. Avoid transliteration from romaji in the first release unless user testing
   demonstrates a need.

Sudachi performs NFKC-based input normalization and stores dictionary-specific
normalized forms. Indexing the provided normalized form is necessary; applying
NFKC alone is not equivalent to Sudachi normalization. See the
[Sudachi project documentation](https://github.com/WorksApplications/Sudachi#normalized-form).

IME composition events must be handled explicitly. The interface should not
continually replace results based on unstable intermediate composition text
unless testing shows that behavior is useful.

## 7. Search index

### 7.1 Two-tier lookup

Some Japanese prefixes represent very large portions of the dictionary even
after more than one character. Loading their complete postings would make those
keystrokes disproportionately slow.

The application will therefore use two tiers:

1. **Bootstrap suggestions:** a small eagerly loaded index containing the
   precomputed top 20 results and their display records for prefixes whose full
   search is expensive.
2. **Full prefix shards:** lazily loaded sorted aliases for queries long enough
   to route to a reasonably bounded data partition, or when the user continues
   beyond the bootstrap results for a broad query.

Format v7 introduced bootstrap selection from generated cost statistics rather
than query length, and formats v8 and v9 retain that model. A prefix is eligible
either when it matches at least 500 aliases
and routes at least 192 KiB of search data, or when its initial results require
at least 1 MiB of record shards. The generator explores branches down to 100
matching aliases so record-scattered queries such as `あきの` can qualify.
Eligible prefixes are prioritized by the combined search- and record-shard
transfer they avoid, then encoded under the current hard 2.5 MiB decoded budget. Records
shared by multiple prefixes are stored only once. The bootstrap itself is gzip
compressed for transfer and decompressed in the Worker. Hiragana and katakana
spellings have distinct bootstrap keys and rankings. Both bootstrap and live
shard ranking treat the literal query script as a tie-breaker after exactness
and alias kind, so `あま` prefers otherwise equal hiragana surfaces while
`アマ` prefers katakana. Continuation still expands into complete prefix shards.

### 7.2 Shard routing

The manifest maps a query prefix to one or more files. A conceptual layout is:

```text
public/data/
  manifest.json
  20260428-core-v1/
    bootstrap.ab12cd.bin
    pos.0237a1.bin
    search/
      せん.40f1be.bin
      選挙.249a91.bin
    records/
      000.92dba2.bin
      001.88ea31.bin
    notices/
      NOTICE.txt
      LICENSE-2.0.txt
```

Logical prefixes must be converted to portable, URL-safe filenames or opaque
IDs in the final implementation. Human-readable names above are illustrative.

The build process starts with leading-character partitions, measures their
compressed sizes, and recursively subdivides large partitions. The target is a
bounded transfer such as 100–300 KiB compressed per query shard, subject to
prototype results.

### 7.3 Posting contents

Search postings should include enough information to rank and render the first
result frame without fetching all entry details. Candidate fields include:

- Entry ID
- Display surface reference
- Reading reference
- POS ID
- Alias kind
- Ranking signal

Full normalized and dictionary forms, synonym groups, and split references can
remain in record shards loaded after a result is selected or expanded.

### 7.4 Ranking

The initial deterministic ordering should prioritize:

1. Exact surface match
2. Exact dictionary- or normalized-form match
3. Surface prefix match
4. Exact reading match
5. Reading prefix match
6. The literal hiragana or katakana script, when match strength is otherwise
   equal
7. Shorter surface forms
8. A trustworthy dictionary cost or frequency-like signal, if extraction and
   interpretation are validated
9. Stable entry ID as the final tie-breaker

Aliases pointing to the same entry are merged before rendering. Entries with
the same surface but different linguistic records must not be silently lost.

## 8. Browser runtime

Search and decoding run in a Web Worker so that typing, IME composition, and
rendering stay responsive.

```text
Input event
    |
    v
Query normalization and monotonically increasing request ID
    |
    v
Web Worker -> manifest route -> shard cache/fetch -> binary search -> ranking
    |
    v
Stable top-result IDs returned to UI -> placeholder cards
    |
    v
Cached records rendered immediately
    |
    v
Record shards settle independently -> matching cards filled in place
```

The runtime should:

- Debounce lightly, approximately 40–80 ms, subject to testing.
- Discard results from stale request IDs.
- Abort fetches when practical, without relying on abort for correctness.
- Keep decoded shards in a memory-bounded LRU cache.
- Allow the browser HTTP cache to retain compressed responses.
- Show approximately 20 placeholder cards as soon as a non-empty query starts.
- Finish search-shard ranking before exposing result IDs, so provisional entries
  never appear in the wrong order.
- Lock those IDs to stable slots, render bootstrap or cached records
  immediately, and fill the remaining slots as each record shard settles.
- Ignore every slot or record update whose request ID is stale.
- Return approximately 20 results initially, then append continuation pages as
  the user approaches the end of the list.
- Preserve already displayed entries and stable deduplication when a broad
  bootstrap search expands into complete prefix shards.
- Cancel or ignore continuation work when a newer query becomes active.
- Support keyboard navigation and accessible result announcements.

A service worker is optional. It may cache the application shell and bootstrap
index, but ordinary immutable HTTP caching is sufficient for the first release.

## 9. Build pipeline

The dictionary builder is a versioned command-line program and is never run in
the browser.

```text
Pinned edition and release
    -> verify source checksum
    -> extract lexical records and upstream IDs
    -> resolve A/B split information
    -> normalize and generate search aliases
    -> intern repeated strings and POS values
    -> build and size-balance prefix shards
    -> measure prefix cost and build budgeted bootstrap results
    -> build record shards
    -> emit manifest, hashes, statistics, and notices
    -> run integrity and search fixtures
```

Use a small Rust exporter pinned to the selected Sudachi release as the upstream
adapter. SudachiPy provides exact-surface lookup but no complete lexicon
iteration, while the Rust lexicon exposes its size and word information by ID.
The exporter consumes the official compiled dictionary and emits a neutral
entry stream for the web-format builder. It must pin the exact upstream commit
and avoid parsing private binary layouts independently.

The manifest should contain at least:

```json
{
  "formatVersion": 9,
  "dictionary": {
    "edition": "core",
    "version": "20260428"
  },
  "generatorVersion": "0.1.0",
  "bootstrapFile": "bootstrap.bin.gz",
  "posTableFile": "pos.bin.gz",
  "posCount": 1558,
  "posTableBytes": 10587,
  "posTableDecodedBytes": 113109,
  "posCompression": "gzip",
  "posEncoding": "sudachi-u16",
  "kanaRanking": "literal-script-tiebreak",
  "bootstrapPrefixes": 4071,
  "bootstrapRecords": 39963,
  "bootstrapBytes": 859839,
  "bootstrapDecodedBytes": 2621427,
  "bootstrapBudgetBytes": 2621440,
  "bootstrapCompression": "gzip",
  "routing": "prefix routing data",
  "recordPartitioning": "record partition metadata"
}
```

### 9.1 Dictionary release artifacts

Dictionary generation and site deployment are separate pipelines. A dictionary
release pipeline consumes a pinned upstream edition and version, runs all data
validation, and publishes a content-addressed artifact with its manifest,
statistics, checksums, and notices. The artifact is reused until either the
upstream dictionary version or generator version changes.

Ordinary frontend builds must not regenerate SudachiDict. Local development and
pull-request previews use a small deterministic fixture. Staging and production
select an already validated Core or Full artifact.

For Full, the preferred production path is CI-owned assembly and deployment:

```text
Dictionary release workflow
    SudachiDict Full -> generate -> validate -> publish versioned artifact

Site deployment workflow
    frontend + selected artifact -> build dist/ -> validate -> Wrangler upload
```

This keeps the expensive Full build out of both the local feedback loop and
Cloudflare Pages' build environment. It also produces one inspectable `dist/`
artifact representing exactly what was deployed.

## 10. Validation requirements

### Data integrity

- Every referenced A/B split component resolves.
- Every search posting resolves to a record.
- Split results match the pinned Sudachi implementation for fixtures.
- Duplicate surfaces remain represented.
- UTF-8 and string-table offsets stay within bounds.
- Manifest hashes match emitted files.
- Builds from the same pinned inputs are byte-for-byte reproducible where
  practical.

### Search behavior

- Exact surface, normalized-form, dictionary-form, and reading fixtures pass.
- Hiragana and katakana queries return equivalent reading matches.
- Ranking is deterministic.
- Stale worker responses never replace newer results.
- Empty, punctuation-only, Latin, numeric, and very long queries are safe.

### Performance budgets

The prototype should report rather than guess:

- Total compressed and uncompressed output
- Bootstrap transfer and decode time
- Median, p95, and maximum shard size
- Cold and warm query latency
- Peak worker memory during representative sessions
- Number of network requests for representative query sequences
- Coverage of entries carrying A/B split data

Concrete release budgets should be established after the first Core build.

## 11. Local development and Cloudflare Pages deployment

### 11.1 Local workflow

Use a local HTTP development server from the first browser prototype. Opening
the application through `file://` is not a supported workflow because module
workers, `fetch`, MIME handling, and caching need realistic HTTP behavior.

The intended commands are conceptually:

```text
npm run data:sample   Generate the small deterministic fixture
npm run dev           Run the local development server
npm test              Run data and search tests
npm run build         Build static production output
npm run preview       Serve the production output locally
```

Full dictionary generation is an explicit release operation, not a prerequisite
for `npm run dev`.

### 11.2 Pages project timing

Create the Cloudflare Pages project after the first vertical slice works: a
production frontend build must load sample shards through the worker, return
real results, and expand at least one A/B/C entry. Creating Pages at that point
tests real compression, caching, MIME types, file limits, and network latency
without making hosting setup block the data prototype.

Use `pages.dev` deployment and Wrangler-created branch-preview URLs during
development. The selected production setup is a Pages Direct Upload project so
CI can assemble and validate exactly one dictionary edition before upload.
Direct Upload does not provide native Git-triggered previews and cannot later be
converted to Git integration; explicit preview deployments are acceptable for
this personal project and keep the Full release pipeline deterministic.

Connect the production custom domain only after the complete release candidate
passes data integrity, licensing, caching, accessibility, and mobile-performance
checks. An optional staging subdomain may point at a stable preview branch.

### 11.3 Production delivery

The production site consists only of static application files and dictionary
assets. Pages Functions, D1, KV, and R2 are unnecessary for the initial design.

The current Vinext build is an intermediate application build rather than the
final Pages artifact: it emits a Worker entry point and browser assets without a
standalone static HTML entry point. A Pages-specific assembly target must create
a clean static directory and require an explicit `sample`, `core`, or `full`
selection. It must never infer the deployed edition from whichever ignored data
happens to exist in the working tree.

For the Full edition, CI owns the production build. It retrieves the validated
dictionary artifact, builds the frontend, assembles and tests the complete
`dist/pages/` directory, and uploads it to Pages with Wrangler. Pages is the
static host rather than the place where the expensive dictionary build occurs.

The first upload uses the sample fixture on a preview branch. Core follows on a
separate staging branch after cache and content-type behavior is proven. Full is
attached only to an explicit CI release job after Core establishes network and
browser-performance budgets.

Versioned and content-hashed data files can use:

```text
Cache-Control: public, max-age=31556952, immutable
```

HTML and the current manifest should remain revalidatable so a deployment can
switch atomically to a new versioned data directory. Cloudflare Pages supports
custom `_headers` rules and Brotli delivery for static assets:

- [Headers](https://developers.cloudflare.com/pages/configuration/headers/)
- [Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/)

The design deliberately avoids remote SQLite range reads because Cloudflare
Pages currently documents `200` responses for HTTP range requests rather than
spec-compliant partial `206` responses. Pages also limits an individual static
asset to 25 MiB, another reason to produce bounded shards:

- [Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/#behavior)
- [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)

A custom subdomain is the simplest production setup. Cloudflare documents both
subdomain and apex-domain configuration at
[Custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/).

## 12. Licensing and attribution

SudachiDict is licensed under Apache License 2.0 and includes UniDic and part of
NEologd. The generator and deployment process must preserve the upstream
license, copyright, and required attribution notices. The application should
show the exact dictionary edition and version and provide an accessible notices
page.

Before publishing the derivative dataset, review the upstream `LEGAL`, license,
and source-component notices for the pinned release rather than relying only on
the repository summary. See
[SudachiDict](https://github.com/WorksApplications/SudachiDict#licenses).

No license for this repository's original code should be assumed until the
owner explicitly chooses one.

## 13. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Very large first-character partitions | Bootstrap top results and recursively size-bounded shards |
| Excessive browser memory | Worker decoding, compact arrays, and an LRU budget |
| Duplicate or ambiguous entries | Preserve stable entry IDs and group only in the UI |
| Split references change across releases | Pin releases and validate fixtures during every build |
| Binary format becomes difficult to evolve | Version the format and keep the manifest explicit |
| Search quality suffers without corpus frequency | Start with deterministic linguistic ranking and measure real queries |
| New dictionary deployment mixes old and new assets | Content-hashed immutable files and one version-selecting manifest |
| Upstream extraction API changes | Isolate extraction behind a tested adapter and pin tool versions |
| Licensing notices are incomplete | Package notices from the exact pinned release and review before publish |
| Full builds slow ordinary development | Use a checked-in sample fixture and publish Full as a reusable CI artifact |
| Deployment cannot be reproduced | Retain the validated dictionary artifact and exact assembled `dist/` metadata |

## 14. Delivery roadmap

### Phase 1: data feasibility

- Pin one SudachiDict Core release.
- Extract entries and split relationships.
- Generate search aliases and size-balanced shards.
- Produce integrity, size, latency, and memory reports.
- Decide the initial binary encoding from measurements.

### Phase 2: functional browser prototype

- Add the local development server and deterministic sample-data command.
- Implement the worker protocol and shard cache.
- Add incremental search and deterministic ranking.
- Render entry metadata and A/B/C segmentation.
- Test IME, keyboard, mobile, and accessibility behavior.

### Phase 3: hosted preview

- Push the repository to its Git host.
- Create the Cloudflare Pages project after the vertical slice works locally.
- Exercise sample-data builds through `pages.dev` and branch previews.
- Verify binary MIME types, headers, compression, and cache invalidation.

### Phase 4: production Core site

- Finalize the interface and responsive presentation.
- Add dictionary version and notices pages.
- Publish and consume a validated Core dictionary artifact.
- Configure immutable asset headers and production deployment automation.
- Deploy to Cloudflare Pages and connect the custom domain.

### Phase 5: Full edition

- Generate and measure a pinned Full release.
- Add the CI-owned Full artifact and site-deployment workflows.
- Assemble, validate, and upload the complete static output with Wrangler.
- Confirm that Pages file-count and per-asset limits retain adequate margin.

### Phase 6: optional expansion

- Add the Small edition.
- Offer an explicit offline/full-data download.
- Evaluate substring or fuzzy search from observed demand.
- Evaluate arbitrary-text tokenization independently from lexicon lookup.
- Optionally make the provider behind the neutral web-search action configurable.

## 15. Open questions

These should be answered by the feasibility prototype or product testing:

- Which upstream extraction path is most stable and reproducible?
- How many Core records and aliases result after preserving homographs?
- What ranking signal, if any, is appropriate beyond match kind and length?
- What shard ceiling gives the best latency/request-count balance?
- Should short-prefix suggestions be global or separated by alias kind?
- Does contextual surface text need to accompany split entry references?
- Should result grouping default to linguistic entries or visible headwords?
- Should Full replace Core in production or be offered as a selectable edition?
- Where should validated dictionary artifacts be retained and for how long?

The architecture is considered validated when the Core prototype meets agreed
transfer, latency, memory, integrity, and search-quality budgets without a
server-side component.
