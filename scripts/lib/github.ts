import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const repository = "lastobelus/dopamine";
export const baseBranch = "main";
export const ciGate = "CI Gate";
const root = resolve(import.meta.dirname, "../..");
export type Command = (program: string, args: readonly string[]) => string;

export const run: Command = (program, args) => {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"])
    delete env[key];
  const result = spawnSync(program, [...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${program} ${args[0] ?? ""} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
};

export function gh<T>(args: readonly string[], command: Command = run): T {
  return JSON.parse(command("gh", args)) as T;
}

export function apiPages<T>(path: string, command: Command): T[] {
  return gh<T[][]>(["api", "--paginate", "--slurp", path], command).flat();
}

export function assertNode(): void {
  if (process.versions.node !== "26.12.1")
    throw new Error("Use Node 26.12.1 for repository tooling.");
}

export function localState(command: Command = run) {
  return {
    head: command("git", ["rev-parse", "HEAD"]),
    branch: command("git", ["branch", "--show-current"]),
    clean: command("git", ["status", "--porcelain"]) === "",
  };
}

export function parseOptions(args: readonly string[], merge = false) {
  const tokens = args[0] === "--" ? args.slice(1) : [...args];
  let pr: number | undefined;
  let dryRun = false;
  let help = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") help = true;
    else if (merge && token === "--dry-run" && !dryRun) dryRun = true;
    else {
      const value = token === "--pr" ? tokens[++index] : token;
      if (pr !== undefined || !/^[1-9][0-9]*$/u.test(value ?? "")) {
        throw new Error("Expected one PR number, optionally preceded by --pr.");
      }
      pr = Number(value);
      if (!Number.isSafeInteger(pr)) throw new Error("Invalid PR number.");
    }
  }
  return { pr, dryRun, help };
}
