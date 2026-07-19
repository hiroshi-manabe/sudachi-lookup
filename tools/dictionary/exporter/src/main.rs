use flate2::{write::GzEncoder, Compression};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    env,
    error::Error,
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};
use sudachi::dic::{subset::InfoSubset, DictionaryLoader};

const EXPORT_FORMAT_VERSION: u32 = 2;
const SUDACHI_REVISION: &str = "90fd6068c80c2fc3b63e0dbab0e341475bad4d8f";

#[derive(Serialize)]
struct ExportEntry<'a> {
    word_id: u32,
    surface: &'a str,
    reading_form: &'a str,
    normalized_form: &'a str,
    dictionary_form: &'a str,
    dictionary_form_word_id: i32,
    pos_id: u16,
    pos: &'a [String],
    cost: i16,
    a_split: Vec<u32>,
    b_split: Vec<u32>,
    word_structure: Vec<u32>,
    synonym_group_ids: &'a [u32],
}

#[derive(Default, Serialize)]
struct SplitMetrics {
    entries: u64,
    references: u64,
    non_system_references: u64,
    out_of_range_references: u64,
    maximum_components: u64,
    component_count_distribution: BTreeMap<usize, u64>,
}

#[derive(Serialize)]
struct AliasMetrics {
    surface: u64,
    reading_form_different: u64,
    normalized_form_different: u64,
    dictionary_form_different: u64,
}

#[derive(Serialize)]
struct ExportReport {
    export_format_version: u32,
    sudachi_revision: &'static str,
    input_path: String,
    input_bytes: u64,
    input_sha256: String,
    output_path: String,
    output_bytes: u64,
    output_sha256: String,
    elapsed_seconds: f64,
    entries: u64,
    distinct_surfaces: u64,
    homograph_surfaces: u64,
    homograph_entries: u64,
    maximum_homographs_for_one_surface: u64,
    a_split: SplitMetrics,
    b_split: SplitMetrics,
    word_structure: SplitMetrics,
    aliases: AliasMetrics,
}

fn usage(program: &str) -> String {
    format!("usage: {program} <system.dic> <entries.jsonl.gz> <report.json>")
}

fn split_ids(
    split: &[sudachi::dic::word_id::WordId],
    lexicon_size: u32,
    metrics: &mut SplitMetrics,
) -> Vec<u32> {
    if !split.is_empty() {
        metrics.entries += 1;
        metrics.maximum_components = metrics.maximum_components.max(split.len() as u64);
        *metrics
            .component_count_distribution
            .entry(split.len())
            .or_insert(0) += 1;
    }
    metrics.references += split.len() as u64;

    split
        .iter()
        .map(|id| {
            if !id.is_system() {
                metrics.non_system_references += 1;
            } else if id.word() >= lexicon_size {
                metrics.out_of_range_references += 1;
            }
            id.as_raw()
        })
        .collect()
}

fn ensure_parent(path: &Path) -> Result<(), Box<dyn Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, Box<dyn Error>> {
    let mut input = BufReader::new(File::open(path)?);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn run(input: &Path, output: &Path, report_path: &Path) -> Result<(), Box<dyn Error>> {
    let started = Instant::now();
    let dictionary_bytes = fs::read(input)?;
    let dictionary = DictionaryLoader::read_system_dictionary(&dictionary_bytes)?;
    let grammar = dictionary
        .grammar
        .as_ref()
        .ok_or("system dictionary has no grammar")?;
    let lexicon_size = dictionary.lexicon.size();

    ensure_parent(output)?;
    ensure_parent(report_path)?;
    let output_file = File::create(output)?;
    let buffered = BufWriter::new(output_file);
    let mut compressed = GzEncoder::new(buffered, Compression::default());
    let mut surface_counts: HashMap<String, u32> = HashMap::new();
    let mut a_split = SplitMetrics::default();
    let mut b_split = SplitMetrics::default();
    let mut word_structure = SplitMetrics::default();
    let mut reading_form_different = 0_u64;
    let mut normalized_form_different = 0_u64;
    let mut dictionary_form_different = 0_u64;

    for word_id in 0..lexicon_size {
        let info = dictionary
            .lexicon
            .get_word_info(word_id, InfoSubset::all())?;
        let (_, _, cost) = dictionary.lexicon.get_word_param(word_id);

        *surface_counts.entry(info.surface().to_owned()).or_insert(0) += 1;
        reading_form_different += u64::from(info.reading_form() != info.surface());
        normalized_form_different += u64::from(info.normalized_form() != info.surface());
        dictionary_form_different += u64::from(info.dictionary_form() != info.surface());

        let entry = ExportEntry {
            word_id,
            surface: info.surface(),
            reading_form: info.reading_form(),
            normalized_form: info.normalized_form(),
            dictionary_form: info.dictionary_form(),
            dictionary_form_word_id: info.dictionary_form_word_id(),
            pos_id: info.pos_id(),
            pos: grammar.pos_components(info.pos_id()),
            cost,
            a_split: split_ids(info.a_unit_split(), lexicon_size, &mut a_split),
            b_split: split_ids(info.b_unit_split(), lexicon_size, &mut b_split),
            word_structure: split_ids(info.word_structure(), lexicon_size, &mut word_structure),
            synonym_group_ids: info.synonym_group_ids(),
        };

        serde_json::to_writer(&mut compressed, &entry)?;
        compressed.write_all(b"\n")?;
    }

    compressed.finish()?.flush()?;

    let mut homograph_surfaces = 0_u64;
    let mut homograph_entries = 0_u64;
    let mut maximum_homographs_for_one_surface = 0_u64;
    for count in surface_counts.values().copied().map(u64::from) {
        if count > 1 {
            homograph_surfaces += 1;
            homograph_entries += count;
        }
        maximum_homographs_for_one_surface = maximum_homographs_for_one_surface.max(count);
    }

    let report = ExportReport {
        export_format_version: EXPORT_FORMAT_VERSION,
        sudachi_revision: SUDACHI_REVISION,
        input_path: input.display().to_string(),
        input_bytes: fs::metadata(input)?.len(),
        input_sha256: sha256_file(input)?,
        output_path: output.display().to_string(),
        output_bytes: fs::metadata(output)?.len(),
        output_sha256: sha256_file(output)?,
        elapsed_seconds: started.elapsed().as_secs_f64(),
        entries: u64::from(lexicon_size),
        distinct_surfaces: surface_counts.len() as u64,
        homograph_surfaces,
        homograph_entries,
        maximum_homographs_for_one_surface,
        a_split,
        b_split,
        word_structure,
        aliases: AliasMetrics {
            surface: u64::from(lexicon_size),
            reading_form_different,
            normalized_form_different,
            dictionary_form_different,
        },
    };

    let report_file = File::create(report_path)?;
    let mut report_writer = BufWriter::new(report_file);
    serde_json::to_writer_pretty(&mut report_writer, &report)?;
    report_writer.write_all(b"\n")?;
    report_writer.flush()?;

    eprintln!(
        "exported {} entries to {} ({:.1} MiB) in {:.1}s",
        lexicon_size,
        output.display(),
        report.output_bytes as f64 / 1_048_576.0,
        report.elapsed_seconds
    );
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args();
    let program = args
        .next()
        .unwrap_or_else(|| "sudachi-lexicon-exporter".into());
    let input = PathBuf::from(args.next().ok_or_else(|| usage(&program))?);
    let output = PathBuf::from(args.next().ok_or_else(|| usage(&program))?);
    let report = PathBuf::from(args.next().ok_or_else(|| usage(&program))?);
    if args.next().is_some() {
        return Err(usage(&program).into());
    }
    run(&input, &output, &report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sudachi::dic::word_id::WordId;

    #[test]
    fn split_ids_preserve_raw_ids_and_count_invalid_references() {
        let ids = [WordId::new(0, 2), WordId::new(0, 12), WordId::new(1, 3)];
        let mut metrics = SplitMetrics::default();

        let raw = split_ids(&ids, 10, &mut metrics);

        assert_eq!(raw, ids.map(|id| id.as_raw()));
        assert_eq!(metrics.entries, 1);
        assert_eq!(metrics.references, 3);
        assert_eq!(metrics.out_of_range_references, 1);
        assert_eq!(metrics.non_system_references, 1);
        assert_eq!(metrics.maximum_components, 3);
        assert_eq!(metrics.component_count_distribution.get(&3), Some(&1));
    }

    #[test]
    fn empty_split_is_not_counted_as_an_entry() {
        let mut metrics = SplitMetrics::default();

        assert!(split_ids(&[], 10, &mut metrics).is_empty());
        assert_eq!(metrics.entries, 0);
        assert_eq!(metrics.references, 0);
    }
}
