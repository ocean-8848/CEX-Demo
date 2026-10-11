import { Pool } from "pg";

export function createRiskPool(): Pool {
  const sslEnabled = process.env.PGSSL === "true";

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? "5432"),
    user: process.env.PGUSER ?? "web3",
    password: process.env.PGPASSWORD ?? "web3",
    database: process.env.PGDATABASE ?? "web3_cex",
    max: Number(process.env.RISK_PG_POOL_MAX ?? "4"),
    ssl: sslEnabled
      ? {
          rejectUnauthorized: false
        }
      : undefined
  });
}
