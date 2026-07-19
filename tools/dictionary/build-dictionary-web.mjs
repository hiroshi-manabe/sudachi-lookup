import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "../..");
const cargoHome = resolve(root, ".tooling/cargo");
const rustupHome = resolve(root, ".tooling/rustup");
const cargo = resolve(cargoHome, "bin/cargo");
const edition = process.env.SUDACHI_EDITION ?? "core";
const version = process.env.SUDACHI_VERSION ?? "20260428";
const release = process.env.SUDACHI_RELEASE ?? `${edition}-${version}`;
const input = resolve(root, "reports", release, "entries.jsonl.gz");
const dataset = `${release}-v3`;
const output = resolve(root, "public/data/releases", dataset);

if (!existsSync(cargo)) {
  throw new Error("Local Rust toolchain is missing at .tooling/cargo/bin/cargo");
}
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
  ],
  {
    cwd: root,
    env: { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
