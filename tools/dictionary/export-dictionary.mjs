import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "../..");
const cargoHome = resolve(root, ".tooling/cargo");
const rustupHome = resolve(root, ".tooling/rustup");
const cargo = resolve(cargoHome, "bin/cargo");
const edition = process.env.SUDACHI_EDITION ?? "core";
const version = process.env.SUDACHI_VERSION ?? "20260428";
const packageName = `sudachidict_${edition}`;
const defaultDictionary = resolve(
  root,
  `.venv/lib/python3.12/site-packages/${packageName}/resources/system.dic`,
);
const dictionary = resolve(process.env.SUDACHI_SYSTEM_DIC ?? defaultDictionary);
const release = process.env.SUDACHI_RELEASE ?? `${edition}-${version}`;
const reportDirectory = resolve(root, "reports", release);
const entries = resolve(reportDirectory, "entries.jsonl.gz");
const report = resolve(reportDirectory, "export-report.json");

if (!existsSync(cargo)) {
  throw new Error("Local Rust toolchain is missing at .tooling/cargo/bin/cargo");
}
if (!existsSync(dictionary)) {
  throw new Error(`Sudachi ${edition} system dictionary is missing: ${dictionary}`);
}

mkdirSync(reportDirectory, { recursive: true });
const result = spawnSync(
  cargo,
  [
    "run",
    "--release",
    "--locked",
    "--manifest-path",
    resolve(root, "tools/dictionary/exporter/Cargo.toml"),
    "--bin",
    "sudachi-lexicon-exporter",
    "--",
    dictionary,
    entries,
    report,
  ],
  {
    cwd: root,
    env: { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
