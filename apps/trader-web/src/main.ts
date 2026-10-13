import { createTraderWebServer, buildRuntimeConfig } from "./server.js";

const port = Number(process.env.PORT ?? "3013");
const host = process.env.TRADER_WEB_BIND_HOST ?? "127.0.0.1";
const server = createTraderWebServer(buildRuntimeConfig());

server.listen(port, host, () => {
  console.log(`trader-web listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
  });
}
