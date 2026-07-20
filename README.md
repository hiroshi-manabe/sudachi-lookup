# Sudachi Lookup

Sudachi Lookup is a planned static web application for searching the Japanese
lexicon from [SudachiDict](https://github.com/WorksApplications/SudachiDict).
Search runs entirely in the browser and updates as the user types. Results can
also expose Sudachi's alternative A, B, and C segmentation units.

The application is intended to be deployed to Cloudflare Pages under a custom
domain. It requires no application server, search API, or hosted database.

## Project status

The local vertical slice, complete SudachiDict Core/Full exporter, and
range-sharded browser format are implemented. Format v10 publishes only
canonical dictionary-form identities in search while retaining every source
record for lossless navigation. It also includes a cost-driven bootstrap of
precomputed initial results and their display records for expensive prefixes
under a 2.5 MiB decoded budget. Hiragana and katakana queries have distinct
bootstrap rankings, and literal-script matches win otherwise equal ranking
ties. Records preserve Sudachi's original 16-bit POS IDs and resolve them
through one compressed shared table instead of repeating POS strings. The
bootstrap is stored as gzip, keeping the Core transfer below 0.85 MiB. It
inherits v4's eager one-byte boundaries for Structure and A/B segmentation.
Format v10 also adds a lazy, position-aware Structure Match index: any result
can become an identity token that finds canonical words whose direct Sudachi
Structure begins or ends with that entry. Core adds 50 compressed shards
(3,293,246 bytes); Full adds 128 (8,875,874 bytes), with no added startup
transfer. The interface supports navigable compound components, mode badges, and
mode-specific expansion without loading component records. Its visible copy,
loading and error states, accessibility labels, and supporting static pages are
Japanese; the product name, A/B/C badges, and Core/Full edition names remain
unchanged. For queries outside
the bootstrap, it reserves the first result slots immediately, locks their
ranking after search shards arrive, and fills cards in place as cached or
newly fetched record shards become available. The browser prefers generated
Full or Core assets when present and otherwise falls back to the deterministic
fixture.

The proposed first release will provide:

- Prefix search over surface, dictionary, normalized, and reading forms
- Hiragana and katakana query matching
- Responsive, incremental results driven by a Web Worker
- Progressive result loading for broad prefixes
- Navigable Structure components and expandable A/B/C segmentation
- Lazy Structure Match lookup by direct first or last component identity
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
        +-- lazy first/last Structure Match posting shards
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
shards remain lossless, while formats v5 through v10 index only canonical headword results
as described in
[docs/canonical-headword-filtering.md](docs/canonical-headword-filtering.md).

## Run with SudachiDict Core locally

Install and checksum-verify the pinned official package, then derive the neutral
export and browser files:

```sh
npm run data:core:install
npm run data:core
npm run data:core:web
npm run dev
```

For the pinned Full edition, start with `npm run data:full:install`, then use
`npm run data:full` followed by `npm run data:full:web`. The same application and Worker consume either
edition; with both present locally, Full is preferred.

The two generated-data directories are ignored by Git. Normal UI development
still requires only `npm run dev` and uses the small fixture when Core assets
are absent.

## GitHub and releases

The source repository deliberately excludes neutral exports and generated Core
or Full browser datasets. [`config/dictionary-release.json`](config/dictionary-release.json)
pins the official SudachiDict packages, installed-dictionary checksums, Rust
Sudachi revision, and browser format. A build derives every deployed dictionary
file from that verified official input.

Ordinary pushes and pull requests run the deterministic sample workflow in
`.github/workflows/check.yml`. Full production is a separate, manually
dispatched workflow: it installs the official package, verifies the input,
derives and validates the complete browser dictionary, assembles Pages, and
deploys the configured `main` production branch. It requires the GitHub
`production` environment and the `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` secrets.

## Deployment status

The deterministic static Pages assembly target is implemented and accepts
exactly one of `sample`, `core`, or `full`. The sample is deployed at
<https://staging.sudachi-lookup.pages.dev>, and Core is deployed separately at
<https://core-staging.sudachi-lookup.pages.dev>. Full is available at
<https://full-staging.sudachi-lookup.pages.dev> and remains an explicitly
selected production release.

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
- [Structure Match lookup plan](docs/structure-match-lookup.md)

## Licensing

The original source code in this repository is licensed under the Apache
License 2.0. See [LICENSE](LICENSE).

SudachiDict is distributed under the Apache License 2.0 and incorporates data
from UniDic and part of NEologd. Any distributed dictionary derivative must
include the appropriate license and attribution notices. See the
[SudachiDict licensing information](https://github.com/WorksApplications/SudachiDict#licenses).
