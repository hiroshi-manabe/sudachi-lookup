# Initial Feasibility Findings

English | [日本語](ja/feasibility.md)

## Implemented vertical slice

The first local milestone is implemented and runs through the same boundaries
planned for production:

```text
fixture source
    -> deterministic binary generator
    -> entry and search-index files
    -> HTTP fetch
    -> Web Worker decode and prefix lookup
    -> ranked browser results
    -> A/B/C expansion
```

The fixture contains 29 representative entries and produces 145 searchable
aliases. It includes both Core readings of `今日` (`キョウ` and `コンニチ`).
The two binary payloads total 4,820 bytes before HTTP compression.
Coverage includes surface, normalized, dictionary, katakana, and hiragana
forms; homographs; unsplit entries; and C entries with A and B references.

The current binary format is intentionally small and versioned. It proves the
runtime boundary but is not yet the production sharding format.

## Pinned upstream experiment

The first real-data investigation used:

- SudachiPy `0.6.11`
- SudachiDict Core `20260428`
- Python `3.12`

The installed compiled Core dictionary is 217,374,303 bytes and has SHA-256:

```text
6c1d5adc8a2389875713056e7b39bbcd0073d6122ffd509866e1d3a196f8608e
```

This checksum describes the installed `system.dic` examined locally. The
release workflow must independently verify the official input artifact and
record its own checksums.

## Core extraction result

SudachiPy supports exact-surface lookup but deliberately does not expose
iteration over the grammar or lexicon. Exact lookup cannot discover every
surface and therefore cannot generate the complete browser dataset.

The supported Rust structures provide the primitives the exporter needs:

- `DictionaryLoader::read_system_dictionary`
- `Lexicon::size`
- `Lexicon::get_word_info`
- `Lexicon::get_word_param`

The build-time Rust exporter is pinned to the Sudachi `v0.6.11` commit:

```text
90fd6068c80c2fc3b63e0dbab0e341475bad4d8f
```

It emits a gzip-compressed JSON Lines stream for the future web-format builder.
This neutral stream is an intermediate build artifact, not a browser payload.
Keeping the upstream reader separate from the web-format builder isolates
changes in Sudachi's internal API.

The complete Core dictionary exported successfully with these measurements on
an Apple Silicon development machine:

| Measurement | Result |
| --- | ---: |
| Lexicon entries | 1,629,080 |
| Distinct surfaces | 1,379,072 |
| Surfaces with homographs | 187,380 |
| Entries belonging to homograph groups | 437,388 |
| Largest homograph group | 28 |
| Entries with A splits | 831,681 |
| A split references | 2,731,749 |
| Entries with B splits | 511,955 |
| B split references | 1,397,649 |
| Invalid, out-of-range, or non-system split references | 0 |
| Compressed neutral export, including Structure | 43,837,313 bytes (41.8 MiB) |
| Export time, excluding compilation | 55.5 seconds |
| Maximum resident set size | 249,102,336 bytes (237.6 MiB) |

The exported line count is exactly 1,629,080. The two expected `今日` entries
are present with readings `キョウ` and `コンニチ`. The representative compound
`選挙管理委員会` resolves directly from upstream IDs as:

```text
A  選挙 / 管理 / 委員 / 会
B  選挙 / 管理 / 委員会
C  選挙管理委員会
```

The exporter records the source and output SHA-256 checksums in its report.
Generated reports and neutral streams live under `reports/` and are ignored by
Git because they are reproducible and comparatively large.

Run the pinned Core export with:

```sh
npm run data:core
```

The wrapper uses the project-local Rust toolchain and Core dictionary by
default. `SUDACHI_SYSTEM_DIC` and `SUDACHI_RELEASE` override those paths and the
report directory name when testing another installed dictionary.

## Next acceptance point

Enumeration, relationship validation, and the first web-format build are
complete. The v3 prototype generated 8,140,461 de-duplicated surface,
dictionary, normalized, katakana-reading, and hiragana-reading aliases.

| Browser artifact | Count | Median raw size | p95 raw size | Maximum raw size | Total raw size |
| --- | ---: | ---: | ---: | ---: | ---: |
| Search shards | 1,629 | 131,315 B | 247,187 B | 400,838 B | 236,221,915 B |
| Record shards | 796 | 284,923 B | 504,208 B | 694,203 B | 252,802,733 B |

The bootstrap index contains 15,296 aliases and is 303,834 bytes raw. The
manifest is 292,806 bytes raw. The complete generated directory is about
472 MiB before HTTP compression, but it is not downloaded as a unit: normal
queries fetch only overlapping sorted-key ranges and the record ranges for the
visible results and their split components.

An initial prefix-per-file experiment produced hundreds of thousands of tiny
files and was rejected. The implemented router instead packs globally sorted
aliases into bounded key ranges. This produced 1,629 search files and avoids a
large static-file-count penalty without making lookup hash-based.

The worker now prefers the local Core manifest when present, caches fetched
search and record shards, and falls back to the deterministic sample when Core
has not been generated. Browser checks confirmed both `今日` readings and the
real A/B/C expansion for `選挙管理委員会`.

## Remaining acceptance work

Before publishing these artifacts, the release pipeline must still measure:

- Brotli and gzip transfer sizes under the eventual hosting configuration
- Cold and warm browser lookup latency
- Browser memory during a representative query session
- Cache behavior and total request count for short prefixes

The v3 format deliberately favored a simple, testable encoding. Format v9 now
uses Sudachi's existing 16-bit POS IDs and a shared compressed POS table after
hosted measurements showed that repeated POS strings were a material part of
record storage.

Format v4 retains that simple layout while replacing Structure and A/B word-ID
arrays with one-byte cumulative code-point boundaries. This reduces Core record
data from 252,802,733 to 232,461,377 bytes and Full record data from 471,957,614
to 427,577,506 bytes. More importantly, visible results no longer fetch full
records for their Structure and split components; the parent record alone can
render every component surface.

## Full edition measurement

The identical pinned pipeline was run against SudachiDict Full `20260428`. No
Full-specific extraction or browser-format code was required.

| Measurement | Core | Full | Full / Core |
| --- | ---: | ---: | ---: |
| Compiled `system.dic` | 217,374,303 B | 360,056,557 B | 1.66× |
| Lexicon entries | 1,629,080 | 2,883,177 | 1.77× |
| Distinct surfaces | 1,379,072 | 2,596,756 | 1.88× |
| Browser aliases | 8,140,461 | 14,410,650 | 1.77× |
| Search shards | 1,629 | 2,883 | 1.77× |
| Record shards | 796 | 1,408 | 1.77× |
| Dictionary files including manifest/bootstrap | 2,427 | 4,293 | 1.77× |
| Raw browser directory | about 472 MiB | about 879 MiB | 1.86× |
| Neutral gzip export | 43,837,313 B | 90,136,869 B | 2.06× |
| Export time | about 52–56 s | about 96 s | about 1.8× |
| Web-format build time | 11.1 s | 20.7 s | 1.86× |

Full preserved the same useful size bounds:

| Full browser artifact | Count | Median raw size | p95 raw size | Maximum raw size | Total raw size |
| --- | ---: | ---: | ---: | ---: | ---: |
| Search shards | 2,883 | 149,219 B | 222,773 B | 401,114 B | 440,371,526 B |
| Record shards | 1,408 | 319,925 B | 481,872 B | 694,203 B | 471,957,614 B |

The Full manifest is 524,587 bytes raw and its bootstrap index is 414,504
bytes raw. All 8,887,201 A/B split references resolved to valid system entries.

Format v3 additionally preserves dictionary Structure. Core contains 832,336
entries with 1,925,730 Structure references; Full contains 1,747,019 entries
with 4,273,610 references. Neither edition has an invalid Structure reference.
Most Structure sequences contain two or three components, but both editions
contain a maximum of 88, confirming that the interface must wrap arbitrary
component counts rather than assume a binary split.

### Hosting conclusion

Full is compatible with Cloudflare Pages on the measured file and individual
asset dimensions. Full alone uses 4,293 dictionary files; Core and Full together
use 6,720. Both are below the 20,000-file Free-plan allowance, and the largest
generated file is below 1 MiB, far below Pages' 25 MiB individual-file limit.
See the current [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/).

Pages therefore remains the default hosting plan. R2 is not required for Full;
it remains an optional later optimization if upload duration, retention of many
dictionary versions, or deployment operations become inconvenient. The next
decision should follow hosted compression, request-count, and browser-memory
measurements rather than raw corpus size alone.
