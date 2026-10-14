import assert from "node:assert/strict";
import test from "node:test";

import {
  checksumOf,
  planSchemaMigrations,
  runSchemaMigrations,
  SchemaMigrationError,
  tablesCreatedBy,
  type SchemaMigrationFile,
  type SchemaPool
} from "../schema-migrations.js";

const file = (version: string, sql: string): SchemaMigrationFile => ({ version, sql, checksum: checksumOf(sql) });

test("fresh database: every file is pending", () => {
  const files = [file("001_schema.sql", "create table a (id int);"), file("002_reference_data.sql", "insert into a values (1);")];
  const plan = planSchemaMigrations("svc", files, []);
  assert.deepEqual(plan.pending.map((item) => item.version), ["001_schema.sql", "002_reference_data.sql"]);
  assert.equal(plan.alreadyApplied, 0);
});

test("restart with nothing new is a no-op", () => {
  const files = [file("001_schema.sql", "create table a (id int);")];
  const plan = planSchemaMigrations("svc", files, [{ version: "001_schema.sql", checksum: files[0]!.checksum }]);
  assert.equal(plan.pending.length, 0);
  assert.equal(plan.alreadyApplied, 1);
});

test("a new numbered file is the only pending migration", () => {
  const files = [file("001_schema.sql", "create table a (id int);"), file("002_add_b.sql", "alter table a add column b int;")];
  const plan = planSchemaMigrations("svc", files, [{ version: "001_schema.sql", checksum: files[0]!.checksum }]);
  assert.deepEqual(plan.pending.map((item) => item.version), ["002_add_b.sql"]);
});

test("editing an applied file or deleting it is refused", () => {
  const files = [file("001_schema.sql", "create table a (id int, extra int);")];
  assert.throws(
    () => planSchemaMigrations("svc", files, [{ version: "001_schema.sql", checksum: checksumOf("create table a (id int);") }]),
    (error: unknown) => error instanceof SchemaMigrationError && /checksum mismatch/.test(error.message) && /db:reset/.test(error.message)
  );
  assert.throws(
    () => planSchemaMigrations("svc", [], [{ version: "001_schema.sql", checksum: "x" }]),
    (error: unknown) => error instanceof SchemaMigrationError && /no longer exists/.test(error.message)
  );
});

test("checksums ignore CRLF line endings", () => {
  assert.equal(checksumOf("a\r\nb\r\n"), checksumOf("a\nb\n"));
});

test("tablesCreatedBy reads plain, qualified and if-not-exists forms", () => {
  assert.deepEqual(
    tablesCreatedBy('CREATE TABLE public.accounts (\n); create table if not exists balances (); CREATE TABLE "ledger_entries" ();'),
    ["accounts", "balances", "ledger_entries"]
  );
});

// Minimal in-memory stand-in for a pg Pool: records statements, answers the few
// catalog queries the runner makes.
function fakePool(state: { recorded: Array<{ version: string; checksum: string }>; legacyTables: string[]; log: string[] }): SchemaPool {
  const client = {
    async query(sql: string, params: unknown[] = []) {
      state.log.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.startsWith("select version, checksum")) {
        return { rows: state.recorded.map((row) => ({ ...row })) };
      }
      if (sql.startsWith("select tablename")) {
        const wanted = params[0] as string[];
        return { rows: state.legacyTables.filter((name) => wanted.includes(name)).map((tablename) => ({ tablename })) };
      }
      if (sql.startsWith("insert into schema_migrations")) {
        state.recorded.push({ version: String(params[1]), checksum: String(params[2]) });
      }
      return { rows: [] };
    },
    release() {}
  };
  return { connect: async () => client };
}

test("runSchemaMigrations applies once, then is a no-op; legacy tables are refused", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "schema-migrations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "001_schema.sql"), "CREATE TABLE public.accounts (id int);");

  const state = { recorded: [] as Array<{ version: string; checksum: string }>, legacyTables: [] as string[], log: [] as string[] };
  const quiet = () => {};
  const first = await runSchemaMigrations(fakePool(state), { service: "svc", sqlDir: dir, log: quiet });
  assert.deepEqual(first.applied, ["001_schema.sql"]);
  assert.ok(state.log.includes("begin") && state.log.includes("commit"), "applied inside a transaction");

  const second = await runSchemaMigrations(fakePool(state), { service: "svc", sqlDir: dir, log: quiet });
  assert.deepEqual(second.applied, []);
  assert.equal(second.alreadyApplied, 1);

  const legacy = { recorded: [], legacyTables: ["accounts"], log: [] as string[] };
  await assert.rejects(
    runSchemaMigrations(fakePool(legacy), { service: "svc", sqlDir: dir, log: quiet }),
    (error: unknown) => error instanceof SchemaMigrationError && /legacy/.test(error.message)
  );
  assert.ok(!legacy.log.includes("begin"), "nothing is applied over a legacy schema");
});
