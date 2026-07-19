import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const branch = readBranch(process.argv.slice(2));
const wrangler = resolve(root, "node_modules/.bin/wrangler");
const outputDirectory = resolve(root, "dist/pages");
const gitStatus = git(["status", "--porcelain"]);
if (gitStatus) throw new Error("Refusing to deploy from a dirty working tree");
const commitHash = git(["rev-parse", "HEAD"]);
const commitMessage = git(["log", "-1", "--pretty=%s"]);
const result = spawnSync(
  wrangler,
  [
    "pages",
    "deploy",
    outputDirectory,
    "--project-name=sudachi-lookup",
    `--branch=${branch}`,
    `--commit-hash=${commitHash}`,
    `--commit-message=${commitMessage}`,
    "--commit-dirty=false",
  ],
  {
    cwd: tmpdir(),
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Pages deployment failed with status ${result.status}`);

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function readBranch(args) {
  const equalsArgument = args.find((argument) => argument.startsWith("--branch="));
  const flagIndex = args.indexOf("--branch");
  const value = equalsArgument?.slice("--branch=".length)
    ?? (flagIndex >= 0 ? args[flagIndex + 1] : undefined);
  if (!value || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(`Invalid or missing Pages branch: ${value ?? ""}`);
  }
  return value;
}
