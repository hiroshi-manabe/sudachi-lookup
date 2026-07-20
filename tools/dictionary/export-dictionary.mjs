import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { releaseName, root, selectedEdition, verifyDictionary } from "./release-config.mjs";

const localCargoHome = resolve(root, ".tooling/cargo");
const cargoHome = process.env.CARGO_HOME ?? localCargoHome;
const rustupHome = process.env.RUSTUP_HOME ?? resolve(root, ".tooling/rustup");
const localCargo = resolve(localCargoHome, "bin/cargo");
const cargo = process.env.CARGO ?? (existsSync(localCargo) ? localCargo : "cargo");
const edition = selectedEdition();
const dictionary = (await verifyDictionary(edition)).path;
const release = releaseName(edition);
const reportDirectory = resolve(root, "reports", release);
const entries = resolve(reportDirectory, "entries.jsonl.gz");
const report = resolve(reportDirectory, "export-report.json");

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
