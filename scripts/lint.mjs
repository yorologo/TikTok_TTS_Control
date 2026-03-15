import fs from "fs/promises";
import path from "path";
import { execFileSync } from "child_process";

const root = process.cwd();
const explicitFiles = [
  "server.mjs",
  "public/app.js",
  "routes/api.js"
];
const scanDirs = ["modules", "tests", "scripts"];
const allowedExt = new Set([".js", ".mjs"]);
const files = new Set();

async function collectFiles(dir) {
  const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const relPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(relPath);
      continue;
    }
    if (allowedExt.has(path.extname(entry.name))) {
      files.add(relPath);
    }
  }
}

for (const file of explicitFiles) {
  files.add(file);
}

for (const dir of scanDirs) {
  await collectFiles(dir);
}

const ordered = Array.from(files).sort();
for (const file of ordered) {
  execFileSync(process.execPath, ["--check", file], {
    cwd: root,
    stdio: "inherit"
  });
}

console.log(`Syntax OK: ${ordered.length} files`);
