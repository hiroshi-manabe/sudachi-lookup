# Dictionary Edition Membership

English | [日本語](ja/edition-membership.md)

## Decision

Each canonical lookup result identifies the smallest official SudachiDict
edition containing that entry:

- `収録: Small` means the entry is present in Small, Core, and Full.
- `収録: Core` means the entry is present in Core and Full, but not Small.
- `収録: Full` means the entry is present only in Full.

The sample fixture does not display an edition because it is not an official
SudachiDict edition.

## Compact representation

Official editions in the pinned `20260428` release are cumulative word-ID
ranges. The complete neutral exports establish these exact boundaries:

| Smallest edition | Canonical word-ID range | Source records |
| --- | ---: | ---: |
| Small | `0`–`765648` | 765,649 |
| Core | `765649`–`1629079` | 863,431 additions |
| Full | `1629080`–`2883176` | 1,254,097 additions |

The manifest stores only `smallUpperExclusive` and `coreUpperExclusive` under
`editionMembership`. The Worker compares the canonical result ID with those
boundaries and returns `Small`, `Core`, or `Full` to the interface. No edition
byte or repeated string is added to browser record shards.

Membership belongs to a dictionary record, not a surface string. Distinct
homographs can consequently have different edition labels. Inflection records
do not create visible exceptions because search results already resolve to
their canonical dictionary-form word IDs.

## Release validation

Word-ID ordering is a verified property of a pinned release, not an assumption
about every future SudachiDict release. The production workflow installs and
exports all three official packages, then proves line by line that:

1. Small contains exactly the configured number of records.
2. Every Small record is identical to the corresponding Core and Full record.
3. Core contains exactly the configured number of records.
4. Every Core record is identical to the corresponding Full record.
5. Full contains exactly the configured number of records.

Generation fails if a boundary is empty, unordered, or outside the selected
dataset. Browser-data validation also requires the manifest boundaries and
entry count to match `config/dictionary-release.json`. A future release whose
editions are not cumulative must use an explicit membership representation
instead of silently retaining the range rule.
