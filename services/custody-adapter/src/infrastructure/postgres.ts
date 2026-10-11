import type { Pool, PoolClient } from "pg";
import { Pool as PgPool } from "pg";

export function createCustodyPool(): Pool {
  const sslMode = process.env.PGSSL ?? "false";
  const useSsl = sslMode !== "false";
  const connectionString =
    process.env.DATABASE_URL ??
    "postgres://web3:web3@127.0.0.1:5432/web3_cex";

  return new PgPool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined
  });
}

export async function withPgTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
