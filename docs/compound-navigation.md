# Compound Navigation Interaction Specification

## Status

Implemented locally in browser data format v3. Format v4 replaces browser-side
Structure and A/B word-ID references with eager one-byte boundaries, as defined
in [Compact Split Boundary Format](split-boundary-format.md). The interaction,
history, expansion, and accessibility model remains unchanged.

## Purpose

Search results should expose two related ideas without conflating them:

1. The entry's dictionary structure provides useful destinations for further
   lookup.
2. Sudachi's A/B/C modes explain how the entry changes across segmentation
   granularities.

The collapsed result prioritizes navigation. The expanded result explains the
segmentation modes. Every visible component can become the next query, making
compound exploration feel continuous rather than requiring manual copying.

## Entry-unit label

Every result begins with a compact unit badge:

- `[A]` when the entry has no A-unit split.
- `[B]` when it has an A-unit split but no B-unit split.
- `[C]` when it has a B-unit split.

The generator should store this classification explicitly or derive and test it
from the split metadata. The interface must not infer it from the surface text.

## Collapsed presentation

### A entries

An A entry is already the shortest unit. Its surface is presented directly and
is not decomposed in the collapsed heading. The whole surface becomes a lookup
action when it differs from the current normalized query. This allows a broad
query such as `権` to navigate to an A result such as `権利`, while an exact
`権` result remains plain text because repeating the same query has no effect.

The comparison uses NFKC normalization, Japanese-locale lowercasing, and
trimming. Kana and kanji are not treated as equivalent, so a reading query such
as `けん` can still navigate to the displayed surface `権`.

```text
[A]  選挙
     センキョ
```

### B and C entries

A B or C entry is presented using its `word_structure` components. Each
component is an independent lookup action.

```text
[C]  [選挙] [管理] [委員会]
     センキョカンリイインカイ
```

The brackets above illustrate separate interactive targets; the finished visual
design does not need to render literal square brackets around every component.

Structure is not another split mode. It controls the navigable presentation of
the main entry, while A/B/C rows describe segmentation behavior.

The data format permits more than two or three structure components. Components
must wrap naturally on narrow screens and must not rely on a fixed cardinality.
If Structure is empty or cannot be resolved, the result falls back to the
entry's own surface.

## Expansion behavior

Activating the non-component area of a result toggles its split details. The
expanded rows show only modes finer than the result's own unit:

| Result unit | Expanded rows |
| --- | --- |
| A | None |
| B | A only |
| C | B, then A |

For example, expanding a C entry produces:

```text
[C]  [選挙] [管理] [委員会]
     センキョカンリイインカイ

[B]  [選挙] [管理] [委員会]
[A]  [選挙] [管理] [委員] [会]
```

Expanding a B entry produces:

```text
[B]  [委員] [会]
     イインカイ

[A]  [委員] [会]
```

Every component in an expanded B or A row is independently navigable, just like
a Structure component in the collapsed heading.

## Component navigation

Activating any Structure, A, or B component performs a new lookup:

1. Use the component's displayed surface as the new query.
2. Replace the text in the search input.
3. Close the previous result's expanded state.
4. Load and display results for the new query.
5. Move the URL to the new query, for example `?q=委員会`.

Component navigation should create a browser-history entry so Back returns to
the previous compound lookup and restores its query. Ordinary character-by-
character typing should avoid creating one history entry per keystroke; it can
replace the current query URL after the normal search debounce.

Searching by surface is intentional. A component surface may correspond to
multiple dictionary entries, and the next result screen should expose those
homographs instead of silently selecting only the referenced word ID.

## Event and markup model

The current prototype makes an entire result card a single button. That model
cannot contain component buttons or links because nested interactive controls
are invalid and produce confusing keyboard behavior.

The implemented result should instead be a non-button container with:

- A semantic result heading and metadata.
- Separate buttons or query links for every component.
- A dedicated expansion control with `aria-expanded` and `aria-controls`.
- An optional background click target that invokes the same expansion action.

Component activation must not propagate to the background expansion action.
The expansion control needs a visible keyboard focus state and an accessible
name such as `Show split modes for 選挙管理委員会`.

Unit badges communicate useful distinctions visually, but their A/B/C text must
remain available to assistive technology. Color alone must not encode the unit.

## Data requirements

The extraction dataset preserves `word_structure`, A-split, and B-split word-ID
references. The browser build resolves them to cumulative code-point boundaries
within the parent surface. The build pipeline should:

- Preserve upstream word IDs in the extraction report for validation and
  provenance, but omit them from browser records.
- Validate that every referenced system word is in range.
- Validate that referenced component lengths form strictly increasing one-byte
  boundaries covering the parent surface.
- Store Structure, A, and B boundaries eagerly with the parent record.
- Reconstruct component labels from the parent surface without loading
  component record shards.
- Report Structure entry counts, reference counts, unresolved references, and
  component-count distribution for both Core and Full.

The Structure field must remain distinct in the logical and binary models even
when its components happen to equal an entry's A or B split.

## Ranking and state implications

Navigation does not alter search ranking. The clicked component becomes a normal
query and is ranked by the same rules as typed input.

Expanded state belongs to the current query result set. It is cleared when the
query changes, including component navigation. A later enhancement may restore
the expanded entry when navigating Back, but query and scroll restoration are
more important than expansion restoration for the first implementation.

## Acceptance criteria

The interaction is complete when automated and browser tests demonstrate that:

- A, B, and C entries receive the correct badges.
- A entries are not offered meaningless split expansion.
- An A surface can initiate a lookup when it differs from the current normalized
  query, while an exact self-match remains plain text.
- B entries expand to A only.
- C entries expand to B and A only.
- B and C collapsed headings use Structure components when available.
- Every Structure, A, and B component can initiate a lookup.
- Component activation does not also toggle the originating result.
- Browser Back returns to the previous query after component navigation.
- Homographs remain visible after searching a component surface.
- Keyboard and screen-reader users can distinguish navigation from expansion.
- Long component sequences wrap without horizontal overflow on mobile screens.

The normal TypeScript, application build, sample-format tests, Rust tests, and
generated Core/Full structural validation must pass before this feature is
published.
