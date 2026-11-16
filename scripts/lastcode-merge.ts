import {
  assertNode,
  baseBranch,
  gh,
  localState,
  parseOptions,
  repository,
  run,
  type Command,
} from "./lib/github.ts";
import { readGates, readPr, sameRevision } from "./lastcode-pr-gates.ts";

export function mergePullRequest(
  prNumber: number | undefined,
  dryRun: boolean,
  command: Command = run,
) {
  const local = localState(command);
  const pr = readPr(prNumber ?? local.branch, command);
  const assertCheckout = () => {
    const current = localState(command);
    if (
      !current.clean ||
      !current.branch ||
      current.branch === baseBranch ||
      current.head !== pr.headRefOid ||
      current.branch !== pr.headRefName ||
      pr.headRepository?.nameWithOwner !== repository ||
      JSON.stringify(local) !== JSON.stringify(current)
    ) {
      throw new Error(
        "Merge from the PR's clean feature checkout with local HEAD equal to the PR head.",
      );
    }
  };
  assertCheckout();
  const snapshot = readGates(pr.number, command);
  if (snapshot.status !== "ready") throw new Error(`${snapshot.reason}: ${snapshot.detail}`);
  command("git", ["fetch", "--no-tags", "origin", baseBranch]);
  const fetchedBase = command("git", ["rev-parse", "FETCH_HEAD"]);
  // Re-read all gates immediately before merging; a moving head, base, or new review invalidates the snapshot.
  const final = readGates(pr.number, command);
  if (
    final.status !== "ready" ||
    final.head !== snapshot.head ||
    final.base.sha !== snapshot.base.sha ||
    final.base.sha !== fetchedBase ||
    !sameRevision(pr, readPr(pr.number, command))
  ) {
    throw new Error("PR revisions or gates changed before merging; run the gate check again.");
  }
  assertCheckout();
  if (dryRun)
    return { merged: false, dryRun: true, url: pr.url, head: final.head, base: final.base.sha };
  const result = gh<{ merged: boolean; sha: string; message: string }>(
    [
      "api",
      "--method",
      "PUT",
      `repos/${repository}/pulls/${pr.number}/merge`,
      "-f",
      "merge_method=squash",
      "-f",
      `sha=${final.head}`,
    ],
    command,
  );
  if (!result.merged || !/^[0-9a-f]{40}$/u.test(result.sha))
    throw new Error(`Merge was refused: ${result.message}`);
  const merged = gh<{
    state: string;
    merged: boolean;
    base: { ref: string };
    head: { sha: string };
    merge_commit_sha: string;
  }>(["api", `repos/${repository}/pulls/${pr.number}`], command);
  if (
    !merged.merged ||
    merged.state !== "closed" ||
    merged.base.ref !== baseBranch ||
    merged.head.sha !== final.head ||
    merged.merge_commit_sha !== result.sha
  ) {
    throw new Error(
      `Merge returned ${result.sha}, but the final PR state could not be confirmed. Inspect it before retrying.`,
    );
  }
  return { merged: true, url: pr.url, head: final.head, commit: result.sha };
}

if (import.meta.main) {
  try {
    assertNode();
    const options = parseOptions(process.argv.slice(2), true);
    if (options.help)
      console.log("Usage: pnpm lastcode:merge -- [PR_NUMBER | --pr PR_NUMBER] [--dry-run]");
    else console.log(JSON.stringify(mergePullRequest(options.pr, options.dryRun)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
