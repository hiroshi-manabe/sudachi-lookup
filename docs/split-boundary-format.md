# Compact Split Boundary Format

## Decision

Browser data format v4 will store Structure, A, and B segmentation as
cumulative Unicode code-point boundaries within the parent entry's `surface`.
It will not store referenced word IDs in browser record shards.

For example:

```text
surface:   選挙管理委員会
Structure: [2, 4]       -> 選挙 / 管理 / 委員会
A:         [2, 4, 6]    -> 選挙 / 管理 / 委員 / 会
B:         [2, 4]       -> 選挙 / 管理 / 委員会
```

The final component is the remainder of the surface, so an `n`-component
sequence requires `n - 1` boundaries. Empty boundary lists continue to mean
that the corresponding segmentation is absent. The three fields remain
logically distinct even when two modes have identical boundaries.

Each boundary is an unsigned byte. It counts Unicode code points, not UTF-8
bytes or JavaScript UTF-16 code units. The browser reconstructs components from
`Array.from(surface)` so supplementary characters are not split incorrectly.

## Why boundaries are sufficient

The browser uses split components as display text and as new surface queries.
It does not use the referenced component entry's reading, part of speech, or
other lexical fields. Deriving component text from the parent surface therefore
preserves the spelling users see and removes the need to load component record
shards.

Measurements of the pinned `20260428` dictionaries support this representation:

| Measurement | Core | Full |
| --- | ---: | ---: |
| Longest surface carrying A/B splits | 133 code points | 133 code points |
| Surfaces longer than 127 code points | 1 | 1 |
| Surfaces longer than 255 code points | 0 | 0 |
| Structure concatenation matches parent | 99.9966% | validated during generation |
| A concatenation matches parent | 99.9966% | validated during generation |
| B concatenation matches parent | 99.9945% | validated during generation |

The 28 Core text mismatches are capitalization variants such as parent
`Aiロボティクス` versus referenced components `AI` and `ロボティクス`.
Their component lengths still define valid boundaries. Reconstructing from the
parent deliberately displays `Ai / ロボティクス`, which preserves the result's
own spelling and remains equivalent for normalized lookup.

Core's current A/B ID arrays occupy about 17.03 MiB. One-byte boundaries need
about 3.94 MiB, a reduction of roughly 13.1 MiB before applying the same change
to Structure.

## Generation and validation

The offline extraction report continues to preserve upstream word IDs. The web
format builder resolves those IDs against the pinned entry surfaces and emits
boundaries only after validating all of the following:

- Every referenced word ID resolves.
- Every split contains at least two components when present.
- Component code-point lengths sum to the parent surface length.
- Boundaries are strictly increasing.
- Every boundary is less than the parent length and below 256.

A build must fail rather than silently emit an ambiguous split when an
invariant does not hold. If a later dictionary introduces a boundary at 256 or
beyond, the format should add an explicit escape or new version instead of
changing the meaning of v4 bytes.

## Loading behavior

Structure, A, and B boundaries are stored eagerly in the same record as the
parent surface. Their compact representation is smaller than the existing ID
arrays, so lazy split-detail files would add request and cache complexity
without a meaningful transfer saving.

A cold search becomes:

1. Load the relevant search shard.
2. Load record shards for the visible parent results.
3. Render Structure and all available split modes without component-record
   requests.

Split rows remain visually collapsed until requested, but opening them requires
no additional network access.

