import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createIdentityPool } from "../infrastructure/postgres.js";

async function main(): Promise<void> {
  const currentFilePath = fileURLToPath(import.meta.url);
  const schemaDir = path.resolve(path.dirname(currentFilePath), "../../sql");
  const files = (await readdir(schemaDir))
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const pool = createIdentityPool();

  try {
    for (const file of files) {
      const sql = await readFile(path.join(schemaDir, file), "utf8");
      process.stdout.write(`Applying schema file ${file}\n`);
      await pool.query(sql);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
