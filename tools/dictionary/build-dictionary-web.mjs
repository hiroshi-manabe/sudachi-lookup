import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { datasetName, releaseConfig, releaseName, root, selectedEdition } from "./release-config.mjs";

const localCargoHome = resolve(root, ".tooling/cargo");
const cargoHome = process.env.CARGO_HOME ?? localCargoHome;
const rustupHome = process.env.RUSTUP_HOME ?? resolve(root, ".tooling/rustup");
const localCargo = resolve(localCargoHome, "bin/cargo");
const cargo = process.env.CARGO ?? (existsSync(localCargo) ? localCargo : "cargo");
const edition = selectedEdition();
const smallUpperExclusive = releaseConfig.editions.small.sourceEntries;
const coreUpperExclusive = releaseConfig.editions.core.sourceEntries;
const release = releaseName(edition);
const input = resolve(root, "reports", release, "entries.jsonl.gz");
const dataset = datasetName(edition);
const output = resolve(root, "public/data/releases", dataset);

if (!existsSync(input)) {
  throw new Error(`Neutral export is missing: ${input}. Export ${edition} first.`);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const result = spawnSync(
  cargo,
  [
    "run",
    "--release",
    "--locked",
    "--manifest-path",
    resolve(root, "tools/dictionary/exporter/Cargo.toml"),
    "--bin",
    "build_web",
    "--",
    input,
    output,
    dataset,
    String(smallUpperExclusive),
    String(coreUpperExclusive),
  ],
  {
    cwd: root,
    env: { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
