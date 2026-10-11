import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export interface SqlClient {
  query<Row extends QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<Row>>;
}

export function createSettlementPool(): Pool {
  const sslEnabled = process.env.PGSSL === "true";

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? "5432"),
    user: process.env.PGUSER ?? "web3",
    password: process.env.PGPASSWORD ?? "web3",
    database: process.env.PGDATABASE ?? "web3_cex",
    ssl: sslEnabled
      ? {
          rejectUnauthorized: false
        }
      : undefined
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
