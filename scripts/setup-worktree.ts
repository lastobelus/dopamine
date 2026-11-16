import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cwd = resolve(import.meta.dirname, "..");

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  engines: { node: string };
  packageManager: string;
};
if (process.versions.node !== manifest.engines.node) {
  throw new Error(`Use Node ${manifest.engines.node} before setting up this worktree.`);
}
const manager = spawnSync("pnpm", ["--version"], { cwd, encoding: "utf8" });
const expected = manifest.packageManager.replace(/^pnpm@/u, "").split("+")[0];
if (manager.error || manager.status !== 0 || manager.stdout.trim() !== expected) {
  throw new Error(`Install ${manifest.packageManager} before setting up this worktree.`);
}
const result = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
