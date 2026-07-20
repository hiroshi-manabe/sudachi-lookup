use flate2::read::GzDecoder;
use flate2::{write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::{hash_map::Entry as HashEntry, HashMap, HashSet, VecDeque},
    env,
    error::Error,
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    time::Instant,
};
use unicode_normalization::UnicodeNormalization;

const FORMAT_VERSION: u16 = 10;
const RECORD_SPAN: u32 = 2_048;
const MAX_ALIASES_PER_SHARD: usize = 5_000;
const INITIAL_RESULTS: usize = 20;
const BOOTSTRAP_BUDGET_BYTES: usize = 5 * 1024 * 1024 / 2;
const BOOTSTRAP_MIN_SEARCH_BYTES: u64 = 192 * 1024;
const BOOTSTRAP_MIN_BROAD_ALIASES: usize = 500;
const BOOTSTRAP_MIN_DESCENT_ALIASES: usize = 100;
const BOOTSTRAP_MIN_RECORD_BYTES: u64 = 1024 * 1024;
const STRUCTURE_SHARD_TARGET_BYTES: usize = 128 * 1024;

#[derive(Deserialize)]
struct SourceEntry {
    word_id: u32,
    surface: String,
    reading_form: String,
    normalized_form: String,
    dictionary_form: String,
    dictionary_form_word_id: i32,
    pos_id: u16,
    cost: i16,
    a_split: Vec<u32>,
    b_split: Vec<u32>,
    word_structure: Vec<u32>,
}

#[derive(Deserialize)]
struct SurfaceEntry {
    word_id: u32,
    surface: String,
    dictionary_form: String,
    dictionary_form_word_id: i32,
    pos_id: u16,
    pos: Vec<String>,
    cost: i16,
}

struct SourceIndex {
    surfaces: Vec<String>,
    dictionary_form_word_ids: Vec<i32>,
    searchable_entries: u64,
    pos_entries: Vec<(u16, String)>,
    costs: Vec<i16>,
    surface_lengths: Vec<u16>,
}

#[derive(Default)]
struct StructurePostings {
    first: Vec<u32>,
    last: Vec<u32>,
}

#[derive(Clone)]
struct Alias {
    key: String,
    id: u32,
    kind: u8,
    cost: i16,
    surface_length: u16,
}

struct BootstrapEntry {
    prefix: String,
    ids: Vec<u32>,
}

struct BootstrapCandidate {
    canonical_prefix: String,
    entries: Vec<BootstrapEntry>,
    matching_aliases: usize,
    search_bytes: u64,
    search_shards: usize,
    record_shards: usize,
    record_bytes: u64,
}

struct BootstrapBuild {
    entries: Vec<BootstrapEntry>,
    record_ids: Vec<u32>,
    candidate_prefixes: usize,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchShard {
    lower: String,
    upper: String,
    file: String,
    aliases: usize,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordManifest {
    span: u32,
    files: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StructureShard {
    lower: u32,
    upper: u32,
    file: String,
    components: usize,
    first_relationships: usize,
    last_relationships: usize,
    bytes: u64,
    decoded_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StructureManifest {
    compression: &'static str,
    identity: &'static str,
    positions: [&'static str; 2],
    components: usize,
    first_relationships: usize,
    last_relationships: usize,
    shards: Vec<StructureShard>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SizeStats {
    minimum: u64,
    median: u64,
    p95: u64,
    maximum: u64,
    total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u16,
    dataset: String,
    entries: u64,
    searchable_entries: u64,
    filtered_inflection_entries: u64,
    aliases: usize,
    pos_table_file: String,
    pos_count: usize,
    pos_table_bytes: u64,
    pos_table_decoded_bytes: u64,
    pos_compression: &'static str,
    pos_encoding: &'static str,
    bootstrap_file: String,
    bootstrap_prefixes: usize,
    bootstrap_records: usize,
    bootstrap_candidate_prefixes: usize,
    bootstrap_bytes: u64,
    bootstrap_decoded_bytes: u64,
    bootstrap_budget_bytes: usize,
    bootstrap_compression: &'static str,
    bootstrap_min_search_bytes: u64,
    bootstrap_min_broad_aliases: usize,
    bootstrap_min_descent_aliases: usize,
    bootstrap_min_record_bytes: u64,
    search_shards: Vec<SearchShard>,
    records: RecordManifest,
    structure_matches: StructureManifest,
    search_size: SizeStats,
    record_size: SizeStats,
    split_encoding: &'static str,
    headword_filter: &'static str,
    kana_ranking: &'static str,
    source_sha256: String,
    elapsed_seconds: f64,
}

struct BinaryWriter {
    bytes: Vec<u8>,
}

impl BinaryWriter {
    fn new(magic: &[u8; 4], count: u32) -> Self {
        let mut writer = Self { bytes: Vec::new() };
        writer.bytes.extend_from_slice(magic);
        writer.u16(FORMAT_VERSION);
        writer.u32(count);
        writer
    }

    fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn i16(&mut self, value: i16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn string(&mut self, value: &str) -> Result<(), Box<dyn Error>> {
        let bytes = value.as_bytes();
        let length = u16::try_from(bytes.len()).map_err(|_| "string exceeds format limit")?;
        self.u16(length);
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    fn boundaries(&mut self, values: &[u8]) -> Result<(), Box<dyn Error>> {
        let count = u8::try_from(values.len()).map_err(|_| "split exceeds format limit")?;
        self.u8(count);
        self.bytes.extend_from_slice(values);
        Ok(())
    }
}

fn normalize(value: &str) -> String {
    value
        .nfkc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn to_hiragana(value: &str) -> String {
    value
        .chars()
        .map(|character| match character as u32 {
            code @ 0x30a1..=0x30f6 => char::from_u32(code - 0x60).unwrap_or(character),
            _ => character,
        })
        .collect()
}

fn to_katakana(value: &str) -> String {
    value
        .chars()
        .map(|character| match character as u32 {
            code @ 0x3041..=0x3096 => char::from_u32(code + 0x60).unwrap_or(character),
            _ => character,
        })
        .collect()
}

fn add_aliases(aliases: &mut Vec<Alias>, entry: &SourceEntry) {
    let surface_length = entry.surface.chars().count().min(u16::MAX as usize) as u16;
    let candidates = [
        (&entry.surface, 0),
        (&entry.dictionary_form, 1),
        (&entry.normalized_form, 2),
        (&entry.reading_form, 3),
    ];
    for (value, kind) in candidates {
        let key = normalize(value);
        if !key.is_empty() {
            aliases.push(Alias {
                key: key.clone(),
                id: entry.word_id,
                kind,
                cost: entry.cost,
                surface_length,
            });
            if kind == 3 {
                let hiragana = to_hiragana(&key);
                if hiragana != key {
                    aliases.push(Alias {
                        key: hiragana,
                        id: entry.word_id,
                        kind,
                        cost: entry.cost,
                        surface_length,
                    });
                }
            }
        }
    }
}

fn split_boundaries(
    entry: &SourceEntry,
    split: &[u32],
    surfaces: &[String],
    label: &str,
) -> Result<Vec<u8>, Box<dyn Error>> {
    if split.is_empty() {
        return Ok(Vec::new());
    }
    if split.len() < 2 {
        return Err(format!(
            "{} {label} split has fewer than two components",
            entry.word_id
        )
        .into());
    }

    let parent_length = entry.surface.chars().count();
    let mut consumed = 0_usize;
    let mut previous = 0_usize;
    let mut boundaries = Vec::with_capacity(split.len() - 1);
    for (index, id) in split.iter().enumerate() {
        let component = surfaces.get(*id as usize).ok_or_else(|| {
            format!(
                "{} {label} split references missing entry {id}",
                entry.word_id
            )
        })?;
        consumed += component.chars().count();
        if index + 1 < split.len() {
            if consumed <= previous || consumed >= parent_length {
                return Err(format!(
                    "{} {label} split reaches invalid boundary {consumed} for surface length {parent_length}",
                    entry.word_id,
                )
                .into());
            }
            boundaries.push(u8::try_from(consumed).map_err(|_| {
                format!(
                    "{} {label} split boundary {consumed} exceeds u8",
                    entry.word_id
                )
            })?);
            previous = consumed;
        }
    }
    if consumed != parent_length {
        return Err(format!(
            "{} {label} component lengths total {consumed}, expected {parent_length}",
            entry.word_id,
        )
        .into());
    }
    Ok(boundaries)
}

fn write_record(
    writer: &mut BinaryWriter,
    entry: &SourceEntry,
    surfaces: &[String],
) -> Result<(), Box<dyn Error>> {
    writer.u32(entry.word_id);
    writer.i16(entry.cost);
    writer.string(&entry.surface)?;
    writer.string(&entry.reading_form)?;
    writer.string(&entry.normalized_form)?;
    writer.string(&entry.dictionary_form)?;
    writer.u16(entry.pos_id);
    writer.boundaries(&split_boundaries(entry, &entry.a_split, surfaces, "A")?)?;
    writer.boundaries(&split_boundaries(entry, &entry.b_split, surfaces, "B")?)?;
    writer.boundaries(&split_boundaries(
        entry,
        &entry.word_structure,
        surfaces,
        "Structure",
    )?)?;
    Ok(())
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<u64, Box<dyn Error>> {
    let mut output = BufWriter::new(File::create(path)?);
    output.write_all(bytes)?;
    output.flush()?;
    Ok(bytes.len() as u64)
}

fn write_alias_file(path: &Path, aliases: &[Alias]) -> Result<u64, Box<dyn Error>> {
    let mut writer = BinaryWriter::new(b"SDSH", aliases.len() as u32);
    for alias in aliases {
        writer.string(&alias.key)?;
        writer.u32(alias.id);
        writer.u8(alias.kind);
        writer.i16(alias.cost);
        writer.u16(alias.surface_length);
    }
    write_file(path, &writer.bytes)
}

fn write_pos_table(path: &Path, entries: &[(u16, String)]) -> Result<(u64, u64), Box<dyn Error>> {
    let mut writer = BinaryWriter::new(b"SDPO", entries.len() as u32);
    for (id, value) in entries {
        writer.u16(*id);
        writer.string(value)?;
    }
    let decoded_bytes = writer.bytes.len() as u64;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&writer.bytes)?;
    let compressed = encoder.finish()?;
    Ok((write_file(path, &compressed)?, decoded_bytes))
}

fn write_structure_shard(
    path: &Path,
    postings: &[(u32, StructurePostings)],
) -> Result<(u64, u64), Box<dyn Error>> {
    let mut writer = BinaryWriter::new(b"SDSM", postings.len() as u32);
    for (component_id, values) in postings {
        writer.u32(*component_id);
        writer.u32(values.first.len() as u32);
        writer.u32(values.last.len() as u32);
        for parent_id in &values.first {
            writer.u32(*parent_id);
        }
        for parent_id in &values.last {
            writer.u32(*parent_id);
        }
    }
    let decoded_bytes = writer.bytes.len() as u64;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&writer.bytes)?;
    let compressed = encoder.finish()?;
    Ok((write_file(path, &compressed)?, decoded_bytes))
}

fn build_structure_shards(
    output: &Path,
    postings: HashMap<u32, StructurePostings>,
    source: &SourceIndex,
) -> Result<StructureManifest, Box<dyn Error>> {
    let mut postings: Vec<_> = postings.into_iter().collect();
    for (_, values) in &mut postings {
        let rank = |left: &u32, right: &u32| {
            source.costs[*left as usize]
                .cmp(&source.costs[*right as usize])
                .then(source.surface_lengths[*left as usize].cmp(&source.surface_lengths[*right as usize]))
                .then(left.cmp(right))
        };
        values.first.sort_unstable_by(rank);
        values.first.dedup();
        values.last.sort_unstable_by(rank);
        values.last.dedup();
    }
    postings.sort_unstable_by_key(|(component_id, _)| *component_id);

    fs::create_dir_all(output.join("structure"))?;
    let mut shards = Vec::new();
    let mut start = 0;
    while start < postings.len() {
        let mut end = start;
        let mut decoded = 10_usize;
        while end < postings.len() {
            let values = &postings[end].1;
            let bytes = 12 + 4 * (values.first.len() + values.last.len());
            if end > start && decoded + bytes > STRUCTURE_SHARD_TARGET_BYTES {
                break;
            }
            decoded += bytes;
            end += 1;
        }
        let values = &postings[start..end];
        let index = shards.len();
        let file = format!("structure/{index:05}.bin.gz");
        let (bytes, decoded_bytes) = write_structure_shard(&output.join(&file), values)?;
        shards.push(StructureShard {
            lower: values.first().unwrap().0,
            upper: values.last().unwrap().0,
            file,
            components: values.len(),
            first_relationships: values.iter().map(|(_, item)| item.first.len()).sum(),
            last_relationships: values.iter().map(|(_, item)| item.last.len()).sum(),
            bytes,
            decoded_bytes,
        });
        start = end;
    }
    Ok(StructureManifest {
        compression: "gzip",
        identity: "canonical-dictionary-form-word-id",
        positions: ["first", "last"],
        components: postings.len(),
        first_relationships: shards.iter().map(|shard| shard.first_relationships).sum(),
        last_relationships: shards.iter().map(|shard| shard.last_relationships).sum(),
        shards,
    })
}

fn bootstrap_entry_bytes(entry: &BootstrapEntry) -> usize {
    2 + entry.prefix.len() + 1 + entry.ids.len() * 4
}

fn write_bootstrap_file(
    path: &Path,
    bootstrap: &BootstrapBuild,
    input: &Path,
    surfaces: &[String],
) -> Result<u64, Box<dyn Error>> {
    let selected_ids: HashSet<u32> = bootstrap.record_ids.iter().copied().collect();
    let mut writer = BinaryWriter::new(b"SDBP", bootstrap.entries.len() as u32);
    for entry in &bootstrap.entries {
        writer.string(&entry.prefix)?;
        writer.u8(u8::try_from(entry.ids.len()).map_err(|_| "too many bootstrap results")?);
        for id in &entry.ids {
            writer.u32(*id);
        }
    }
    writer.u32(bootstrap.record_ids.len() as u32);
    for line in source_reader(input)?.lines() {
        let entry: SourceEntry = serde_json::from_str(&line?)?;
        if selected_ids.contains(&entry.word_id) {
            write_record(&mut writer, &entry, surfaces)?;
        }
    }
    if writer.bytes.len() > BOOTSTRAP_BUDGET_BYTES {
        return Err("bootstrap exceeds byte budget".into());
    }
    let decoded_bytes = writer.bytes.len() as u64;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&writer.bytes)?;
    let compressed = encoder.finish()?;
    write_file(path, &compressed)?;
    Ok(decoded_bytes)
}

fn alias_order(left: &Alias, right: &Alias) -> Ordering {
    left.key
        .cmp(&right.key)
        .then(left.id.cmp(&right.id))
        .then(left.kind.cmp(&right.kind))
}

fn match_score(alias: &Alias, variant: &str, literal_query: &str) -> u8 {
    let exact = if alias.key == variant { 0 } else { 20 };
    let base = exact + [0, 4, 2, 6][alias.kind as usize];
    base * 2 + u8::from(variant != literal_query)
}

fn query_variants(prefix: &str) -> Vec<String> {
    let mut variants = vec![prefix.to_owned(), to_hiragana(prefix), to_katakana(prefix)];
    variants.sort_unstable();
    variants.dedup();
    variants
}

fn prefix_range(aliases: &[Alias], prefix: &str) -> std::ops::Range<usize> {
    let start = aliases.partition_point(|alias| alias.key.as_str() < prefix);
    let mut upper = prefix.to_owned();
    upper.push(char::MAX);
    let end = aliases.partition_point(|alias| alias.key.as_str() <= upper.as_str());
    start..end
}

fn bootstrap_ranges(aliases: &[Alias], prefix: &str) -> Vec<(String, std::ops::Range<usize>)> {
    query_variants(prefix)
        .into_iter()
        .filter_map(|variant| {
            let range = prefix_range(aliases, &variant);
            (!range.is_empty()).then_some((variant, range))
        })
        .collect()
}

fn rank_prefix(
    aliases: &[Alias],
    ranges: &[(String, std::ops::Range<usize>)],
    literal_query: &str,
) -> Vec<u32> {
    let mut best_by_entry: HashMap<u32, (u8, &Alias)> = HashMap::new();
    for (variant, range) in ranges {
        for alias in &aliases[range.clone()] {
            let score = match_score(alias, variant, literal_query);
            let best = best_by_entry.entry(alias.id).or_insert((score, alias));
            if score < best.0 {
                *best = (score, alias);
            }
        }
    }
    let mut ranked: Vec<(u8, &Alias)> = best_by_entry.into_values().collect();
    ranked.sort_unstable_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.cost.cmp(&right.1.cost))
            .then(left.1.surface_length.cmp(&right.1.surface_length))
            .then(left.1.id.cmp(&right.1.id))
    });
    ranked
        .into_iter()
        .take(INITIAL_RESULTS)
        .map(|(_, alias)| alias.id)
        .collect()
}

fn build_bootstrap(
    aliases: &[Alias],
    search_sizes: &[u64],
    record_sizes: &[u64],
    record_entry_sizes: &[usize],
) -> BootstrapBuild {
    let mut initial_prefixes = HashSet::new();
    for alias in aliases {
        if let Some(first) = alias.key.chars().next() {
            initial_prefixes.insert(to_hiragana(&first.to_string()));
        }
    }
    let mut queue: VecDeque<String> = initial_prefixes.into_iter().collect();
    let mut visited = HashSet::new();
    let mut candidates = Vec::new();

    while let Some(prefix) = queue.pop_front() {
        if !visited.insert(prefix.clone()) {
            continue;
        }
        let ranges = bootstrap_ranges(aliases, &prefix);
        let matching_aliases = ranges.iter().map(|(_, range)| range.len()).sum();
        if matching_aliases < BOOTSTRAP_MIN_DESCENT_ALIASES {
            continue;
        }
        let mut shard_indexes = HashSet::new();
        for (_, range) in &ranges {
            if !range.is_empty() {
                for index in
                    range.start / MAX_ALIASES_PER_SHARD..=((range.end - 1) / MAX_ALIASES_PER_SHARD)
                {
                    shard_indexes.insert(index);
                }
            }
        }
        let search_bytes = shard_indexes.iter().map(|index| search_sizes[*index]).sum();
        let katakana_prefix = to_katakana(&prefix);
        let mut entries = vec![BootstrapEntry {
            prefix: prefix.clone(),
            ids: rank_prefix(aliases, &ranges, &prefix),
        }];
        if katakana_prefix != prefix {
            entries.push(BootstrapEntry {
                prefix: katakana_prefix.clone(),
                ids: rank_prefix(aliases, &ranges, &katakana_prefix),
            });
        }
        let result_ids: HashSet<u32> = entries
            .iter()
            .flat_map(|entry| entry.ids.iter().copied())
            .collect();
        let record_shards: HashSet<u32> = result_ids.iter().map(|id| id / RECORD_SPAN).collect();
        let record_bytes = record_shards
            .iter()
            .map(|index| record_sizes[*index as usize])
            .sum();
        let broad_search = matching_aliases >= BOOTSTRAP_MIN_BROAD_ALIASES
            && search_bytes >= BOOTSTRAP_MIN_SEARCH_BYTES;
        let expensive_records = record_bytes >= BOOTSTRAP_MIN_RECORD_BYTES;
        if broad_search || expensive_records {
            candidates.push(BootstrapCandidate {
                canonical_prefix: prefix.clone(),
                entries,
                matching_aliases,
                search_bytes,
                search_shards: shard_indexes.len(),
                record_shards: record_shards.len(),
                record_bytes,
            });
        }

        let prefix_length = prefix.chars().count();
        let mut children = HashSet::new();
        for (_, range) in &ranges {
            for alias in &aliases[range.clone()] {
                let canonical = to_hiragana(&alias.key);
                if canonical.starts_with(&prefix) && canonical.chars().count() > prefix_length {
                    children.insert(
                        canonical
                            .chars()
                            .take(prefix_length + 1)
                            .collect::<String>(),
                    );
                }
            }
        }
        queue.extend(children);
    }

    let candidate_prefixes = candidates.len();
    candidates.sort_unstable_by(|left, right| {
        right
            .search_bytes
            .saturating_add(right.record_bytes)
            .cmp(&left.search_bytes.saturating_add(left.record_bytes))
            .then(right.matching_aliases.cmp(&left.matching_aliases))
            .then(right.search_shards.cmp(&left.search_shards))
            .then(right.record_shards.cmp(&left.record_shards))
            .then(left.canonical_prefix.cmp(&right.canonical_prefix))
    });
    let mut bytes = 14_usize;
    let mut selected = Vec::new();
    let mut selected_record_ids = HashSet::new();
    for candidate in candidates {
        let candidate_ids: HashSet<u32> = candidate
            .entries
            .iter()
            .flat_map(|entry| entry.ids.iter().copied())
            .collect();
        let candidate_bytes = candidate
            .entries
            .iter()
            .map(bootstrap_entry_bytes)
            .sum::<usize>()
            + candidate_ids
                .iter()
                .filter(|id| !selected_record_ids.contains(*id))
                .map(|id| record_entry_sizes[*id as usize])
                .sum::<usize>();
        if bytes + candidate_bytes <= BOOTSTRAP_BUDGET_BYTES {
            bytes += candidate_bytes;
            selected_record_ids.extend(candidate_ids);
            selected.extend(candidate.entries);
        }
    }
    selected.sort_unstable_by(|left, right| left.prefix.cmp(&right.prefix));
    let mut record_ids: Vec<u32> = selected_record_ids.into_iter().collect();
    record_ids.sort_unstable();
    BootstrapBuild {
        entries: selected,
        record_ids,
        candidate_prefixes,
        bytes: bytes as u64,
    }
}

fn stats(mut sizes: Vec<u64>) -> SizeStats {
    sizes.sort_unstable();
    let total = sizes.iter().sum();
    if sizes.is_empty() {
        return SizeStats {
            minimum: 0,
            median: 0,
            p95: 0,
            maximum: 0,
            total,
        };
    }
    let percentile = |numerator: usize| sizes[(sizes.len() - 1) * numerator / 100];
    SizeStats {
        minimum: sizes[0],
        median: percentile(50),
        p95: percentile(95),
        maximum: *sizes.last().unwrap(),
        total,
    }
}

fn sha256_file(path: &Path) -> Result<String, Box<dyn Error>> {
    let mut input = BufReader::new(File::open(path)?);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = std::io::Read::read(&mut input, &mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn source_reader(path: &Path) -> Result<BufReader<GzDecoder<File>>, Box<dyn Error>> {
    Ok(BufReader::new(GzDecoder::new(File::open(path)?)))
}

fn load_source_index(input: &Path) -> Result<SourceIndex, Box<dyn Error>> {
    let mut surfaces = Vec::new();
    let mut dictionary_form_word_ids = Vec::new();
    let mut dictionary_forms = Vec::new();
    let mut pos_by_id = HashMap::new();
    let mut costs = Vec::new();
    let mut surface_lengths = Vec::new();
    for line in source_reader(input)?.lines() {
        let entry: SurfaceEntry = serde_json::from_str(&line?)?;
        if entry.word_id as usize != surfaces.len() {
            return Err(format!(
                "non-contiguous word ID {} while loading surface {}",
                entry.word_id,
                surfaces.len(),
            )
            .into());
        }
        surface_lengths.push(entry.surface.chars().count().min(u16::MAX as usize) as u16);
        costs.push(entry.cost);
        surfaces.push(entry.surface);
        dictionary_forms.push(entry.dictionary_form);
        dictionary_form_word_ids.push(entry.dictionary_form_word_id);
        let pos = entry.pos.join(" · ");
        match pos_by_id.entry(entry.pos_id) {
            HashEntry::Occupied(existing) if existing.get() != &pos => {
                return Err(format!("POS ID {} has inconsistent components", entry.pos_id).into());
            }
            HashEntry::Occupied(_) => {}
            HashEntry::Vacant(entry) => {
                entry.insert(pos);
            }
        }
    }

    let mut searchable_entries = 0_u64;
    for (word_id, dictionary_form_word_id) in dictionary_form_word_ids.iter().copied().enumerate() {
        if dictionary_form_word_id == -1 || dictionary_form_word_id == word_id as i32 {
            searchable_entries += 1;
            continue;
        }
        if dictionary_form_word_id < -1 {
            return Err(format!(
                "word {word_id} has invalid dictionary-form word ID {dictionary_form_word_id}",
            )
            .into());
        }
        let canonical_id = dictionary_form_word_id as usize;
        let canonical_surface = surfaces.get(canonical_id).ok_or_else(|| {
            format!("word {word_id} references missing dictionary-form word {canonical_id}")
        })?;
        let canonical_target = dictionary_form_word_ids[canonical_id];
        if canonical_target != -1 && canonical_target != canonical_id as i32 {
            return Err(format!(
                "word {word_id} dictionary-form target {canonical_id} is not canonical",
            )
            .into());
        }
        if canonical_surface != &dictionary_forms[word_id] {
            return Err(format!(
                "word {word_id} dictionary form {:?} does not match target {canonical_id} surface {:?}",
                dictionary_forms[word_id], canonical_surface,
            )
            .into());
        }
    }
    let mut pos_entries: Vec<(u16, String)> = pos_by_id.into_iter().collect();
    pos_entries.sort_unstable_by_key(|(id, _)| *id);
    Ok(SourceIndex {
        surfaces,
        dictionary_form_word_ids,
        searchable_entries,
        pos_entries,
        costs,
        surface_lengths,
    })
}

fn run(input: &Path, output: &Path, dataset: String) -> Result<(), Box<dyn Error>> {
    let started = Instant::now();
    fs::create_dir_all(output)?;
    let source = load_source_index(input)?;
    let mut aliases = Vec::new();
    let mut entries = 0_u64;
    let mut record_files = Vec::new();
    let mut record_sizes = Vec::new();
    let mut record_entry_sizes = Vec::new();
    let mut record_entries = Vec::with_capacity(RECORD_SPAN as usize);
    let mut structure_postings: HashMap<u32, StructurePostings> = HashMap::new();

    for line in source_reader(input)?.lines() {
        let entry: SourceEntry = serde_json::from_str(&line?)?;
        if entry.word_id as u64 != entries {
            return Err(format!(
                "non-contiguous word ID {} at entry {entries}",
                entry.word_id
            )
            .into());
        }
        let expected_dictionary_form_word_id =
            source.dictionary_form_word_ids[entry.word_id as usize];
        if entry.dictionary_form_word_id != expected_dictionary_form_word_id {
            return Err(format!(
                "dictionary-form identity changed while reading word {}",
                entry.word_id
            )
            .into());
        }
        if entry.dictionary_form_word_id == -1
            || entry.dictionary_form_word_id == entry.word_id as i32
        {
            add_aliases(&mut aliases, &entry);
            if let (Some(first), Some(last)) = (entry.word_structure.first(), entry.word_structure.last()) {
                let canonicalize = |id: u32| {
                    let target = source.dictionary_form_word_ids[id as usize];
                    if target == -1 || target == id as i32 { id } else { target as u32 }
                };
                structure_postings.entry(canonicalize(*first)).or_default().first.push(entry.word_id);
                structure_postings.entry(canonicalize(*last)).or_default().last.push(entry.word_id);
            }
        }
        record_entries.push(entry);
        entries += 1;

        if record_entries.len() == RECORD_SPAN as usize {
            flush_records(
                output,
                &mut record_files,
                &mut record_sizes,
                &mut record_entry_sizes,
                &mut record_entries,
                &source.surfaces,
            )?;
        }
    }
    if !record_entries.is_empty() {
        flush_records(
            output,
            &mut record_files,
            &mut record_sizes,
            &mut record_entry_sizes,
            &mut record_entries,
            &source.surfaces,
        )?;
    }

    aliases.sort_unstable_by(alias_order);
    aliases.dedup_by(|left, right| {
        left.key == right.key && left.id == right.id && left.kind == right.kind
    });

    let pos_table_file = "pos.bin.gz".to_owned();
    let (pos_table_bytes, pos_table_decoded_bytes) =
        write_pos_table(&output.join(&pos_table_file), &source.pos_entries)?;

    let mut search_shards = Vec::with_capacity(aliases.len().div_ceil(MAX_ALIASES_PER_SHARD));
    let mut search_sizes = Vec::with_capacity(search_shards.capacity());
    for (index, values) in aliases.chunks(MAX_ALIASES_PER_SHARD).enumerate() {
        let file = format!("search/{index:05}.bin");
        fs::create_dir_all(output.join("search"))?;
        let bytes = write_alias_file(&output.join(&file), values)?;
        search_sizes.push(bytes);
        search_shards.push(SearchShard {
            lower: values.first().unwrap().key.clone(),
            upper: values.last().unwrap().key.clone(),
            file,
            aliases: values.len(),
            bytes,
        });
    }

    let bootstrap = build_bootstrap(&aliases, &search_sizes, &record_sizes, &record_entry_sizes);
    let bootstrap_file = "bootstrap.bin.gz".to_owned();
    let bootstrap_decoded_bytes = write_bootstrap_file(
        &output.join(&bootstrap_file),
        &bootstrap,
        input,
        &source.surfaces,
    )?;
    if bootstrap_decoded_bytes != bootstrap.bytes {
        return Err("bootstrap size calculation does not match encoded file".into());
    }
    let bootstrap_bytes = fs::metadata(output.join(&bootstrap_file))?.len();
    let structure_matches = build_structure_shards(output, structure_postings, &source)?;

    let manifest = Manifest {
        format_version: FORMAT_VERSION,
        dataset,
        entries,
        searchable_entries: source.searchable_entries,
        filtered_inflection_entries: entries - source.searchable_entries,
        aliases: aliases.len(),
        pos_table_file,
        pos_count: source.pos_entries.len(),
        pos_table_bytes,
        pos_table_decoded_bytes,
        pos_compression: "gzip",
        pos_encoding: "sudachi-u16",
        bootstrap_file,
        bootstrap_prefixes: bootstrap.entries.len(),
        bootstrap_records: bootstrap.record_ids.len(),
        bootstrap_candidate_prefixes: bootstrap.candidate_prefixes,
        bootstrap_bytes,
        bootstrap_decoded_bytes,
        bootstrap_budget_bytes: BOOTSTRAP_BUDGET_BYTES,
        bootstrap_compression: "gzip",
        bootstrap_min_search_bytes: BOOTSTRAP_MIN_SEARCH_BYTES,
        bootstrap_min_broad_aliases: BOOTSTRAP_MIN_BROAD_ALIASES,
        bootstrap_min_descent_aliases: BOOTSTRAP_MIN_DESCENT_ALIASES,
        bootstrap_min_record_bytes: BOOTSTRAP_MIN_RECORD_BYTES,
        search_shards,
        records: RecordManifest {
            span: RECORD_SPAN,
            files: record_files,
        },
        structure_matches,
        search_size: stats(search_sizes),
        record_size: stats(record_sizes),
        split_encoding: "u8-code-point-boundaries",
        headword_filter: "dictionary-form-word-id",
        kana_ranking: "literal-script-tiebreak",
        source_sha256: sha256_file(input)?,
        elapsed_seconds: started.elapsed().as_secs_f64(),
    };
    let manifest_path = output.join("manifest.json");
    let mut manifest_output = BufWriter::new(File::create(&manifest_path)?);
    serde_json::to_writer_pretty(&mut manifest_output, &manifest)?;
    manifest_output.write_all(b"\n")?;
    manifest_output.flush()?;

    eprintln!(
        "built {} searchable entries from {} records, {} aliases, {} search shards, {} record shards, and {} of {} expensive bootstrap prefixes ({} bytes) in {:.1}s",
        manifest.searchable_entries,
        manifest.entries,
        manifest.aliases,
        manifest.search_shards.len(),
        manifest.records.files.len(),
        manifest.bootstrap_prefixes,
        manifest.bootstrap_candidate_prefixes,
        manifest.bootstrap_bytes,
        manifest.elapsed_seconds
    );
    Ok(())
}

fn flush_records(
    output: &Path,
    files: &mut Vec<String>,
    sizes: &mut Vec<u64>,
    entry_sizes: &mut Vec<usize>,
    entries: &mut Vec<SourceEntry>,
    surfaces: &[String],
) -> Result<(), Box<dyn Error>> {
    let index = files.len();
    let file = format!("records/{index:04}.bin");
    fs::create_dir_all(output.join("records"))?;
    let mut writer = BinaryWriter::new(b"SDRE", entries.len() as u32);
    for entry in entries.iter() {
        let start = writer.bytes.len();
        write_record(&mut writer, entry, surfaces)?;
        entry_sizes.push(writer.bytes.len() - start);
    }
    sizes.push(write_file(&output.join(&file), &writer.bytes)?);
    files.push(file);
    entries.clear();
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args();
    let program = args.next().unwrap_or_else(|| "build_web".into());
    let input = PathBuf::from(args.next().ok_or_else(|| {
        format!("usage: {program} <entries.jsonl.gz> <output-directory> <dataset>")
    })?);
    let output = PathBuf::from(args.next().ok_or_else(|| {
        format!("usage: {program} <entries.jsonl.gz> <output-directory> <dataset>")
    })?);
    let dataset = args.next().ok_or_else(|| {
        format!("usage: {program} <entries.jsonl.gz> <output-directory> <dataset>")
    })?;
    if args.next().is_some() {
        return Err(
            format!("usage: {program} <entries.jsonl.gz> <output-directory> <dataset>").into(),
        );
    }
    run(&input, &output, dataset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_matches_browser_rules_for_common_lookup_text() {
        assert_eq!(normalize(" ＡＢＣ "), "abc");
        assert_eq!(normalize("今日"), "今日");
    }

    #[test]
    fn reading_aliases_include_hiragana() {
        assert_eq!(to_hiragana("センキョ"), "せんきょ");
        assert_eq!(to_katakana("せんきょ"), "センキョ");
    }

    fn entry(surface: &str, split: Vec<u32>) -> SourceEntry {
        SourceEntry {
            word_id: 2,
            surface: surface.into(),
            reading_form: String::new(),
            normalized_form: String::new(),
            dictionary_form: String::new(),
            dictionary_form_word_id: -1,
            pos_id: 0,
            cost: 0,
            a_split: split,
            b_split: Vec::new(),
            word_structure: Vec::new(),
        }
    }

    #[test]
    fn split_ids_become_code_point_boundaries() {
        let surfaces = vec!["選挙".into(), "管理".into(), "委員会".into()];
        let entry = entry("選挙管理委員会", vec![0, 1, 2]);
        assert_eq!(
            split_boundaries(&entry, &entry.a_split, &surfaces, "A").unwrap(),
            vec![2, 4],
        );
    }

    #[test]
    fn capitalization_differences_preserve_parent_boundaries() {
        let surfaces = vec!["AI".into(), "ロボティクス".into(), "Aiロボティクス".into()];
        let entry = entry("Aiロボティクス", vec![0, 1]);
        assert_eq!(
            split_boundaries(&entry, &entry.a_split, &surfaces, "Structure").unwrap(),
            vec![2],
        );
    }

    #[test]
    fn bootstrap_ranking_prefers_exact_matches_before_lower_cost_prefixes() {
        let exact = Alias {
            key: "い".into(),
            id: 1,
            kind: 0,
            cost: 10_000,
            surface_length: 1,
        };
        let prefix = Alias {
            key: "インボディ・ジャパン".into(),
            id: 2,
            kind: 0,
            cost: -924,
            surface_length: 10,
        };
        let aliases = vec![exact, prefix];
        let ranges = bootstrap_ranges(&aliases, "い");
        assert_eq!(rank_prefix(&aliases, &ranges, "い"), vec![1, 2]);
    }

    #[test]
    fn bootstrap_ranking_prefers_the_literal_kana_script() {
        let hiragana = Alias {
            key: "あま".into(),
            id: 1,
            kind: 0,
            cost: 0,
            surface_length: 2,
        };
        let katakana = Alias {
            key: "アマ".into(),
            id: 2,
            kind: 0,
            cost: 0,
            surface_length: 2,
        };
        let aliases = vec![hiragana, katakana];
        let ranges = bootstrap_ranges(&aliases, "あま");
        assert_eq!(rank_prefix(&aliases, &ranges, "あま"), vec![1, 2]);
        assert_eq!(rank_prefix(&aliases, &ranges, "アマ"), vec![2, 1]);
    }
}
