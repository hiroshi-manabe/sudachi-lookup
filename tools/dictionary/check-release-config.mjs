import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { releaseConfig, root } from "./release-config.mjs";

const [cargoManifest, exporter, builder] = await Promise.all([
  readFile(resolve(root, "tools/dictionary/exporter/Cargo.toml"), "utf8"),
  readFile(resolve(root, "tools/dictionary/exporter/src/main.rs"), "utf8"),
  readFile(resolve(root, "tools/dictionary/exporter/src/bin/build_web.rs"), "utf8"),
]);
if (!cargoManifest.includes(`rev = "${releaseConfig.sudachiRustRevision}"`)) {
  throw new Error("Cargo Sudachi revision differs from dictionary-release.json");
}
if (!exporter.includes(`const SUDACHI_REVISION: &str = "${releaseConfig.sudachiRustRevision}";`)) {
  throw new Error("Rust export report revision differs from dictionary-release.json");
}
if (!builder.includes(`const FORMAT_VERSION: u16 = ${releaseConfig.browserFormatVersion};`)) {
  throw new Error("Rust browser format differs from dictionary-release.json");
}
console.log(
  `Release configuration is consistent: SudachiDict ${releaseConfig.dictionaryVersion}, ` +
  `browser format v${releaseConfig.browserFormatVersion}.`,
);
