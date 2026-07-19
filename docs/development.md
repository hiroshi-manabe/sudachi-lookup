# Development and Deployment Workflow

## Overview

Sudachi Lookup has two distinct products to build:

1. A reproducible dictionary artifact containing browser-searchable shards.
2. A static web application that consumes a selected dictionary artifact.

Keeping them separate is essential. Frontend work should remain fast, while a
large SudachiDict Full build should be infrequent, rigorously validated, and
reused across many site deployments.

## Environments

| Stage | Environment | Dataset | Purpose |
| --- | --- | --- | --- |
| Data feasibility | Local CLI | Pinned Core | Validate extraction, relationships, format, and size |
| Browser development | Local HTTP server | Small fixture | Fast UI, worker, ranking, and accessibility work |
| Hosted preview | `pages.dev` | Small fixture or prepared Core | Test real transfer and hosting behavior |
| Release candidate | Preview URL or staging subdomain | Prepared Core or Full | Validate the complete release on real networks |
| Production | Custom domain | Validated release artifact | Public service |

## Local development

Use Vite with TypeScript or an equivalent lightweight static toolchain. The
application does not require server-side rendering or an application server.

The target command surface is:

```text
npm run data:sample   Generate or copy the deterministic browser fixture
npm run data:core     Export an installed Core dictionary to a neutral stream
npm run data:core:web Build locally served Core browser shards
npm run data:full     Export an installed Full dictionary to a neutral stream
npm run data:full:web Build locally served Full browser shards
npm run dev           Start the local HTTP development server
npm test              Run unit, integrity, and search fixtures
npm run build         Produce deployable static output
npm run preview       Serve the production output locally
```

The sample dataset should include:

- Exact and prefix surface matches
- Dictionary and normalized-form aliases
- Hiragana and katakana reading matches
- Homographs that must remain distinct
- Entries with no split information
- Representative C entries with both B and A splits
- Unicode normalization and punctuation edge cases

The fixture should be small enough to regenerate almost instantly and stable
enough that UI tests can assert exact ordering.

`npm run data:core` is a separate feasibility/release command. It expects the
project-local Rust toolchain and the pinned Core installation described in
[feasibility.md](feasibility.md), and writes ignored artifacts under
`reports/`. It is intentionally not part of normal frontend checks.

After the neutral export exists, `npm run data:core:web` writes the versioned
browser dataset under `public/data/releases/`. Those assets are also ignored by
Git. When that Core manifest is present, the local app selects it automatically;
otherwise it falls back to the sample fixture. A complete local sequence is:

```sh
npm run data:core
npm run data:core:web
npm run dev
```

The Full commands use the same exporter and browser-format builder. When both
generated editions are present locally, the application currently prefers Full;
it falls back through Core to the sample fixture as assets become unavailable.

Do not use `file://` as a development environment. An HTTP server is required
to exercise module workers, relative `fetch` calls, MIME types, and realistic
asset loading.

## First vertical slice

Before visual polish or hosting setup, implement one complete path:

```text
real Sudachi records
    -> extractor
    -> a few binary shards
    -> Web Worker fetch and decode
    -> prefix search and ranking
    -> visible result
    -> expandable A/B/C segmentation
```

The slice is complete when a production build works locally and stale worker
responses cannot overwrite a newer query.

## When to create Cloudflare Pages

Create the Pages project after the vertical slice is complete. At that point,
the project has something meaningful to validate under production-like hosting
conditions but has not yet invested heavily in interface polish.

Use Pages to test:

- Brotli or gzip transfer sizes
- Binary content types
- `_headers` behavior
- Immutable asset caching and manifest revalidation
- Cold and warm query latency
- Mobile-network behavior
- Total file count and maximum asset size

During development, use the project’s `pages.dev` address and automatic branch
or pull-request previews. Preview deployments should use the sample fixture by
default so a CSS or interaction change does not trigger or transfer Full.

## When to connect the custom domain

Do not attach the production domain merely to reserve it. Connect it when the
release candidate satisfies all of the following:

- Dictionary integrity and search fixtures pass.
- The displayed dictionary edition and version are correct.
- License and attribution notices are published.
- Cache invalidation has been exercised across a version change.
- Mobile and cold-cache performance meet the agreed budgets.
- Keyboard, IME, and accessibility testing is complete.
- The release can be rolled back to a previously retained artifact.

If a stable public test address is useful, attach a staging subdomain to a
preview branch before connecting the production subdomain.

## Deployment alternatives

### Pages-owned build with a prepared artifact

```text
Git push
    -> Pages build
    -> download prepared dictionary archive
    -> build frontend and unpack data
    -> publish
```

This preserves the simplest native Pages preview experience. It may suit the
Core prototype if downloading and unpacking the artifact remains fast.

The disadvantages become more significant with Full: every relevant Pages
build repeats the artifact download and assembly, the build depends on the
artifact host, and the work must finish inside the Pages build environment.

### CI-owned build with Wrangler deployment

```text
Git push or release tag
    -> CI retrieves validated dictionary artifact
    -> CI builds and tests complete dist/
    -> CI uploads dist/ to Pages with Wrangler
```

This is the preferred Full workflow. CI owns the exact production assembly;
Pages only hosts the resulting static files.

Benefits include:

- Cached data and intermediate work across builds
- Explicit validation before any upload
- Release tags tied to exact dictionary and generator versions
- Retention of the artifact that was actually deployed
- No expensive dictionary conversion in the Pages environment
- Frontend-only pull requests that remain small and fast

The tradeoff is additional workflow code, Cloudflare deployment credentials in
CI, and explicit configuration for branch previews.

## Recommended CI separation

### Dictionary release workflow

Trigger when the pinned SudachiDict version, edition, or generator changes.

```text
download and verify upstream input
    -> generate shards
    -> run integrity and search fixtures
    -> record performance and size report
    -> package checksums and notices
    -> publish immutable versioned artifact
```

The artifact identity should include at least:

- Dictionary edition and version
- Data-format version
- Generator version or commit
- Content checksum

### Site deployment workflow

Trigger for a release candidate, production release, or explicitly requested
preview.

```text
build frontend
    -> retrieve selected dictionary artifact
    -> assemble dist/
    -> verify manifest and every referenced file
    -> enforce file-count and file-size budgets
    -> smoke-test static output
    -> deploy with Wrangler
```

Normal frontend pull requests should build against the sample fixture. Full
should be attached only to explicit staging and production jobs.

## Edition policy

Core remains the feasibility and first-production target because it provides a
useful dataset for establishing budgets. Full is a separate release milestone,
not a toggle added casually to the frontend.

Before publishing Full, record:

- Compressed and uncompressed size
- Number of static files
- Largest asset size
- Cold and warm search latency
- Peak worker memory
- CI generation and assembly duration
- Retention and rollback cost

If Full stays comfortably within the hosting, transfer, and memory budgets, it
may replace Core or become a selectable edition. That product decision should
follow measurement rather than precede it.
