#!/usr/bin/env node
import { runDash } from "../src/client.ts";

try {
  console.log(await runDash(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Dash command failed");
  process.exitCode = 1;
}
