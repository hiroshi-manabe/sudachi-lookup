# Canonical Headword Filtering

## Status

Stage 1 is implemented in browser-data format v5 and retained through v7 for both
pinned Core and Full editions. Search aliases and bootstrap results refer only
to canonical dictionary-form identities. The neutral export and browser record
shards still retain every source record. Stage 2 record compaction remains
optional future work.

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

For an inflecting headword such as `食べる`, the browser index exposes canonical
results rather than its conjugation-state records. Its aliases may include the
canonical surface, dictionary form, normalized form, and canonical reading.
Separately canonical identities are intentionally preserved, including variant
spellings whose normalized form is also `食べる`.

Expected behavior:

| Query | Expected result |
| --- | --- |
| `食べる` | Canonical headwords matching `食べる`; no conjugation-state duplicates |
| `食べ` | Canonical `食べる` through prefix search |
| `タベル` / `たべる` | Canonical `食べる` through reading aliases |
| `食べよう` | No match solely because it is an inflected Sudachi record |
| `食べた` | No automatic conjugation analysis; `た` remains its own entry |

Literal canonical entries must continue to outrank normalized, dictionary-form,
and reading aliases. Match-source metadata may later explain why a canonical
headword matched, but filtering does not depend on exposing that metadata.

## Staged implementation

### Stage 1: filter search aliases (implemented in v5 through v7)

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

Formats v5 through v7 retain v4's surface-boundary representation, which makes this
easier: Structure, A, and B display data no longer require component record IDs
to remain present in the browser corpus.

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

## Measured effect

The pinned 20260428 builds produce the following Stage 1 comparison. Directory
sizes are local raw filesystem totals; record shards remain unchanged apart
from the format-version header.

| Measurement | Core v4 | Core v5 | Full v4 | Full v5 |
| --- | ---: | ---: | ---: | ---: |
| Source records | 1,629,080 | 1,629,080 | 2,883,177 | 2,883,177 |
| Searchable canonical entries | 1,629,080 | 1,198,652 | 2,883,177 | 2,452,463 |
| Filtered inflection records | 0 | 430,428 | 0 | 430,714 |
| Search aliases | 8,140,461 | 5,988,321 | 14,410,650 | 12,257,080 |
| Search shards | 1,629 | 1,198 | 2,883 | 2,452 |
| Total dictionary files | 2,427 | 1,996 | 4,293 | 3,862 |
| Bootstrap bytes | 303,834 | 226,793 | 414,504 | 342,160 |
| Generated directory | 452 MiB | 401 MiB | 837 MiB | 786 MiB |

Core removes 26.4% of its aliases; Full removes 14.9%. Both save about 51 MiB
without compacting record storage. Generator validation also confirms that
every noncanonical record resolves to an in-range canonical identity whose
surface equals the record's upstream dictionary form.

The v5 bootstrap is ranked for the actual one-character query rather than by
dictionary cost alone. For the broad query `い`, its first 20 Core candidates
exactly match the first 20 candidates from the complete 51,339-result search.
This prevents stronger exact matches from appearing only after “load more.”

Format v6 superseded that alias-based bootstrap with direct top-20 results and
deduplicated display records. Format v7 expands the decoded budget to 4 MiB,
gzip-compresses it for transfer, and allows high record-shard cost to qualify a
prefix independently of the broad-alias threshold. Core selects 2,060 of 9,047
eligible prefixes and embeds 39,660 records in 775,326 transferred bytes; Full
selects 2,079 of 22,501 and embeds 40,082 records in 784,848 bytes. The decoded
sizes remain just below 4 MiB. Core checks for `い`, `あい`, `あお`, and `あきの`
reproduce the complete search's top 20 and can render those results without
another dictionary request.

## Product effect

Canonical filtering makes result sets read like a dictionary rather than
Sudachi's internal tokenizer lexicon. It also reduces alias counts and the
amount of work required for broad-prefix ranking. The size and latency benefit
is a consequence of the product policy, not the reason to apply an unsafe
grouping heuristic.
