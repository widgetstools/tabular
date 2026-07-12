import "dotenv/config";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

startServer(loadConfig()).catch((err) => {
  console.error(err);
  process.exit(1);
});
