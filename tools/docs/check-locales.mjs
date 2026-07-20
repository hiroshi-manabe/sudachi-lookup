import { access, readdir, readFile } from "node:fs/promises";

const docsDirectory = new URL("../../docs/", import.meta.url);
const japaneseDirectory = new URL("../../docs/ja/", import.meta.url);
const files = (await readdir(docsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => entry.name)
  .sort();

const errors = [];

for (const file of files) {
  const englishPath = new URL(file, docsDirectory);
  const japanesePath = new URL(file, japaneseDirectory);

  try {
    await access(japanesePath);
  } catch {
    errors.push(`${file}: missing docs/ja/${file}`);
    continue;
  }

  const [english, japanese] = await Promise.all([
    readFile(englishPath, "utf8"),
    readFile(japanesePath, "utf8"),
  ]);

  if (!english.includes(`](ja/${file})`)) {
    errors.push(`${file}: missing link to Japanese counterpart`);
  }
  if (!japanese.includes(`](../${file})`)) {
    errors.push(`docs/ja/${file}: missing link to English counterpart`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${files.length} bilingual documentation pairs.`);
}
