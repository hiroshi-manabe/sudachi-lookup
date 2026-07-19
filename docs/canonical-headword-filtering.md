# Canonical Headword Filtering

## Status

Design decision recorded for the next browser-data iteration. This policy is
not implemented in format v4.

## Product distinction

Sudachi's system dictionary is built for morphological analysis. It contains
lexicon records for conjugation states that a tokenizer needs, even when those
records are not useful as independent dictionary results.

Sudachi Lookup is a headword browser, not a tokenizer-inspection tool. Its web
dataset should therefore expose canonical dictionary entries while the neutral
offline export continues to preserve every pinned Sudachi record.

The pinned Core data illustrates the difference. Fourteen records have
`食べる` as their dictionary form, including:

```text
食べ      未然形-一般
食べ      連用形-一般
食べよ    命令形
食べよう  意志推量形
食べりゃ  仮定形-融合
食べる    終止形-一般
食べる    連体形-一般
食べれ    仮定形-一般
食べろ    命令形
食べん    終止形/連体形-撥音便
```

Those records are useful when Sudachi analyzes running text. Presenting them as
separate lookup results for the same headword adds noise, aliases, candidates,
and record hydration without adding corresponding dictionary value.

This policy does not synthesize or analyze arbitrary inflected input.
`食べた` remains outside the lookup index because Sudachi treats it as
`食べ` plus the auxiliary `た`. The canonical auxiliary entry for `た` remains
independently searchable.

## Canonical identity

Filtering must use Sudachi's upstream dictionary-form word identity, not a
string heuristic such as `surface == dictionaryForm` and not conjugation-form
labels alone.

The neutral export should add the dictionary-form word ID for every record and
validate that it resolves within the pinned system dictionary. Browser-data
generation can then map each inflectional record to its canonical entry.

The generator must preserve distinct canonical identities even when they share
the same surface or dictionary-form spelling. Homographs, readings, POS
distinctions, and genuinely independent lexical entries must not be collapsed
merely because their text matches.

If an upstream record lacks a valid canonical identity, generation should
report it and retain it by default. Silent deletion based on an uncertain
heuristic is not acceptable.

## Search behavior

For an inflecting headword such as `食べる`, the browser index should expose one
canonical result. Its aliases may include the canonical surface, dictionary
form, normalized form, and canonical reading.

Expected behavior:

| Query | Expected result |
| --- | --- |
| `食べる` | Canonical `食べる` headword |
| `食べ` | Canonical `食べる` through prefix search |
| `タベル` / `たべる` | Canonical `食べる` through reading aliases |
| `食べよう` | No match solely because it is an inflected Sudachi record |
| `食べた` | No automatic conjugation analysis; `た` remains its own entry |

Literal canonical entries must continue to outrank normalized, dictionary-form,
and reading aliases. Match-source metadata may later explain why a canonical
headword matched, but filtering does not depend on exposing that metadata.

## Staged implementation

### Stage 1: filter search aliases

- Preserve every record in the neutral export and browser record shards.
- Add and validate the upstream dictionary-form word ID.
- Emit search aliases only for canonical browser entries.
- Rebuild bootstrap data from the filtered aliases.
- Measure entry, alias, shard, candidate, and cold-query reductions for Core
  and Full.

Keeping the existing record ID space makes this stage comparatively small and
isolates the user-visible policy from storage compaction.

### Stage 2: compact browser records

After Stage 1 behavior is accepted:

- Omit browser records that no search result can address.
- Assign a compact browser entry-ID space.
- Rewrite search postings to those IDs.
- Retain a release report mapping browser IDs to pinned Sudachi word IDs.

Format v4's surface-boundary representation makes this easier: Structure, A,
and B display data no longer require component record IDs to remain present in
the browser corpus.

## Validation and exceptions

Before enabling the filter, Core and Full generation must report and verify:

- Total source records and canonical browser entries.
- Number and distribution of records per canonical identity.
- Canonical identities that cannot be resolved.
- Canonical entries sharing a spelling but remaining distinct.
- Alias, search-shard, and browser-record size changes.
- Representative verbs, adjectives, auxiliaries, irregular forms, and
  non-inflecting entries.
- No search posting referencing a removed or unmapped browser record.

Regression checks should include at least `食べる`, `する`, `来る`, an
i-adjective, a na-adjective, and the auxiliary `た`. Entries whose inflected
surface is independently lexicalized must remain available through their own
canonical identity rather than through the discarded inflectional record.

## Expected effect

Canonical filtering should make result sets read like a dictionary rather than
Sudachi's internal tokenizer lexicon. It should also reduce alias counts and the
amount of work required for broad-prefix ranking. The actual size and latency
benefit must be measured after Stage 1; it is a consequence of the product
policy, not the reason to apply an unsafe grouping heuristic.

