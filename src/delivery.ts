import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { isPull } from "./model.ts";
import type { ThreadReference } from "./model.ts";
import { threadEnvironment } from "./config.ts";
import type { HubConfig, ThreadEnvironment } from "./config.ts";
import type { ActionRequest, ActionStore } from "./actions.ts";

/** Waits after the first four failed attempts; the fifth stalls until Retry or Abandon. */
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000];
const MAX_ATTEMPTS = 5;
const OUTPUT_LIMIT = 1024 * 1024;

export interface DeliveryOptions {
  ssh?: string;
  now?: () => number;
  sendTimeoutMs?: number;
  intervalMs?: number;
  /** Deliver only when `runOnce` is called, as tests do. */
  manual?: boolean;
}

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
  started: boolean;
  timedOut: boolean;
}

function run(argv: string[], input: string, timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    let stdout = "",
      stderr = "",
      timedOut = false,
      started = false;
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("spawn", () => {
      started = true;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {
      /* The exit status reports a closed input pipe. */
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, started, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, started, timedOut });
    });
    child.stdin.end(input);
  });
}

/** Quotes one word for the remote shell, leaving a leading `~/` for it to expand. */
export function remoteWord(word: string): string {
  const home = word.startsWith("~/") ? "~/" : "";
  const rest = word.slice(home.length);
  return `${home}'${rest.replaceAll("'", "'\\''")}'`;
}

async function executable(command: string): Promise<boolean> {
  const candidates = command.includes("/")
    ? [command]
    : (process.env.PATH ?? "").split(delimiter).map((folder) => join(folder, command));
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop -- The first executable match wins.
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return false;
}

/** The text a handler thread receives. It names the request; the claim returns what to act on. */
function deliveryMessage(machine: string, id: string, request: ActionRequest): string {
  const name = `${machine}/${id}`;
  return `[dashboard action] ${JSON.stringify({
    dashboard: name,
    requestId: request.requestId,
    target: request.target,
    action: request.action,
    payload: request.payload,
  })}
Claim it before acting: dash action claim ${name} ${request.requestId}
Act only on what the claim returns, then run dash action ack. If the claim is refused, do nothing.\n`;
}

/**
 * Sends queued requests to their handler threads with the thread CLI, one queue per thread,
 * in order. A failure is retried automatically only when nothing can have been sent.
 */
export class Delivery {
  private readonly config: HubConfig;
  private readonly actions: ActionStore;
  private readonly options: DeliveryOptions;
  private readonly busy = new Set<string>();
  private readonly flights = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private pass: Promise<void> | undefined;

  constructor(config: HubConfig, actions: ActionStore, options: DeliveryOptions = {}) {
    this.config = config;
    this.actions = actions;
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async start(): Promise<void> {
    await this.actions.recoverSending();
    if (this.options.manual) return;
    const tick = () => {
      if (this.stopped) return;
      this.wake();
      this.timer = setTimeout(tick, this.options.intervalMs ?? 5000);
      this.timer.unref();
    };
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pass;
    await Promise.all(this.flights);
  }

  /** Starts a pass unless one is running; sends run in the background. */
  wake(): void {
    if (this.pass || this.stopped || this.options.manual) return;
    this.pass = this.runOnce()
      .catch((error: unknown) =>
        console.error(
          `Action delivery pass failed: ${error instanceof Error ? error.message : ""}`,
        ),
      )
      .finally(() => {
        this.pass = undefined;
      });
  }

  /** One pass: start the due head of each idle queue. Resolves when those sends finish. */
  async runOnce(): Promise<void> {
    const queues = new Map<string, { id: string; request: ActionRequest }[]>();
    for (const { id, requests } of await this.actions.liveRequests())
      for (const request of requests) {
        if (isPull(request.handler) || request.handling !== "unclaimed") continue;
        if (!["queued", "failed"].includes(request.transport)) continue;
        const queue = `${request.handler.environmentId}/${request.handler.threadId}`;
        queues.set(queue, [...(queues.get(queue) ?? []), { id, request }]);
      }
    const started: Promise<void>[] = [];
    for (const [queue, entries] of queues) {
      if (this.busy.has(queue)) continue;
      const head = entries.toSorted((a, b) => a.request.at.localeCompare(b.request.at))[0]!;
      // A failed head keeps its place; later requests to the same thread wait behind it.
      const due = head.request.nextAttemptAt ? Date.parse(head.request.nextAttemptAt) : 0;
      if (head.request.transport === "failed" && due > this.now()) continue;
      this.busy.add(queue);
      const flight = this.deliver(head.id, head.request).finally(() => {
        this.busy.delete(queue);
        this.flights.delete(flight);
      });
      this.flights.add(flight);
      started.push(flight);
    }
    await Promise.all(started);
  }

  private async fail(id: string, request: ActionRequest, error: string): Promise<void> {
    const attempts = request.attempts + 1;
    const stalled = attempts >= MAX_ATTEMPTS;
    await this.actions.recordTransport(id, request.requestId, ["queued", "failed"], {
      transport: stalled ? "stalled" : "failed",
      attempts,
      error: error.slice(0, 600),
      nextAttemptAt: stalled
        ? null
        : new Date(this.now() + RETRY_DELAYS_MS[attempts - 1]!).toISOString(),
    });
  }

  /** Affirmative evidence that a send can start: the remote host answers, or the command exists. */
  private async reachable(environment: ThreadEnvironment): Promise<string | null> {
    if (environment.host) {
      const outcome = await run(
        [
          this.options.ssh ?? "ssh",
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          "--",
          environment.host,
          "true",
        ],
        "",
        15_000,
      );
      return outcome.code === 0
        ? null
        : `Cannot reach ${environment.host} over SSH${outcome.stderr ? `: ${outcome.stderr.trim()}` : ""}`;
    }
    return (await executable(environment.threadCommand[0]!))
      ? null
      : "The thread command is not installed on this machine";
  }

  private async deliver(id: string, queued: ActionRequest): Promise<void> {
    const handler = queued.handler as ThreadReference;
    const environment = threadEnvironment(this.config, handler.environmentId);
    if (!environment)
      return this.fail(id, queued, "The handler's environment is not configured on this hub");
    const unreachable = await this.reachable(environment);
    if (unreachable) return this.fail(id, queued, unreachable);
    const request = await this.actions.beginSend(id, queued.requestId);
    if (!request) return;
    const command = [...environment.threadCommand, "send", handler.threadId, "-", "--json"];
    const argv = environment.host
      ? [
          this.options.ssh ?? "ssh",
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          "--",
          environment.host,
          command.map(remoteWord).join(" "),
        ]
      : command;
    const outcome = await run(
      argv,
      deliveryMessage(this.config.machine, id, request),
      this.options.sendTimeoutMs ?? 30_000,
    );
    let receipt: { messageId: string; runId?: string } | undefined;
    try {
      const reply = JSON.parse(outcome.stdout) as { messageId?: unknown; runId?: unknown };
      if (outcome.code === 0 && typeof reply.messageId === "string" && reply.messageId)
        receipt = {
          messageId: reply.messageId,
          ...(typeof reply.runId === "string" ? { runId: reply.runId } : {}),
        };
    } catch {
      /* No receipt. */
    }
    // Anything but a receipt is ambiguous: the message may have arrived, so never resend it here.
    await this.actions.recordTransport(
      id,
      request.requestId,
      ["sending"],
      receipt
        ? { transport: "delivered", receipt, error: null }
        : {
            transport: "ambiguous",
            error: (outcome.timedOut
              ? "The send timed out"
              : !outcome.started
                ? "The send could not start"
                : `The send gave no receipt${outcome.stderr ? `: ${outcome.stderr.trim()}` : ""}`
            ).slice(0, 600),
          },
    );
  }
}
