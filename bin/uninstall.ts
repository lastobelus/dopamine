#!/usr/bin/env node
import { parseArgs } from "node:util";
import { uninstall } from "../src/deploy.ts";

try {
  const { values } = parseArgs({
    options: { config: { type: "string" }, purge: { type: "boolean" } },
  });
  if (!values.config) throw new Error("Pass --config with a private configuration file");
  await uninstall(values.config, { purge: values.purge ?? false });
  console.log(
    values.purge
      ? "Uninstalled and removed dashboard data"
      : "Uninstalled; private configuration, credentials and dashboard data preserved",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Uninstall failed");
  process.exitCode = 1;
}
