import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const root = resolve(import.meta.dirname, "../..");
export const releaseConfig = JSON.parse(
  readFileSync(resolve(root, "config/dictionary-release.json"), "utf8"),
);

export function selectedEdition() {
  const edition = process.env.SUDACHI_EDITION ?? "core";
  if (!(edition in releaseConfig.editions)) throw new Error(`Unsupported Sudachi edition: ${edition}`);
  return edition;
}

export function releaseName(edition = selectedEdition()) {
  return process.env.SUDACHI_RELEASE ?? `${edition}-${releaseConfig.dictionaryVersion}`;
}

export function datasetName(edition = selectedEdition()) {
  return `${releaseName(edition)}-v${releaseConfig.browserFormatVersion}`;
}

export function pythonExecutable() {
  if (process.env.SUDACHI_PYTHON) return process.env.SUDACHI_PYTHON;
  const local = resolve(root, ".venv/bin/python");
  return existsSync(local) ? local : "python3";
}

export function dictionaryPath(edition = selectedEdition()) {
  if (process.env.SUDACHI_SYSTEM_DIC) return resolve(process.env.SUDACHI_SYSTEM_DIC);
  const module = releaseConfig.editions[edition].pythonModule;
  const result = spawnSync(
    pythonExecutable(),
    ["-c", `import ${module}; from pathlib import Path; print(Path(${module}.__file__).parent / "resources" / "system.dic")`],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Official Sudachi ${edition} package is not installed:\n${result.stderr.trim()}`);
  }
  return resolve(result.stdout.trim());
}

export async function verifyDictionary(edition = selectedEdition()) {
  const path = dictionaryPath(edition);
  if (!existsSync(path)) throw new Error(`Sudachi ${edition} system dictionary is missing: ${path}`);
  const actual = await sha256(path);
  const expected = releaseConfig.editions[edition].systemDictionarySha256;
  if (actual !== expected) {
    throw new Error(`Sudachi ${edition} system dictionary checksum differs: expected ${expected}, got ${actual}`);
  }
  return { path, sha256: actual };
}

function sha256(path) {
  return new Promise((accept, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => accept(hash.digest("hex")));
  });
}
