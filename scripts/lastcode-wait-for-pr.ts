import { setTimeout } from "node:timers/promises";
import { actionEvent } from "./lib/action-report.ts";
import { assertNode, localState, parseOptions } from "./lib/github.ts";
import { readGates, readPr } from "./lastcode-pr-gates.ts";

// Polling belongs inside this saved Action; agents launch it once and resume on its final report.
export async function waitForPr(prNumber?: number): Promise<void> {
  const initial = readPr(prNumber ?? localState().branch);
  const deadline = Date.now() + 45 * 60_000;
  for (;;) {
    const result = readGates(initial.number);
    const changed = result.head !== initial.headRefOid || result.base.sha !== initial.baseRefOid;
    const expired = Date.now() >= deadline;
    const subject = {
      type: "pull-request",
      id: String(result.pr),
      revision: result.head,
      url: result.url,
    };
    if (changed || expired || result.status !== "pending") {
      const success = !changed && !expired && result.status === "ready";
      actionEvent("result", {
        outcome: success ? "success" : "attention",
        reason: changed ? "revision-changed" : expired ? "wait-expired" : result.reason,
        summary: changed
          ? "The PR head or base changed; inspect the new revision."
          : expired
            ? "The PR wait expired; inspect the remaining checks or review."
            : result.detail,
        subject,
      });
      process.exitCode = success ? 0 : 1;
      return;
    }
    actionEvent("progress", { state: "waiting", summary: result.detail });
    // oxlint-disable-next-line no-await-in-loop -- This saved Action observes one snapshot per interval.
    await setTimeout(60_000);
  }
}

if (import.meta.main) {
  try {
    assertNode();
    const options = parseOptions(process.argv.slice(2));
    if (options.help)
      console.log("Usage: node scripts/lastcode-wait-for-pr.ts [PR_NUMBER | --pr PR_NUMBER]");
    else await waitForPr(options.pr);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    actionEvent("result", {
      outcome: "attention",
      reason: "observation-failed",
      summary: "The PR wait could not read GitHub; inspect the terminal error.",
    });
    process.exitCode = 1;
  }
}
