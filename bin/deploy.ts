#!/usr/bin/env node
import { parseArgs } from "node:util";
import { deploy } from "../src/deploy.ts";

try {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      source: { type: "string" },
      rollback: { type: "boolean" },
    },
  });
  if (!values.config) throw new Error("Pass --config with a private configuration file");
  const options: { source?: string; rollback?: boolean } = {};
  if (values.source) options.source = values.source;
  if (values.rollback) options.rollback = true;
  console.log(`Deployment ready: ${await deploy(values.config, options)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Deployment failed");
  process.exitCode = 1;
}
