import { readConfig } from "./src/config.ts";
import { startHub } from "./src/hub.ts";

const args = process.argv.slice(2);
const flag = args.indexOf("--config");
try {
  const config = await readConfig(flag >= 0 ? args[flag + 1] : undefined);
  const hub = await startHub(config);
  process.on("SIGTERM", () => void hub.close());
  process.on("SIGINT", () => void hub.close());
  console.log(`dopamine hub ready: ${config.machine}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
