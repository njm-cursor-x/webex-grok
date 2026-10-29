import { loadConfig } from "./config.ts";
import { startServer } from "./http.ts";
import { TokenStore } from "./store.ts";

const config = loadConfig(process.env);
const store = new TokenStore(config.dataPath, config.encryptionKey);
const server = startServer(config, store);

server.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "listen", port: config.port }));
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
