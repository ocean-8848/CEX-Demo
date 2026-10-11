import { createTraderWebServer, buildRuntimeConfig } from "./server.js";

const port = Number(process.env.PORT ?? "3013");
const server = createTraderWebServer(buildRuntimeConfig());

server.listen(port, "127.0.0.1", () => {
  console.log(`trader-web listening on http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
  });
}
