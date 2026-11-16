import { describe, expect, it } from "vite-plus/test";
import {
  evaluateCi,
  evaluateReview,
  readGates,
  sameRevision,
  selectRun,
  type Comment,
  type PullRequest,
  type WorkflowRun,
} from "./lastcode-pr-gates.ts";
import { mergePullRequest } from "./lastcode-merge.ts";
import { parseOptions, type Command } from "./lib/github.ts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const bot = { login: "chatgpt-codex-connector[bot]" };
const pr: PullRequest = {
  number: 12,
  url: "https://github.com/lastobelus/dopamine/pull/12",
  state: "OPEN",
  isDraft: false,
  headRefName: "feature",
  headRefOid: head,
  baseRefName: "main",
  baseRefOid: base,
  headRepository: { nameWithOwner: "lastobelus/dopamine" },
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
};
const run: WorkflowRun = {
  id: 10,
  event: "pull_request",
  head_sha: head,
  display_title: `CI pull_request PR #12 head ${head} base ${base} merge ${"c".repeat(40)}`,
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
};
const jobs = [{ name: "CI Gate", status: "completed", conclusion: "success" }];
function summary(state: Record<string, unknown> = {}): Comment {
  return {
    id: 1,
    created_at: "2026-01-01T00:00:00Z",
    user: bot,
    body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
      code_review: {
        commit_sha: head,
        status: "completed",
        has_any_findings: false,
        has_unresolved_findings: false,
        ...state,
      },
    })} -->`,
  };
}

function fixture(
  options: {
    comments?: Comment[];
    dirty?: boolean;
    runs?: WorkflowRun[];
    branch?: string;
    pullRequest?: PullRequest;
    changeAtRead?: number;
  } = {},
) {
  const calls: { program: string; args: readonly string[] }[] = [];
  let reads = 0;
  const current = options.pullRequest ?? pr;
  const command: Command = (program, args) => {
    calls.push({ program, args });
    if (program === "git") {
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse") return args[1] === "FETCH_HEAD" ? base : head;
      if (args[0] === "branch") return options.branch ?? "feature";
      if (args[0] === "status") return options.dirty ? " M server.ts" : "";
    }
    if (args[0] === "pr") {
      reads++;
      return JSON.stringify(
        options.changeAtRead && reads >= options.changeAtRead
          ? { ...current, headRefOid: "d".repeat(40) }
          : current,
      );
    }
    if (args.includes("graphql"))
      return JSON.stringify([
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        },
      ]);
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args.includes("PUT")) return JSON.stringify({ merged: true, sha: "e".repeat(40) });
    if (path.endsWith("comments?per_page=100")) {
      return JSON.stringify([path.includes("/issues/") ? (options.comments ?? [summary()]) : []]);
    }
    if (path.endsWith("reviews?per_page=100")) return "[[]]";
    if (path.includes("/rules/branches/"))
      return JSON.stringify([
        [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "CI Gate" }] },
          },
        ],
      ]);
    if (path.endsWith("workflows/ci.yml")) return JSON.stringify({ state: "active" });
    if (path.includes("/runs?")) return JSON.stringify([{ workflow_runs: options.runs ?? [run] }]);
    if (path.includes("/jobs?")) return JSON.stringify([{ jobs }]);
    if (path.endsWith("/git/ref/heads/main")) return JSON.stringify({ object: { sha: base } });
    if (path.endsWith("/pulls/12"))
      return JSON.stringify({
        state: "closed",
        merged: true,
        base: { ref: "main" },
        head: { sha: head },
        merge_commit_sha: "e".repeat(40),
      });
    throw new Error(`Unexpected command: ${program} ${args.join(" ")}`);
  };
  return { command, calls };
}

describe("completed current-head review", () => {
  it("accepts only explicit clean completed state from the Codex bot", () => {
    expect(evaluateReview(head, [summary()], [], [], 0).status).toBe("ready");
    expect(
      evaluateReview(head, [{ ...summary(), user: { login: "someone" } }], [], [], 0).status,
    ).toBe("attention");
    expect(evaluateReview(head, [summary({ commit_sha: base })], [], [], 0).status).toBe(
      "attention",
    );
  });
  it("keeps running review pending even with clean-looking booleans or approval", () => {
    expect(
      evaluateReview(
        head,
        [summary({ status: "running" })],
        [
          {
            ...summary(),
            commit_id: head,
            state: "APPROVED",
            submitted_at: "2026-01-02T00:00:00Z",
          },
        ],
        [],
        0,
      ).status,
    ).toBe("pending");
  });
  it("refuses findings and missing strict result fields", () => {
    for (const state of [
      { has_any_findings: true },
      { has_unresolved_findings: true },
      { has_any_findings: null },
    ]) {
      expect(evaluateReview(head, [summary(state)], [], [], 0).status).toBe("attention");
    }
    expect(evaluateReview(head, [summary()], [], [], 1).reason).toBe("review-unresolved");
    expect(evaluateReview(head, [], [], [{ ...summary(), commit_id: head }], 0).reason).toBe(
      "review-findings",
    );
  });
  it("invalidates an earlier clean result after a new review request", () => {
    const trigger = {
      id: 2,
      created_at: "2026-01-02T00:00:00Z",
      author_association: "OWNER",
      body: `@codex review\n<!-- lastcode-review-head: ${head} -->`,
    };
    expect(
      evaluateReview(
        head,
        [{ ...summary(), updated_at: "2026-01-03T00:00:00Z" }, trigger],
        [],
        [],
        0,
      ).status,
    ).toBe("pending");
  });
  it("accepts a completed same-head rerun only when the code-review lifecycle timestamp follows the request", () => {
    const trigger = {
      id: 2,
      created_at: "2026-01-02T00:00:00Z",
      author_association: "OWNER",
      body: `@codex review\n<!-- lastcode-review-head: ${head} -->`,
    };
    const completed = { ...summary(), updated_at: "2026-01-03T00:00:01Z" };
    completed.body +=
      '\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-01-03T00:00:00Z">done</relative-time> |';
    expect(evaluateReview(head, [completed, trigger], [], [], 0).status).toBe("ready");
    const unchangedLifecycle = {
      ...completed,
      body: completed.body.replace(
        'datetime="2026-01-03T00:00:00Z"',
        'datetime="2026-01-01T00:00:00Z"',
      ),
    };
    expect(evaluateReview(head, [unchangedLifecycle, trigger], [], [], 0).status).toBe("pending");
    const running = {
      ...summary({ status: "running" }),
      body:
        summary({ status: "running" }).body + completed.body.slice(completed.body.indexOf("\n|")),
    };
    expect(evaluateReview(head, [running, trigger], [], [], 0).status).toBe("pending");
  });
  it("allows resolved historical inline findings after a clean same-head rerun", () => {
    const inline = [{ ...summary(), commit_id: head }];
    expect(evaluateReview(head, [summary()], [], inline, 0).status).toBe("ready");
    expect(evaluateReview(head, [summary()], [], inline, 1).reason).toBe("review-unresolved");
    expect(evaluateReview(head, [summary({ has_any_findings: true })], [], inline, 0).status).toBe(
      "attention",
    );
    expect(evaluateReview(head, [summary({ status: "running" })], [], inline, 0).status).toBe(
      "pending",
    );
  });
  it("does not let formal approval bypass missing or finding-bearing structured review", () => {
    const approval = {
      ...summary(),
      commit_id: head,
      state: "APPROVED",
      submitted_at: "2026-01-02T00:00:00Z",
    };
    expect(evaluateReview(head, [], [approval], [], 0).status).toBe("attention");
    expect(
      evaluateReview(head, [summary({ has_any_findings: true })], [approval], [], 0).status,
    ).toBe("attention");
  });
});

describe("exact CI evidence", () => {
  it("matches both head and base and rejects a superseded run", () => {
    expect(selectRun(pr, [run])).toEqual(run);
    expect(selectRun({ ...pr, baseRefOid: "f".repeat(40) }, [run])).toBeUndefined();
    expect(evaluateCi({ ...run, id: 11, conclusion: "cancelled" }, jobs).status).toBe("attention");
  });
  it("requires one successful completed CI Gate and a successful run", () => {
    expect(evaluateCi(run, jobs).status).toBe("ready");
    expect(evaluateCi(run, []).status).toBe("attention");
    expect(evaluateCi(run, [...jobs, ...jobs]).status).toBe("attention");
    expect(evaluateCi({ ...run, conclusion: "failure" }, jobs).status).toBe("attention");
    expect(evaluateCi({ ...run, status: "in_progress" }, []).status).toBe("pending");
  });
});

describe("safe snapshot and squash", () => {
  it("waits through blocked mergeability while CI or review is pending", () => {
    const options = {
      pullRequest: { ...pr, mergeStateStatus: "BLOCKED" },
      comments: [summary({ status: "running" })],
      runs: [{ ...run, status: "in_progress" }],
    };
    expect(readGates(12, fixture(options).command).status).toBe("pending");
    expect(readGates(12, fixture({ ...options, runs: [] }).command).reason).toBe("ci-registration");
  });

  it("supports documented positional arguments and --pr", () => {
    expect(parseOptions(["--", "12"]).pr).toBe(12);
    expect(parseOptions(["--pr", "12"]).pr).toBe(12);
    expect(parseOptions(["--", "12", "--dry-run"], true).dryRun).toBe(true);
    for (const args of [["0"], ["12", "13"], ["--pr"], ["--admin"]])
      expect(() => parseOptions(args, true)).toThrow();
  });
  it("detects any head or base revision change", () => {
    expect(sameRevision(pr, { ...pr, headRefOid: base })).toBe(false);
    expect(sameRevision(pr, { ...pr, baseRefName: "other" })).toBe(false);
    const { command } = fixture({ changeAtRead: 2 });
    expect(readGates(12, command).reason).toBe("revision-changed");
  });
  it("permits read-only numbered checks in a dirty checkout but blocks merges", () => {
    const { command } = fixture({ dirty: true });
    expect(readGates(12, command).status).toBe("ready");
    expect(() => mergePullRequest(12, false, command)).toThrow("clean feature checkout");
  });
  it("makes dry-run read-only and refuses wrong branches or findings", () => {
    const { command, calls } = fixture();
    expect(mergePullRequest(12, true, command).merged).toBe(false);
    expect(calls.some((call) => call.args.includes("PUT"))).toBe(false);
    expect(() => mergePullRequest(12, false, fixture({ branch: "main" }).command)).toThrow();
    expect(() =>
      mergePullRequest(
        12,
        false,
        fixture({ comments: [summary({ has_any_findings: true })] }).command,
      ),
    ).toThrow();
  });
  it("stops a changing head before the merge mutation", () => {
    const { command, calls } = fixture({ changeAtRead: 4 });
    expect(() => mergePullRequest(12, false, command)).toThrow();
    expect(calls.some((call) => call.args.includes("PUT"))).toBe(false);
  });
  it("squashes using the checked head and verifies the terminal PR state", () => {
    const { command, calls } = fixture();
    expect(mergePullRequest(12, false, command).merged).toBe(true);
    const mutation = calls.find((call) => call.args.includes("PUT"));
    expect(mutation?.args).toContain("merge_method=squash");
    expect(mutation?.args).toContain(`sha=${head}`);
  });
});
