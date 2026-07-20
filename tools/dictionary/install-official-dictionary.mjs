import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pythonExecutable, releaseConfig, root, selectedEdition, verifyDictionary } from "./release-config.mjs";

const edition = selectedEdition();
const metadata = releaseConfig.editions[edition];
const localPython = resolve(root, ".venv/bin/python");
if (!process.env.SUDACHI_PYTHON && !existsSync(localPython)) {
  const environment = spawnSync("python3", ["-m", "venv", resolve(root, ".venv")], { stdio: "inherit" });
  if (environment.error) throw environment.error;
  if (environment.status !== 0) throw new Error("Could not create the project Python environment");
}
const packages = [
  `SudachiPy==${releaseConfig.sudachiPyVersion}`,
  `${metadata.pythonPackage}==${releaseConfig.dictionaryVersion}`,
];
const result = spawnSync(
  pythonExecutable(),
  ["-m", "pip", "install", "--disable-pip-version-check", ...packages],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Official Sudachi ${edition} package installation failed`);

const verified = await verifyDictionary(edition);
console.log(`Verified official SudachiDict ${edition} ${releaseConfig.dictionaryVersion}: ${verified.sha256}`);
