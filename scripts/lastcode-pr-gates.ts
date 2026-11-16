import {
  apiPages,
  assertNode,
  baseBranch,
  ciGate,
  gh,
  localState,
  parseOptions,
  repository,
  run,
  type Command,
} from "./lib/github.ts";

const bot = "chatgpt-codex-connector[bot]";
const shaPattern = /^[0-9a-f]{40}$/u;
export type Decision = {
  status: "ready" | "pending" | "attention";
  reason: string;
  detail: string;
};
export type PullRequest = {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  headRepository: { nameWithOwner: string } | null;
  mergeable: string;
  mergeStateStatus: string;
};
export type Comment = {
  id: number;
  body: string;
  created_at?: string;
  updated_at?: string;
  commit_id?: string;
  state?: string;
  submitted_at?: string;
  user?: { login?: string };
  author_association?: string;
};
export type WorkflowRun = {
  id: number;
  event: string;
  head_sha: string;
  display_title: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
};
export type Job = { name: string; status: string; conclusion: string | null };
const decision = (status: Decision["status"], reason: string, detail: string): Decision => ({
  status,
  reason,
  detail,
});

export function evaluateReview(
  head: string,
  comments: Comment[],
  reviews: Comment[],
  inline: Comment[],
  unresolved: number,
): Decision {
  if (unresolved > 0)
    return decision(
      "attention",
      "review-unresolved",
      `${unresolved} review threads remain unresolved.`,
    );
  if (inline.some((comment) => comment.user?.login === bot && comment.commit_id === head)) {
    return decision(
      "attention",
      "review-findings",
      "Codex reported inline findings on the current head.",
    );
  }
  const artifacts: { at: string; id: number; verdict: Decision }[] = [];
  for (const comment of comments) {
    if (comment.user?.login !== bot) continue;
    const summary =
      /^<!-- codex-pull-request-review-summary -->\r?\n<!-- codex-review-state:v1 (.+) -->/u.exec(
        comment.body,
      );
    if (summary) {
      try {
        const state = (JSON.parse(summary[1]!) as { code_review?: Record<string, unknown> })
          .code_review;
        if (state?.commit_sha !== head) continue;
        let verdict: Decision;
        if (state.status !== "completed") {
          verdict = decision(
            "pending",
            "review-pending",
            "Current-head Codex Review has not completed.",
          );
        } else if (state.has_any_findings === false && state.has_unresolved_findings === false) {
          verdict = decision(
            "ready",
            "review-clean",
            "Completed current-head Codex Review has no findings.",
          );
        } else {
          verdict = decision(
            "attention",
            "review-findings",
            "Codex Review reports findings or has incomplete result fields.",
          );
        }
        artifacts.push({ at: comment.created_at ?? "", id: comment.id, verdict });
      } catch {
        return decision(
          "attention",
          "review-malformed",
          "Codex Review summary could not be decoded.",
        );
      }
      continue;
    }
  }
  for (const review of reviews) {
    if (
      review.user?.login !== bot ||
      review.commit_id !== head ||
      !["PENDING", "CHANGES_REQUESTED"].includes(review.state ?? "")
    )
      continue;
    artifacts.push({
      at: review.submitted_at ?? "",
      id: review.id,
      verdict:
        review.state === "PENDING"
          ? decision("pending", "review-pending", "Current-head Codex Review is running.")
          : decision(
              "attention",
              "review-findings",
              "Codex requested changes on the current head.",
            ),
    });
  }
  artifacts.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
  const latest = artifacts.at(-1);
  const triggers = comments.filter((comment) => {
    if (!["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.author_association ?? ""))
      return false;
    if (!/^@codex review\b/iu.test(comment.body.trim())) return false;
    const requestedHead = /<!-- lastcode-review-head: ([0-9a-f]{40}) -->/u.exec(comment.body)?.[1];
    return requestedHead === undefined || requestedHead === head;
  });
  if (triggers.some((trigger) => !latest || (trigger.created_at ?? "") >= latest.at)) {
    return decision(
      "pending",
      "review-pending",
      "A newer Codex review request is awaiting a completed result.",
    );
  }
  // An explicit running summary cannot be replaced by an unrelated approval or reaction.
  if (artifacts.some((artifact) => artifact.verdict.status === "pending")) {
    return decision("pending", "review-pending", "Current-head Codex Review is still running.");
  }
  return (
    latest?.verdict ??
    decision(
      "attention",
      "review-missing",
      "No completed Codex Review exists for the current head.",
    )
  );
}

export function selectRun(pr: PullRequest, runs: WorkflowRun[]): WorkflowRun | undefined {
  const prefix = `CI pull_request PR #${pr.number} head ${pr.headRefOid} base ${pr.baseRefOid} merge `;
  return runs
    .filter(
      (item) =>
        item.event === "pull_request" &&
        item.head_sha === pr.headRefOid &&
        item.display_title.startsWith(prefix) &&
        shaPattern.test(item.display_title.slice(prefix.length)),
    )
    .toSorted((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
}

export function evaluateCi(item: WorkflowRun | undefined, jobs: Job[]): Decision {
  if (!item)
    return decision("attention", "ci-missing", "No CI run exists for the exact PR head and base.");
  if (item.status !== "completed") {
    return ["queued", "in_progress", "pending", "waiting", "requested"].includes(item.status)
      ? decision("pending", "ci-pending", "Exact-head/base CI is still running.")
      : decision("attention", "ci-invalid", "CI has an unknown status.");
  }
  if (item.conclusion !== "success")
    return decision(
      "attention",
      "ci-failed",
      `CI completed with ${item.conclusion ?? "no result"}.`,
    );
  const gates = jobs.filter((job) => job.name === ciGate);
  return gates.length === 1 && gates[0]?.status === "completed" && gates[0].conclusion === "success"
    ? decision("ready", "ci-passed", `${ciGate} passed for the exact PR head and base.`)
    : decision(
        "attention",
        "ci-gate-failed",
        `Exactly one successful, completed ${ciGate} job is required.`,
      );
}

const fields =
  "number,url,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,headRepository,mergeable,mergeStateStatus";
export function readPr(target: string | number, command: Command = run): PullRequest {
  return gh(["pr", "view", String(target), "--repo", repository, "--json", fields], command);
}
export function sameRevision(a: PullRequest, b: PullRequest): boolean {
  return (
    a.number === b.number &&
    a.state === b.state &&
    a.isDraft === b.isDraft &&
    a.headRefOid === b.headRefOid &&
    a.headRefName === b.headRefName &&
    a.baseRefOid === b.baseRefOid &&
    a.baseRefName === b.baseRefName &&
    a.headRepository?.nameWithOwner === b.headRepository?.nameWithOwner
  );
}

function unresolvedThreads(pr: number, command: Command): number {
  type Page = {
    errors?: unknown[];
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: { isResolved: boolean }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
    };
  };
  const pages = gh<Page[]>(
    [
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `query=
    query($endCursor:String) {
      repository(owner:"lastobelus",name:"dopamine") {
        pullRequest(number:${pr}) {
          reviewThreads(first:100,after:$endCursor) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
        }
      }
    }`,
    ],
    command,
  );
  if (pages.length === 0 || pages.some((page) => page.errors?.length))
    throw new Error("Could not read review threads.");
  if (pages.at(-1)?.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage) {
    throw new Error("Review-thread pagination was incomplete.");
  }
  return pages
    .flatMap((page) => page.data.repository.pullRequest.reviewThreads.nodes)
    .filter((thread) => !thread.isResolved).length;
}

function readCi(pr: PullRequest, command: Command): Decision {
  const workflow = gh<{ state: string }>(
    ["api", `repos/${repository}/actions/workflows/ci.yml`],
    command,
  );
  if (workflow.state !== "active")
    return decision("attention", "ci-disabled", "The CI workflow is not active.");
  type Rule = { type: string; parameters?: { required_status_checks?: { context: string }[] } };
  const rules = apiPages<Rule>(
    `repos/${repository}/rules/branches/${baseBranch}?per_page=100`,
    command,
  );
  if (
    !rules.some(
      (rule) =>
        rule.type === "required_status_checks" &&
        rule.parameters?.required_status_checks?.some((check) => check.context === ciGate),
    )
  ) {
    return decision("attention", "ci-not-required", `${ciGate} must be required on ${baseBranch}.`);
  }
  const pages = gh<{ workflow_runs: WorkflowRun[] }[]>(
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.headRefOid}&per_page=100`,
    ],
    command,
  );
  const selected = selectRun(
    pr,
    pages.flatMap((page) => page.workflow_runs),
  );
  const jobs =
    selected?.status === "completed" && selected.conclusion === "success"
      ? gh<{ jobs: Job[] }[]>(
          [
            "api",
            "--paginate",
            "--slurp",
            `repos/${repository}/actions/runs/${selected.id}/attempts/${selected.run_attempt}/jobs?per_page=100`,
          ],
          command,
        ).flatMap((page) => page.jobs)
      : [];
  return evaluateCi(selected, jobs);
}

export function readGates(prNumber?: number, command: Command = run) {
  const local = prNumber === undefined ? localState(command) : undefined;
  const pr = readPr(prNumber ?? local!.branch, command);
  const finish = (verdict: Decision) => ({
    ...verdict,
    repository,
    pr: pr.number,
    url: pr.url,
    head: pr.headRefOid,
    base: { name: pr.baseRefName, sha: pr.baseRefOid },
  });
  if (
    local &&
    (!local.clean || !local.branch || local.branch === baseBranch || local.head !== pr.headRefOid)
  ) {
    return finish(
      decision(
        "attention",
        "checkout-mismatch",
        "Use a clean feature checkout matching the PR head, or pass a PR number for a read-only check.",
      ),
    );
  }
  if (
    pr.state !== "OPEN" ||
    pr.isDraft ||
    pr.baseRefName !== baseBranch ||
    !shaPattern.test(pr.headRefOid) ||
    !shaPattern.test(pr.baseRefOid)
  ) {
    return finish(
      decision(
        "attention",
        "pr-invalid",
        `An open, non-draft PR targeting ${baseBranch} with valid revisions is required.`,
      ),
    );
  }
  if (pr.mergeable === "CONFLICTING" || ["DIRTY", "BEHIND"].includes(pr.mergeStateStatus)) {
    return finish(
      decision(
        "attention",
        "merge-blocked",
        `PR merge requirements need attention (${pr.mergeStateStatus}).`,
      ),
    );
  }
  const path = `repos/${repository}`;
  const comments = apiPages<Comment>(`${path}/issues/${pr.number}/comments?per_page=100`, command);
  const reviews = apiPages<Comment>(`${path}/pulls/${pr.number}/reviews?per_page=100`, command);
  const inline = apiPages<Comment>(`${path}/pulls/${pr.number}/comments?per_page=100`, command);
  const review = evaluateReview(
    pr.headRefOid,
    comments,
    reviews,
    inline,
    unresolvedThreads(pr.number, command),
  );
  const ci = readCi(pr, command);
  const confirmed = readPr(pr.number, command);
  const main = gh<{ object: { sha: string } }>(
    ["api", `${path}/git/ref/heads/${baseBranch}`],
    command,
  ).object.sha;
  if (
    !sameRevision(pr, confirmed) ||
    main !== pr.baseRefOid ||
    (local && JSON.stringify(localState(command)) !== JSON.stringify(local))
  ) {
    return finish(
      decision(
        "attention",
        "revision-changed",
        "The PR, checkout, or base changed while gates were checked; check again.",
      ),
    );
  }
  if (ci.reason === "ci-missing" && review.status === "pending") {
    return finish(
      decision(
        "pending",
        "ci-registration",
        "Codex Review is running and exact-head/base CI has not registered yet.",
      ),
    );
  }
  const attention = [review, ci].find((item) => item.status === "attention");
  if (attention) return finish(attention);
  const pending = [review, ci].find((item) => item.status === "pending");
  if (pending) return finish(pending);
  if (confirmed.mergeStateStatus === "BLOCKED") {
    return finish(
      decision(
        "attention",
        "merge-blocked",
        "A repository merge requirement is still unsatisfied.",
      ),
    );
  }
  if (confirmed.mergeable !== "MERGEABLE" || confirmed.mergeStateStatus !== "CLEAN") {
    return finish(
      decision(
        "attention",
        "mergeability-unknown",
        "GitHub has not confirmed clean mergeability; check again.",
      ),
    );
  }
  return finish(
    decision(
      "ready",
      "ready",
      "Required exact-head/base CI and completed clean Codex Review passed.",
    ),
  );
}

if (import.meta.main) {
  try {
    assertNode();
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log("Usage: pnpm lastcode:pr-gates -- [PR_NUMBER | --pr PR_NUMBER]");
    else {
      const result = readGates(options.pr);
      console.log(JSON.stringify(result));
      if (result.status === "attention") process.exitCode = 1;
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "attention",
        reason: "observation-failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
