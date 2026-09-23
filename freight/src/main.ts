/** Process entry point: read configuration, open the database, listen. */

import { SqliteStore } from "./adapters/sqlite-store.ts";
import { createServer } from "./http/server.ts";

const port = Number(process.env.PORT ?? 8080);
const databasePath = process.env.FREIGHT_DB ?? "data/freight.db";
const secureCookies = process.env.FREIGHT_SECURE_COOKIES === "1";

const store = new SqliteStore(databasePath);
const server = createServer({ store, secureCookies });

server.listen(port, () => {
  console.log(`freight marketplace on http://localhost:${port} (db: ${databasePath})`);
  if (!secureCookies) {
    console.log(
      "cookies are not marked Secure — set FREIGHT_SECURE_COOKIES=1 when serving over HTTPS",
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
