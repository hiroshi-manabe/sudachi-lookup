# Reverse Structure Lookup Plan

## Status

Planned optional feature. This document defines the product and data design but
does not commit the project to implementing it. Ordinary prefix lookup and the
existing component-navigation behavior remain unchanged.

## Purpose

Sudachi Lookup currently moves from a compound to one of its displayed
components by searching that component's surface as text. Reverse Structure
lookup would support the opposite exploration:

> Find canonical headwords whose direct `word_structure` ends with this entry.

For example, activating the relationship lookup from the dictionary entry for
`委員会` may return `選挙管理委員会` when its Structure is
`選挙 / 管理 / 委員会`.

This is a relationship query, not prefix or suffix string matching. A typed
query for `委員会` continues to search aliases by text. Relationship mode is
entered only from a particular dictionary result and therefore carries a
Sudachi word identity.

## Initial semantic scope

The first implementation should use deliberately narrow semantics:

- Inspect only the final direct component of `word_structure`.
- Do not inspect A- or B-unit split lists.
- Do not recursively descend into nested Structure components.
- Do not infer relationships from matching surface suffixes.
- Return only canonical dictionary-form parent entries, following the existing
  headword-filtering policy.
- Canonicalize a referenced component through its dictionary-form word ID before
  adding the relationship, so a searchable headword can address relationships
  that originate from an internal inflection-state identity.
- Deduplicate a parent under a component identity.

Indexing every Structure position is a plausible later extension, but it should
be a different relationship mode rather than a silent expansion of these
semantics.

## Interaction model

### Entering relationship mode

A result may offer a secondary action such as:

```text
この語を後部の構造に持つ語
```

Activating it uses that result's canonical word ID. It must not perform a text
lookup or toggle the result's split expansion. The exact visual placement
should be tested against the existing headword, web-search, metadata, and split
controls before implementation; the action should remain clearly secondary.

### Search control

Ordinary mode retains the editable text input:

```text
Sudachi辞書を検索
[ 委員会                                      ]
```

Relationship mode replaces the editable value with one non-editable token:

```text
後部の構造に持つ語を検索
[  委員会  ×                                  ]
```

The token represents the selected word ID, not merely its visible surface. Its
surface is a label for that identity. This distinction keeps homographs
unambiguous: typing the same characters performs ordinary text search, while
entering through a result performs an identity-based relationship lookup.

The search control should behave as follows:

- The token has no text caret and cannot be edited in place.
- Its `×` button clears relationship mode, returns to an empty ordinary input,
  and focuses that input.
- The clear button has an accessible name such as
  `構造検索を解除して通常検索に戻る`.
- Delete or Backspace clears the token while the search control is focused.
- Clearing the token cancels or invalidates outstanding relationship work.
- Browser Back and Forward restore both the mode and selected identity.
- IME composition applies only to ordinary text mode.
- A direct URL initially shows a token-loading state until the selected record
  supplies its surface and reading.

The result heading should name the relationship explicitly:

```text
「委員会」を後部の構造に持つ語
```

Empty, loading, error, result-count, and continuation messages must not imply
that a prefix text search is running.

### URL and state

Use mutually exclusive query representations:

```text
?q=委員会          ordinary text lookup
?tail=123456       reverse Structure lookup by canonical word ID
```

`tail` wins only when it is a valid unsigned word ID for the active dictionary
artifact. An invalid or unavailable identity should produce a recoverable
Japanese error and offer a return to ordinary search. The URL does not need to
duplicate the surface: a direct visit can load the existing record shard for
the ID, while same-session history may render the cached label immediately.

The UI state should be modeled as a tagged union rather than parallel query
flags:

```ts
type LookupMode =
  | { kind: "text"; query: string }
  | { kind: "structure-tail"; componentId: number; surface?: string };
```

## Reverse-index data

### Logical form

Build the index offline from the neutral export before Structure word-ID
references are reduced to display boundaries:

```text
canonical component word ID
    -> pre-ranked canonical parent word IDs
```

No component strings, parent strings, POS values, or complete records belong in
this index. Existing record shards hydrate visible parents after the reverse
index supplies their IDs.

Parent postings should be ranked deterministically offline so a broad relation
does not require loading thousands of parent records before showing its first
page. The initial ranking should reuse the ordinary result principles where
possible:

1. lower Sudachi word cost;
2. shorter parent surface;
3. lower parent word ID as the stable final tie-breaker.

The exact ranking should be measured on common and very broad components before
the format is frozen.

### Encoding and sharding

Add a versioned manifest section that routes component word-ID ranges to lazy
reverse-index shards. A candidate binary shard contains:

- a format magic and version;
- delta-encoded component word IDs;
- a posting count per component;
- pre-ranked parent IDs encoded as compact unsigned values or signed deltas;
- optional per-list continuation offsets if needed by large postings.

Compress each shard with gzip, as with the current bootstrap and POS table, and
decode it inside the Web Worker. Target roughly 64–128 KiB transferred per
shard and keep an explicit maximum below the existing Pages asset budget. The
manifest routing table should be sufficient to select a shard from a component
ID; no reverse index is fetched during ordinary startup or ordinary text
search.

### Measured scale

The July 2026 neutral Core and Full exports give the following tail-only counts
after canonical parent filtering:

| Measure | Core | Full |
| --- | ---: | ---: |
| Canonical searchable entries | 1,198,652 | 2,452,463 |
| Canonical parents with Structure | 573,277 | 1,487,960 |
| Distinct direct tail components | 114,943 | 290,200 |
| Median parent postings | 3 | 2 |
| p95 parent postings | 11 | 13 |
| p99 parent postings | 35 | 52 |
| Maximum parent postings | 15,084 | 15,084 |

A simulation using component-ID deltas, parent-ID deltas, and one gzip stream
produced:

| Artifact | Core | Full |
| --- | ---: | ---: |
| Compact decoded bytes | 1,606,003 | 4,148,587 |
| Simulated gzip bytes | 1,191,042 | 3,410,188 |
| Production sharded budget | 1.3–1.6 MiB | 3.6–4.2 MiB |

The single-stream gzip result is a lower-bound experiment, not a committed file
format. Independent shards, pre-ranked rather than monotonically sorted parent
IDs, headers, and routing metadata may increase it. The format prototype should
therefore enforce a conservative Full transfer budget of 6 MiB until its real
encoding is measured.

For context, indexing every distinct component position produced approximately
1.40 MiB compressed for Core and 4.63 MiB for Full in the same simulation.
Storage is therefore not the principal product risk.

## Worker and result loading

Extend the Worker protocol with an explicit relationship request rather than
overloading the text-search message. The flow is:

```text
component word ID
    -> manifest range route
    -> one lazy reverse-index shard
    -> stable first page of pre-ranked parent IDs
    -> existing result slots and record-shard hydration
    -> continuation pages from the same posting list
```

The ordinary result-slot mechanism can be reused. Relationship sessions still
need monotonically increasing request IDs, stale-response rejection, stable
deduplication, and progressive record hydration. Bootstrap and text-search
shards are not involved.

Return 20 initial IDs and then the existing 50-result continuation pages. Very
broad postings require the same automatic continuation behavior and explicit
retry path as broad text results. Cache decoded reverse shards separately under
the Worker's memory budget.

## Validation

The builder and generated-data validator should prove that:

- every indexed component and parent ID is in range;
- every parent is a canonical searchable identity;
- every relationship corresponds to the canonicalized final direct
  `word_structure` reference in the neutral export;
- no parent is duplicated within one posting list;
- every posting list follows the declared deterministic rank;
- shard ranges are ordered, non-overlapping, complete, and size-bounded;
- Core and Full counts and byte totals are reported reproducibly;
- the sample fixture covers homographs, no-parent components, multiple parents,
  a broad component, and canonicalization through dictionary-form IDs.

Application tests should cover:

- entering the mode from a particular result rather than from its text alone;
- non-editable token behavior and clear-button labeling;
- Delete and Backspace clearing the token;
- ordinary typing remaining an ordinary text search;
- direct URL loading and Back/Forward restoration;
- stale text and relationship responses never replacing the active mode;
- empty, error, hydration, continuation, and retry states in Japanese;
- result actions not also toggling split expansion;
- keyboard, screen-reader, narrow-screen, and long-label behavior.

## Implementation phases

### Phase 1: format experiment

- Add measurement code to the dictionary builder without changing v9 output.
- Compare source-ID order, absolute varints, and pre-ranked signed-delta
  encodings.
- Measure sharded Core and Full bytes, maximum shard size, and common posting
  distributions.
- Confirm canonicalization behavior for component references.
- Freeze a new browser-data format version only after these results pass the
  6 MiB Full budget.

### Phase 2: generated data and validation

- Emit reverse-index shards and manifest routing metadata.
- Extend the deterministic sample fixture with relationship cases.
- Add structural and ranking validation for Core and Full.
- Keep all reverse assets lazy and absent from bootstrap startup traffic.

### Phase 3: Worker relationship session

- Add the distinct request and session type.
- Route and cache reverse shards.
- Reuse stable result slots, record hydration, pagination, retry, and stale-work
  cancellation.
- Add unit and integration fixtures before changing the visible interface.

### Phase 4: token-mode interface

- Add the result-level entry action.
- Replace editable text with the non-editable identity token in relationship
  mode.
- Implement clear, Delete, Backspace, focus, URL, history, and direct-load
  behavior.
- Add relationship-specific Japanese status and result copy.
- Verify responsive and accessible interaction without weakening ordinary
  typing or IME behavior.

### Phase 5: staged release

- Exercise the sample locally and through its Pages preview.
- Deploy and measure Core staging, including cold reverse-shard and record-shard
  requests.
- Deploy Full staging only after Core behavior and budgets are acceptable.
- Treat production enablement as a separate decision after observing usefulness
  and ranking quality.

## Deferred choices

The first implementation should not include these unless measurements or use
cases justify them:

- matching a component at any Structure position;
- recursive ancestor traversal;
- A- or B-split reverse relationships;
- combining multiple component tokens;
- editable relationship tokens;
- mixing relationship parents into ordinary prefix results;
- server-side analytics, ranking, or search.
