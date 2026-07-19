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

Create the Pages project after the vertical slice is complete. That milestone
has now been reached: the browser can search generated dictionary data and
navigate Structure and A/B/C relationships. The next development milestone is
therefore a hosted preview rather than additional local-only infrastructure.

Use Pages to test:

- Brotli or gzip transfer sizes
- Binary content types
- `_headers` behavior
- Immutable asset caching and manifest revalidation
- Cold and warm query latency
- Mobile-network behavior
- Total file count and maximum asset size

During development, use the project’s `pages.dev` address and branch preview
URLs created by Wrangler. Preview deployments should use the sample fixture by
default so a CSS or interaction change does not trigger or transfer Full.

## Pages deployment output

The application behavior and a dedicated static output are ready for a hosted
preview. The ordinary application build is still not the Pages artifact.

`npm run build` currently emits a Vinext Worker-oriented package:

```text
dist/client/          Browser assets, but no standalone index.html
dist/server/index.js  Worker entry point
```

In addition, a build made in a working tree containing generated Core and Full
assets may copy both editions into `dist/`. That makes the output dependent on
local state and could accidentally upload several gigabytes when only the
sample fixture was intended.

The implemented Pages assembly command requires an explicit edition:

```text
npm run build:pages -- --edition sample
npm run build:pages -- --edition core
npm run build:pages -- --edition full
```

Each command creates a clean `dist/pages/` directory with a
standalone HTML entry point, application assets, `_headers`, and exactly one
selected dataset. Because all search behavior runs in the browser, the Pages
target should be a static Vite/React application rather than requiring the
Vinext server entry point.

The assembly step fails if:

- More than one dictionary edition is present in the output.
- A manifest references a missing file.
- A generated file exceeds the configured per-file budget.
- The total file count exceeds the configured Pages budget.
- The requested Core or Full artifact is unavailable or has the wrong checksum.

Serve this exact directory locally before upload:

```sh
npm run build:pages -- --edition sample
npm run preview:pages
```

Testing only through the development server is insufficient because it does not
prove the production entry point, copied assets, or `_headers` placement.

## Recommended first deployment

Use a Cloudflare Pages **Direct Upload** project deployed with Wrangler. This
matches the selected Full workflow: the local machine or CI assembles and
validates the complete output, while Pages only receives finished static files.

Direct Upload projects cannot later be converted to Pages Git integration. That
tradeoff is acceptable here because branch previews can still be deployed
explicitly with Wrangler and the large dictionary build should remain under CI
control. If native pull-request previews later become more valuable than the
controlled assembly pipeline, create a separate Git-integrated sample project
rather than changing the production project.

After the deterministic static output exists, create the project interactively:

```sh
npx wrangler login
npx wrangler pages project create
```

Use `sudachi-lookup` as the preferred project name and `main` as the production
branch. Then make the first upload a non-production sample preview:

```sh
npm run build:pages -- --edition sample
npx wrangler pages deploy dist/pages \
  --project-name=sudachi-lookup \
  --branch=staging
```

The preview should be accepted only after verifying:

- The application loads and survives a direct-page reload.
- `今日` and representative surface, reading, and normalized-form searches work.
- Structure components and expanded A/B/C units remain navigable.
- Japanese IME composition does not issue disruptive searches.
- Stale Web Worker responses cannot replace a newer query.
- Missing shards fail visibly without breaking subsequent searches.
- Dictionary files have the expected content types and compression.
- HTML and manifests revalidate while versioned shards remain immutable.

Cloudflare documents the current Direct Upload commands and preview-branch URL
behavior in [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/).

## Staged dictionary rollout

Do not make Full the first real-data deployment. Use the following progression:

1. **Sample preview:** prove routing, static output, MIME types, caching, and the
   Pages project configuration.
2. **Core preview:** deploy to a separate branch such as `core-staging` and
   measure real transfer, search latency, request count, and browser memory.
3. **Automated Core release:** add the CI-owned assembly and retain the exact
   dictionary artifact and output metadata used for deployment.
4. **Full preview:** deploy Full only through an explicit release or manual CI
   job and repeat the Core measurements on mobile and cold caches.
5. **Production release:** promote a previously validated artifact rather than
   regenerating data during the production deployment.

Normal frontend checks and previews continue to use the sample fixture. Core
and Full are selected explicitly; the application's local Full-to-Core-to-sample
fallback must not be used as deployment selection logic.

## Static cache policy

The current `_headers` file keeps the sample fixture revalidatable and applies
immutable caching to fingerprinted application assets and versioned Core or
Full paths.

Content-addressed or release-versioned shards can use:

```text
Cache-Control: public, max-age=31556952, immutable
```

The HTML entry point and the small manifest that selects the active release
must remain revalidatable. This allows a release to switch atomically to a new
versioned directory without mixing old manifests with missing new shards.
Cloudflare describes static asset rules in
[Headers](https://developers.cloudflare.com/pages/configuration/headers/) and
its default compression and cache behavior in
[Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/).

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

Add the hostname through **Workers & Pages → the Pages project → Custom
domains** before creating or changing DNS manually. Prefer a subdomain for the
first public release. When the DNS zone is already managed by Cloudflare, Pages
can create the required record; otherwise point a CNAME at the assigned
`pages.dev` hostname after associating the hostname with the Pages project. See
[Custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/).

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

For deployment, store `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` as CI secrets. Scope the token to **Account → Cloudflare
Pages → Edit** and to the intended account. The site workflow should run tests
before assembly, record the chosen edition and artifact checksum, and pass only
the clean `dist/pages/` directory to Wrangler. Cloudflare's current setup is
documented in
[Use Direct Upload with continuous integration](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

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
