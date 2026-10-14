// Forward-only schema migrations shared by every service's `db:prepare`.
//
// Each service keeps numbered SQL files in its own `sql/` directory
// (`001_schema.sql` is the baseline of the current structure). A file is applied
// once, inside a transaction, and recorded in `schema_migrations`; restarts only
// compare what is recorded with what is on disk. Node-only: import it from
// `@web3-cex/domain/schema-migrations`, not from the package root (which is also
// bundled into the browser apps).

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface SchemaQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface SchemaPoolClient extends SchemaQueryable {
  release(): void;
}

export interface SchemaPool {
  connect(): Promise<SchemaPoolClient>;
}

export interface SchemaMigrationFile {
  version: string;
  checksum: string;
  sql: string;
}

export interface SchemaMigrationResult {
  service: string;
  applied: string[];
  alreadyApplied: number;
}

export class SchemaMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaMigrationError";
  }
}

const RESET_HINT = "Run `pnpm db:reset` to drop the database and recreate it from the current schema.";

// Serialises concurrent db:prepare runs across services sharing one database.
const ADVISORY_LOCK_KEY = 7_304_211_025;

export async function readSchemaMigrations(sqlDir: string): Promise<SchemaMigrationFile[]> {
  const names = (await readdir(sqlDir)).filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
  const files: SchemaMigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(path.join(sqlDir, name), "utf8");
    files.push({ version: name, checksum: checksumOf(sql), sql });
  }
  return files;
}

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/** Tables created by a migration file (`create table [if not exists] [public.]<name>`). */
export function tablesCreatedBy(sql: string): string[] {
  const names = new Set<string>();
  for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    names.add(match[1]!.toLowerCase());
  }
  return [...names];
}

export interface PlannedMigrations {
  pending: SchemaMigrationFile[];
  alreadyApplied: number;
}

/** Pure decision step: which files still need to run, given what is recorded. */
export function planSchemaMigrations(
  service: string,
  files: SchemaMigrationFile[],
  recorded: Array<{ version: string; checksum: string }>
): PlannedMigrations {
  const byVersion = new Map(recorded.map((row) => [row.version, row.checksum]));
  for (const row of recorded) {
    const file = files.find((item) => item.version === row.version);
    if (!file) {
      throw new SchemaMigrationError(
        `${service}: migration ${row.version} is recorded in schema_migrations but no longer exists on disk. ${RESET_HINT}`
      );
    }
    if (file.checksum !== row.checksum) {
      throw new SchemaMigrationError(
        `${service}: migration ${row.version} changed after it was applied (checksum mismatch). Add a new numbered file instead of editing an applied one, or ${RESET_HINT.charAt(0).toLowerCase()}${RESET_HINT.slice(1)}`
      );
    }
  }
  return {
    pending: files.filter((file) => !byVersion.has(file.version)),
    alreadyApplied: recorded.length
  };
}

export async function runSchemaMigrations(
  pool: SchemaPool,
  options: { service: string; sqlDir: string; log?: (line: string) => void }
): Promise<SchemaMigrationResult> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const files = await readSchemaMigrations(options.sqlDir);
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`
        create table if not exists schema_migrations (
          service text not null,
          version text not null,
          checksum text not null,
          applied_at timestamptz not null default now(),
          primary key (service, version)
        )
      `);
      const recorded = (
        await client.query("select version, checksum from schema_migrations where service = $1 order by version", [options.service])
      ).rows.map((row) => ({ version: String(row.version), checksum: String(row.checksum) }));

      if (recorded.length === 0 && files.length > 0) {
        await assertNoLegacySchema(client, options.service, files[0]!);
      }

      const plan = planSchemaMigrations(options.service, files, recorded);
      for (const file of plan.pending) {
        await client.query("begin");
        try {
          await client.query(file.sql);
          await client.query("insert into schema_migrations (service, version, checksum) values ($1, $2, $3)", [
            options.service,
            file.version,
            file.checksum
          ]);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
        log(`${options.service}: applied ${file.version}`);
      }
      if (plan.pending.length === 0) {
        log(`${options.service}: schema up to date (${plan.alreadyApplied} migration${plan.alreadyApplied === 1 ? "" : "s"} recorded)`);
      }
      return { service: options.service, applied: plan.pending.map((file) => file.version), alreadyApplied: plan.alreadyApplied };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

// Tables from an older, untracked schema would make the baseline fail half way
// (or silently differ). Refuse and point at the reset instead.
async function assertNoLegacySchema(client: SchemaQueryable, service: string, baseline: SchemaMigrationFile): Promise<void> {
  const tables = tablesCreatedBy(baseline.sql);
  if (tables.length === 0) {
    return;
  }
  const existing = (
    await client.query("select tablename from pg_tables where schemaname = current_schema() and tablename = any($1::text[])", [tables])
  ).rows.map((row) => String(row.tablename));
  if (existing.length > 0) {
    throw new SchemaMigrationError(
      `${service}: found tables from an untracked (legacy) schema: ${existing.slice(0, 5).join(", ")}${existing.length > 5 ? ", …" : ""}. ${RESET_HINT}`
    );
  }
}
