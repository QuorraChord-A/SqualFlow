import { config } from "./config.js";
import { createApp } from "./server/app.js";

const app = createApp();

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
};

process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });

await app.listen({ host: config.host, port: config.port });
