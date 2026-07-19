use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::HashMap,
    env,
    error::Error,
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    time::Instant,
};
use unicode_normalization::UnicodeNormalization;

const FORMAT_VERSION: u16 = 4;
const RECORD_SPAN: u32 = 2_048;
const MAX_ALIASES_PER_SHARD: usize = 5_000;
const BOOTSTRAP_PER_FIRST_CHARACTER: usize = 64;

#[derive(Deserialize)]
struct SourceEntry {
    word_id: u32,
    surface: String,
    reading_form: String,
    normalized_form: String,
    dictionary_form: String,
    pos: Vec<String>,
    cost: i16,
    a_split: Vec<u32>,
    b_split: Vec<u32>,
    word_structure: Vec<u32>,
}

#[derive(Deserialize)]
struct SurfaceEntry {
    word_id: u32,
    surface: String,
}

#[derive(Clone)]
struct Alias {
    key: String,
    id: u32,
    kind: u8,
    cost: i16,
    surface_length: u16,
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
    aliases: usize,
    min_full_query_length: usize,
    bootstrap_file: String,
    bootstrap_aliases: usize,
    search_shards: Vec<SearchShard>,
    records: RecordManifest,
    search_size: SizeStats,
    record_size: SizeStats,
    split_encoding: &'static str,
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
    writer.string(&entry.pos.join(" · "))?;
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

fn alias_order(left: &Alias, right: &Alias) -> Ordering {
    left.key
        .cmp(&right.key)
        .then(left.id.cmp(&right.id))
        .then(left.kind.cmp(&right.kind))
}

fn result_order(left: &Alias, right: &Alias) -> Ordering {
    left.kind
        .cmp(&right.kind)
        .then(left.cost.cmp(&right.cost))
        .then(left.surface_length.cmp(&right.surface_length))
        .then(left.id.cmp(&right.id))
}

fn build_bootstrap(aliases: &[Alias]) -> Vec<Alias> {
    let mut grouped: HashMap<char, Vec<&Alias>> = HashMap::new();
    for alias in aliases {
        if let Some(first) = alias.key.chars().next() {
            grouped.entry(first).or_default().push(alias);
        }
    }
    let mut bootstrap = Vec::new();
    for values in grouped.values_mut() {
        if values.len() <= MAX_ALIASES_PER_SHARD {
            continue;
        }
        values.sort_unstable_by(|left, right| result_order(left, right));
        bootstrap.extend(
            values
                .iter()
                .take(BOOTSTRAP_PER_FIRST_CHARACTER)
                .map(|alias| (*alias).clone()),
        );
    }
    bootstrap.sort_unstable_by(alias_order);
    bootstrap.dedup_by(|left, right| {
        left.key == right.key && left.id == right.id && left.kind == right.kind
    });
    bootstrap
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

fn load_surfaces(input: &Path) -> Result<Vec<String>, Box<dyn Error>> {
    let mut surfaces = Vec::new();
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
        surfaces.push(entry.surface);
    }
    Ok(surfaces)
}

fn run(input: &Path, output: &Path, dataset: String) -> Result<(), Box<dyn Error>> {
    let started = Instant::now();
    fs::create_dir_all(output)?;
    let surfaces = load_surfaces(input)?;
    let mut aliases = Vec::new();
    let mut entries = 0_u64;
    let mut record_files = Vec::new();
    let mut record_sizes = Vec::new();
    let mut record_entries = Vec::with_capacity(RECORD_SPAN as usize);

    for line in source_reader(input)?.lines() {
        let entry: SourceEntry = serde_json::from_str(&line?)?;
        if entry.word_id as u64 != entries {
            return Err(format!(
                "non-contiguous word ID {} at entry {entries}",
                entry.word_id
            )
            .into());
        }
        add_aliases(&mut aliases, &entry);
        record_entries.push(entry);
        entries += 1;

        if record_entries.len() == RECORD_SPAN as usize {
            flush_records(
                output,
                &mut record_files,
                &mut record_sizes,
                &mut record_entries,
                &surfaces,
            )?;
        }
    }
    if !record_entries.is_empty() {
        flush_records(
            output,
            &mut record_files,
            &mut record_sizes,
            &mut record_entries,
            &surfaces,
        )?;
    }

    aliases.sort_unstable_by(alias_order);
    aliases.dedup_by(|left, right| {
        left.key == right.key && left.id == right.id && left.kind == right.kind
    });

    let bootstrap = build_bootstrap(&aliases);
    let bootstrap_file = "bootstrap.bin".to_owned();
    write_alias_file(&output.join(&bootstrap_file), &bootstrap)?;

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

    let manifest = Manifest {
        format_version: FORMAT_VERSION,
        dataset,
        entries,
        aliases: aliases.len(),
        min_full_query_length: 2,
        bootstrap_file,
        bootstrap_aliases: bootstrap.len(),
        search_shards,
        records: RecordManifest {
            span: RECORD_SPAN,
            files: record_files,
        },
        search_size: stats(search_sizes),
        record_size: stats(record_sizes),
        split_encoding: "u8-code-point-boundaries",
        source_sha256: sha256_file(input)?,
        elapsed_seconds: started.elapsed().as_secs_f64(),
    };
    let manifest_path = output.join("manifest.json");
    let mut manifest_output = BufWriter::new(File::create(&manifest_path)?);
    serde_json::to_writer_pretty(&mut manifest_output, &manifest)?;
    manifest_output.write_all(b"\n")?;
    manifest_output.flush()?;

    eprintln!(
        "built {} entries, {} aliases, {} search shards, and {} record shards in {:.1}s",
        manifest.entries,
        manifest.aliases,
        manifest.search_shards.len(),
        manifest.records.files.len(),
        manifest.elapsed_seconds
    );
    Ok(())
}

fn flush_records(
    output: &Path,
    files: &mut Vec<String>,
    sizes: &mut Vec<u64>,
    entries: &mut Vec<SourceEntry>,
    surfaces: &[String],
) -> Result<(), Box<dyn Error>> {
    let index = files.len();
    let file = format!("records/{index:04}.bin");
    fs::create_dir_all(output.join("records"))?;
    let mut writer = BinaryWriter::new(b"SDRE", entries.len() as u32);
    for entry in entries.iter() {
        write_record(&mut writer, entry, surfaces)?;
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
    }

    fn entry(surface: &str, split: Vec<u32>) -> SourceEntry {
        SourceEntry {
            word_id: 2,
            surface: surface.into(),
            reading_form: String::new(),
            normalized_form: String::new(),
            dictionary_form: String::new(),
            pos: Vec::new(),
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
}
