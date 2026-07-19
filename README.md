# Sudachi Lookup

Sudachi Lookup is a planned static web application for searching the Japanese
lexicon from [SudachiDict](https://github.com/WorksApplications/SudachiDict).
Search runs entirely in the browser and updates as the user types. Results can
also expose Sudachi's alternative A, B, and C segmentation units.

The application is intended to be deployed to Cloudflare Pages under a custom
domain. It requires no application server, search API, or hosted database.

## Project status

The local vertical slice, complete SudachiDict Core exporter, and first
range-sharded browser format are implemented. The pinned pipeline enumerates
all 1,629,080 Core entries, validates every A/B split reference, generates
8,140,461 lookup aliases, and divides search and record data into bounded binary
files. The browser automatically uses generated Core assets when they are
present and otherwise falls back to the deterministic development fixture.

The proposed first release will provide:

- Prefix search over surface, dictionary, normalized, and reading forms
- Hiragana and katakana query matching
- Responsive, incremental results driven by a Web Worker
- Expandable A/B/C segmentation for dictionary entries
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
        +-- entry-detail shards with A/B split references
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

Validate the prepared Core build under production-like HTTP compression and
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

## Licensing

No license has yet been selected for the original code in this repository.

SudachiDict is distributed under the Apache License 2.0 and incorporates data
from UniDic and part of NEologd. Any distributed dictionary derivative must
include the appropriate license and attribution notices. See the
[SudachiDict licensing information](https://github.com/WorksApplications/SudachiDict#licenses).
