import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export interface SqlClient {
  query<Row extends QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<Row>>;
}

export interface LedgerDatabaseConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

export function createLedgerPool(config: LedgerDatabaseConfig = {}): Pool {
  const sslEnabled = config.ssl ?? (process.env.PGSSL === "true");

  return new Pool({
    connectionString: config.connectionString ?? process.env.DATABASE_URL,
    host: config.host ?? process.env.PGHOST ?? "127.0.0.1",
    port: config.port ?? Number(process.env.PGPORT ?? "5432"),
    user: config.user ?? process.env.PGUSER ?? "web3",
    password: config.password ?? process.env.PGPASSWORD ?? "web3",
    database: config.database ?? process.env.PGDATABASE ?? "web3_cex",
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
