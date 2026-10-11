import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createOpsConsolePool } from "../infrastructure/postgres.js";

async function main(): Promise<void> {
  const pool = createOpsConsolePool();

  try {
    const schemaDirectory = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../sql"
    );
    const files = (await readdir(schemaDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));

    for (const file of files) {
      const statement = await readFile(path.join(schemaDirectory, file), "utf8");
      process.stdout.write(`Applying schema file ${file}\n`);
      await pool.query(statement);
    }

    process.stdout.write("ops-console schema setup completed\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
