import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const outputDirectory = resolve(root, "dist/pages");
const edition = readEdition(process.argv.slice(2));
const dataset = datasetForEdition(edition);

runViteBuild();
await copyDeploymentFiles(dataset);
const report = await validateDeployment(dataset);

console.log(
  `Built Pages ${edition} artifact: ${report.files.toLocaleString()} files, ` +
  `${formatBytes(report.bytes)} total, largest ${formatBytes(report.largest)}.`,
);

function readEdition(args) {
  const equalsArgument = args.find((argument) => argument.startsWith("--edition="));
  const flagIndex = args.indexOf("--edition");
  const value = equalsArgument?.slice("--edition=".length)
    ?? (flagIndex >= 0 ? args[flagIndex + 1] : undefined)
    ?? "sample";
  if (!["sample", "core", "full"].includes(value)) {
    throw new Error(`Unsupported Pages edition: ${value}`);
  }
  return value;
}

function datasetForEdition(value) {
  if (value === "sample") {
    return {
      source: resolve(root, "public/data/sample"),
      destination: resolve(outputDirectory, "data/sample"),
      manifest: "data/sample/manifest.json",
      version: 1,
    };
  }
  const name = `${value}-20260428-v3`;
  return {
    source: resolve(root, "public/data/releases", name),
    destination: resolve(outputDirectory, "data/releases", name),
    manifest: `data/releases/${name}/manifest.json`,
    version: 3,
  };
}

function runViteBuild() {
  const vite = resolve(root, "node_modules/.bin/vite");
  const result = spawnSync(vite, ["build", "--config", "vite.pages.config.ts"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Pages frontend build failed with status ${result.status}`);
}

async function copyDeploymentFiles(selectedDataset) {
  await stat(selectedDataset.source).catch(() => {
    throw new Error(`Selected dictionary artifact is missing: ${selectedDataset.source}`);
  });
  await Promise.all([
    mkdir(resolve(outputDirectory, "data"), { recursive: true }),
    mkdir(resolve(outputDirectory, "notices"), { recursive: true }),
  ]);
  await Promise.all([
    cp(selectedDataset.source, selectedDataset.destination, { recursive: true }),
    cp(resolve(root, "public/_headers"), resolve(outputDirectory, "_headers")),
    cp(resolve(root, "pages/404.html"), resolve(outputDirectory, "404.html")),
    cp(resolve(root, "pages/notices.html"), resolve(outputDirectory, "notices/index.html")),
    cp(resolve(root, "legal/sudachidict"), resolve(outputDirectory, "notices/sudachidict"), {
      recursive: true,
    }),
  ]);
}

async function validateDeployment(selectedDataset) {
  const manifestPath = resolve(outputDirectory, selectedDataset.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.formatVersion !== selectedDataset.version) {
    throw new Error(`Unexpected dictionary format ${manifest.formatVersion}`);
  }

  const manifestDirectory = resolve(manifestPath, "..");
  const references = selectedDataset.version === 1
    ? [manifest.entriesFile, manifest.indexFile]
    : [
        manifest.bootstrapFile,
        ...manifest.searchShards.map((shard) => shard.file),
        ...manifest.records.files,
      ];
  await Promise.all(references.map(async (file) => {
    const filePath = resolve(manifestDirectory, file);
    const metadata = await stat(filePath).catch(() => null);
    if (!metadata?.isFile()) throw new Error(`Manifest references missing file: ${file}`);
  }));

  const files = await listFiles(outputDirectory);
  if (files.length > 20_000) throw new Error(`Pages file budget exceeded: ${files.length}`);
  let bytes = 0;
  let largest = 0;
  for (const file of files) {
    const metadata = await stat(file);
    bytes += metadata.size;
    largest = Math.max(largest, metadata.size);
  }
  if (largest > 25 * 1024 * 1024) {
    throw new Error(`Pages per-file budget exceeded: ${formatBytes(largest)}`);
  }
  return { files: files.length, bytes, largest };
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat();
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
