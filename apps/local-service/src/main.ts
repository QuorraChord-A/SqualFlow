import { config } from "./config.js";
import { createApp } from "./server/app.js";

const app = createApp();

await app.listen({ host: config.host, port: config.port });
