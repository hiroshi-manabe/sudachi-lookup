# Sudachi Lookup

Sudachi Lookup is a planned static web application for searching the Japanese
lexicon from [SudachiDict](https://github.com/WorksApplications/SudachiDict).
Search runs entirely in the browser and updates as the user types. Results can
also expose Sudachi's alternative A, B, and C segmentation units.

The application is intended to be deployed to Cloudflare Pages under a custom
domain. It requires no application server, search API, or hosted database.

## Project status

The local vertical slice, complete SudachiDict Core/Full exporter, and
range-sharded browser format are implemented. Format v6 publishes only
canonical dictionary-form identities in search while retaining every source
record for lossless navigation. It also includes a cost-driven bootstrap of
precomputed initial results and their display records for expensive prefixes
under a 1 MiB budget. It
inherits v4's eager one-byte boundaries for Structure and A/B segmentation.
The interface supports navigable compound components, mode badges, and
mode-specific expansion without loading component records. The browser prefers
generated Full or Core assets when present and otherwise falls back to the
deterministic fixture.

The proposed first release will provide:

- Prefix search over surface, dictionary, normalized, and reading forms
- Hiragana and katakana query matching
- Responsive, incremental results driven by a Web Worker
- Progressive result loading for broad prefixes
- Navigable Structure components and expandable A/B/C segmentation
- A versioned, reproducible SudachiDict Core data build
- A fully static Cloudflare Pages deployment

## Architecture in one minute

The original Sudachi dictionary will be transformed offline into compact,
prefix-addressed binary shards. The browser downloads a small suggestion index
on startup, then fetches only the shards relevant to the current query.

```text
Pinned SudachiDict release
        |
        v
Offline extractor and index builder
        |
        +-- manifest and bootstrap suggestions
        +-- prefix-search shards
        +-- entry-detail shards with Structure and A/B boundaries
        |
        v
Cloudflare Pages
        |
        v
Browser Web Worker -> ranked results -> A/B/C presentation
```

JavaScript modules and JSON are intentionally not the primary dictionary
format: they impose unnecessary parsing, allocation, and duplication costs.
SQLite-over-HTTP is also not the default because the design should not depend
on HTTP range support. The detailed rationale is in
[docs/architecture.md](docs/architecture.md).

## Proposed repository layout

```text
app/                  Web application
tools/dictionary/     Reproducible dictionary build pipeline
public/data/          Generated, versioned search assets
.github/workflows/     Data-release and site-deployment automation
docs/                 Product and architecture documentation
```

Generated dictionary assets should not be edited manually. Each release should
record the source dictionary edition and version, generator version, data-format
version, checksums, and applicable notices.

The browser-data policy distinguishes dictionary headwords from Sudachi's
internal conjugation-state records. The neutral export and browser record
shards remain lossless, while formats v5 and v6 index only canonical headword results
as described in
[docs/canonical-headword-filtering.md](docs/canonical-headword-filtering.md).

## Run with SudachiDict Core locally

After installing the pinned local data prerequisites described in the
feasibility notes:

```sh
npm run data:core
npm run data:core:web
npm run dev
```

For the pinned Full edition, use `npm run data:full` followed by
`npm run data:full:web`. The same application and Worker consume either
edition; with both present locally, Full is preferred.

The two generated-data directories are ignored by Git. Normal UI development
still requires only `npm run dev` and uses the small fixture when Core assets
are absent.

## Next milestone

The deterministic static Pages assembly target is implemented and accepts
exactly one of `sample`, `core`, or `full`. The sample is deployed at
<https://staging.sudachi-lookup.pages.dev>, and Core is deployed separately at
<https://core-staging.sudachi-lookup.pages.dev>. Full remains a later,
explicitly selected release.

The current Vinext build remains useful for local development, but its
Worker-oriented output and locally copied generated datasets must not be
uploaded to Pages unchanged. Use `npm run build:pages -- --edition sample` and
serve the result with `npm run preview:pages`. The deployment runbook and
acceptance checks are in [docs/development.md](docs/development.md).

The repeatable sample preview command is `npm run deploy:pages:staging`. It
always rebuilds the sample artifact before uploading, so ignored local Core or
Full data cannot leak into an ordinary preview.

Core remains a separate artifact and deployment. Use
`npm run deploy:pages:core-staging` to validate the pinned Core data, assemble a
Core-only Pages directory with its legal notices, and deploy the `core-staging`
preview branch.

The Core preview now provides the production-like HTTP environment needed to
measure:

- Total compressed output size
- Bootstrap-index size
- Median and maximum shard size
- Cold and warm query latency
- Browser memory use across a representative search session
- Request counts for common one- and two-character prefixes

Those measurements will validate the storage design before work begins on the
production interface. Everyday browser development should use a small,
deterministic fixture; Full dictionary assets should be generated and validated
separately rather than rebuilt on every local or preview run.

## Documentation

- [Architecture and product specification](docs/architecture.md)
- [Development and deployment workflow](docs/development.md)
- [Initial feasibility findings](docs/feasibility.md)
- [Compound navigation interaction](docs/compound-navigation.md)

## Licensing

No license has yet been selected for the original code in this repository.

SudachiDict is distributed under the Apache License 2.0 and incorporates data
from UniDic and part of NEologd. Any distributed dictionary derivative must
include the appropriate license and attribution notices. See the
[SudachiDict licensing information](https://github.com/WorksApplications/SudachiDict#licenses).
