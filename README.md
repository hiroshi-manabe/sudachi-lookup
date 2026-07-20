# Sudachi Lookup

English | [日本語](README.ja.md)

Sudachi Lookup is a static, browser-local interface for exploring the Japanese
lexicon in [SudachiDict](https://github.com/WorksApplications/SudachiDict).
Search follows keyboard input without sending queries to a server. Results
expose Sudachi's Structure information and A, B, and C segmentation units.

The application is built for Cloudflare Pages. It requires no application
server, search API, hosted database, or runtime dictionary service.

## Features

- Prefix search over surface, dictionary, normalized, and reading forms
- Hiragana and katakana matching with literal-script ranking
- Progressive results and record hydration in a Web Worker
- Navigable compound components and expandable A/B/C segmentation
- Structure Match lookup for words that begin or end with a selected direct
  Structure component
- Compact binary shards fetched only when a query needs them
- Reproducible Core and Full builds derived from pinned official SudachiDict
  packages
- Japanese interface, loading states, error messages, and accessibility labels

## How it works

```text
Pinned official SudachiDict package
        |
        v
Verified system.dic checksum
        |
        v
Rust neutral exporter and browser-format builder
        |
        +-- bootstrap results
        +-- prefix-search shards
        +-- entry records with Structure and A/B boundaries
        +-- lazy first/last Structure Match postings
        |
        v
Cloudflare Pages -> Web Worker -> ranked browser results
```

The deployed dictionary uses versioned binary files rather than JavaScript or
JSON records. The browser loads a small bootstrap at startup, routes each query
to bounded search shards, and fetches entry or Structure Match data lazily.
Details and design rationale are documented in
[docs/architecture.md](docs/architecture.md).

## Local development

Node.js 22 or newer is required.

```sh
npm ci
npm run dev
```

The development server uses the tracked deterministic sample when generated
Core or Full assets are absent. Run the complete sample check with:

```sh
npm run check
```

Do not open the application with `file://`; module workers and dictionary
requests require HTTP.

## Build an official dictionary locally

The pinned release is defined once in
[`config/dictionary-release.json`](config/dictionary-release.json). Installation
verifies the SHA-256 of the official package's `system.dic` before export.

Core:

```sh
npm run data:core:install
npm run data:core
npm run data:core:web
npm run data:core:validate
```

Full:

```sh
npm run data:full:install
npm run data:full
npm run data:full:web
npm run data:full:validate
```

Neutral exports, reports, and generated Core/Full browser datasets are ignored
by Git. If both editions exist locally, the application prefers Full, then
Core, then the sample.

## Deployment

The Pages assembler always selects exactly one edition:

```sh
npm run build:pages -- --edition sample
npm run build:pages -- --edition core
npm run build:pages -- --edition full
```

Stable preview deployments are available at:

- [Sample](https://staging.sudachi-lookup.pages.dev)
- [Core](https://core-staging.sudachi-lookup.pages.dev)
- [Full](https://full-staging.sudachi-lookup.pages.dev)

Normal GitHub pushes and pull requests run only the deterministic sample
workflow. The Full production workflow is manually dispatched, installs and
verifies the official dictionary, derives every browser asset, validates the
result, and deploys the Pages `main` branch. It requires a protected GitHub
environment named `production` with `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` secrets.

See [docs/development.md](docs/development.md) for the complete release and
deployment runbook.

## Repository layout

```text
app/                  Browser application and Web Worker
config/               Pinned dictionary release identity
tools/dictionary/     Export, browser-format build, and validation tools
tools/site/           Static Pages assembly and deployment tools
public/data/sample/   Deterministic development fixture
.github/workflows/    Sample CI and manual Full production release
docs/                 Architecture, measurements, and interaction decisions
legal/                SudachiDict license and attribution notices
```

## Documentation

- [Architecture and product specification](docs/architecture.md)
- [Development and deployment workflow](docs/development.md)
- [Initial feasibility findings](docs/feasibility.md)
- [Compound navigation interaction](docs/compound-navigation.md)
- [Structure Match lookup](docs/structure-match-lookup.md)

## License

Original source code in this repository is licensed under the
[Apache License 2.0](LICENSE).

SudachiDict is distributed under the Apache License 2.0 and incorporates data
from UniDic and part of NEologd. Distributed dictionary derivatives must retain
the applicable notices in [`legal/sudachidict`](legal/sudachidict). Sudachi
Lookup is an independent project and is not affiliated with or endorsed by
Works Applications Co., Ltd.
