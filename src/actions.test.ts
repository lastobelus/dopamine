/* eslint-disable no-await-in-loop -- Each step observes the state the previous one left. */
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { startHub } from "./hub.ts";
import { runDash } from "./client.ts";
import type { HubConfig } from "./config.ts";
import type { DeliveryOptions } from "./delivery.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups.length = 0;
});

const ENVIRONMENT = "environment";
const HANDLER = { environmentId: ENVIRONMENT, threadId: "handler" };
const HANDLER_ID = `${ENVIRONMENT}/handler`;

/**
 * A fake thread CLI and a fake SSH. The CLI logs each call and behaves as `mode.json` says:
 * ok, fail (exit 1 after reading the message), garbage, hang, or block (until `release` exists).
 * The fake SSH answers `true` as `ssh.json` says and runs any other command locally.
 */
async function fakes(directory: string) {
  const cli = join(directory, "thread-cli.mjs");
  await writeFile(
    cli,
    `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const here = ${JSON.stringify(directory)};
const args = process.argv.slice(2);
if (args[0] === "read") {
  if (existsSync(here + "/broken-" + args[1])) process.exit(1);
  if (existsSync(here + "/missing-" + args[1])) {
    process.stdout.write(JSON.stringify({ kind: "not-found", identifier: args[1] }));
    process.exit(0);
  }
  const archived = existsSync(here + "/archived-" + args[1]);
  process.stdout.write(JSON.stringify({ thread: { archived } }));
  process.exit(0);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
appendFileSync(here + "/calls.jsonl", JSON.stringify({ args, input }) + "\\n");
const { mode } = JSON.parse(readFileSync(here + "/mode.json", "utf8"));
if (mode === "fail") { process.stderr.write("dispatch failed"); process.exit(1); }
if (mode === "garbage") { process.stdout.write("not json"); process.exit(0); }
if (mode === "hang") setInterval(() => {}, 1000);
if (mode === "hang") await new Promise(() => {});
if (mode === "block") while (!existsSync(here + "/release")) await new Promise((r) => setTimeout(r, 20));
process.stdout.write(JSON.stringify({ kind: "accepted", environmentId: "${ENVIRONMENT}", threadId: args[1], messageId: "message-" + Date.now() }));
`,
  );
  const ssh = join(directory, "ssh");
  await writeFile(
    ssh,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const here = ${JSON.stringify(directory)};
const command = process.argv.at(-1);
appendFileSync(here + "/ssh.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
const { up } = JSON.parse(readFileSync(here + "/ssh.json", "utf8"));
if (!up) { process.stderr.write("ssh: connect to host: Connection refused"); process.exit(255); }
if (command === "true") process.exit(0);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const result = spawnSync("/bin/sh", ["-c", command], { input, encoding: "utf8" });
process.stdout.write(result.stdout); process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
  );
  await chmod(ssh, 0o755);
  await writeFile(join(directory, "mode.json"), '{"mode":"ok"}');
  await writeFile(join(directory, "ssh.json"), '{"up":true}');
  return {
    command: [process.execPath, cli],
    ssh,
    mode: (mode: string) => writeFile(join(directory, "mode.json"), JSON.stringify({ mode })),
    sshUp: (up: boolean) => writeFile(join(directory, "ssh.json"), JSON.stringify({ up })),
    archive: (threadId: string, state = "archived") =>
      writeFile(join(directory, `${state}-${threadId}`), ""),
    release: () => writeFile(join(directory, "release"), ""),
    async calls(): Promise<{ args: string[]; input: string }[]> {
      try {
        return (await readFile(join(directory, "calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { args: string[]; input: string });
      } catch {
        return [];
      }
    },
  };
}

let clock = Date.parse("2026-11-20T20:00:00Z");

async function fixture(
  extra: Partial<HubConfig> | ((command: string[]) => Partial<HubConfig>) = {},
  options: DeliveryOptions = {},
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "actions-test-"));
  const fake = await fakes(root);
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(root, "token"),
    peerCredentialFile = join(root, "peer-secret");
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(peerCredentialFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const config: HubConfig = {
    machine: "workstation",
    hubId: "hub-example",
    port: 0,
    dataRoot: join(root, "dashboards"),
    tokenFile,
    peerCredentialFile,
    dashboardDomain: "hub.localhost",
    viewingOrigin: "http://hub.localhost:0",
    adapter: { home: root, environmentId: ENVIRONMENT, threadCommand: fake.command },
    ...(typeof extra === "function" ? extra(fake.command) : extra),
  };
  const start = (more: DeliveryOptions = {}) =>
    startHub(config, {
      manual: true,
      now: () => clock,
      ssh: fake.ssh,
      sendTimeoutMs: 5000,
      ...options,
      ...more,
    });
  const hub = await start();
  cleanups.push(() => rm(root, { recursive: true, force: true }), hub.close);
  return { ...hub, token, root, fake, start, peerCredentialFile };
}
type Hub = Awaited<ReturnType<typeof fixture>>;

function send(
  hub: Hub,
  path: string,
  options: {
    method?: string;
    host?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
) {
  return new Promise<{ status: number; value: () => any }>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: hub.port,
        path,
        method: options.method ?? "GET",
        headers: {
          host: options.host ?? new URL(hub.config.viewingOrigin).host,
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode!, value: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    req.end(
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body),
    );
  });
}

const KEY = "example--workstation";
const pageHost = (hub: Hub, key = KEY) => `${key}.hub.localhost:${hub.port}`;
const pageOrigin = (hub: Hub, key = KEY) => `http://${pageHost(hub, key)}`;

function page(
  hub: Hub,
  path: string,
  body?: unknown,
  key = KEY,
  headers: Record<string, string> = {},
) {
  return send(hub, path, {
    method: body === undefined ? "GET" : "POST",
    host: pageHost(hub, key),
    headers: {
      ...(body === undefined
        ? {}
        : { origin: pageOrigin(hub, key), "content-type": "application/json" }),
      ...headers,
    },
    body,
  });
}

function write(hub: Hub, path: string, body: unknown, writer = HANDLER_ID) {
  return send(hub, `/api/write/${path}`, {
    method: "POST",
    host: `127.0.0.1:${hub.port}`,
    body,
    headers: {
      authorization: `Bearer ${hub.token}`,
      "content-type": "application/json",
      "x-dopamine-writer": writer,
    },
  });
}

const DECIDE = {
  name: "decide",
  label: "Decide",
  collections: ["needs"],
  scope: "item",
  confirm: false,
  oncePerItem: false,
  maxPayloadBytes: 256,
};

async function board(
  hub: Hub,
  actions: Record<string, unknown>[] = [DECIDE],
  handler: unknown = HANDLER,
) {
  await hub.store.create({
    id: "example",
    title: "Example",
    handler,
    collections: { needs: { type: "questions" } },
    actions,
  });
  await hub.store.post(
    "example",
    "needs",
    "q1",
    { value: { title: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] } },
    "environment/owner",
  );
  return (await hub.store.get("example")).data.collections.needs!.items.q1!.rev;
}

let clicks = 0;
function click(itemRev: number, extra: Record<string, unknown> = {}) {
  return {
    clickId: `click-${++clicks}-${randomBytes(4).toString("hex")}`,
    action: "decide",
    target: { collection: "needs", key: "q1", itemRev },
    payload: { answer: "Yes" },
    ...extra,
  };
}

async function states(hub: Hub, key = KEY) {
  return (await page(hub, "/api/actions", undefined, key)).value().requests as {
    requestId: string;
    state: string;
    attempts: number;
    mayBeDelivered: boolean;
    nextAttemptAt?: string;
    result?: { label: string; href?: string };
  }[];
}

describe("accepting a click", () => {
  it("delivers to the handler thread, which claims once and acknowledges with a result", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    const accepted = await page(hub, "/api/act", click(rev));
    expect(accepted.status).toBe(202);
    const { requestId } = accepted.value().request;
    expect(accepted.value().request.state).toBe("queued");
    await hub.delivery.runOnce();
    const [call] = await hub.fake.calls();
    expect(call!.args).toEqual(["send", "handler", "-", "--json"]);
    expect(call!.input).toContain(`[dashboard action] `);
    expect(call!.input).toContain(`dash action claim workstation/example ${requestId}`);
    expect((await states(hub))[0]).toMatchObject({ requestId, state: "delivered", attempts: 1 });
    expect(
      (await write(hub, "example/action/claim", { requestId }, "environment/other")).status,
    ).toBe(403);
    const claimed = await write(hub, "example/action/claim", { requestId });
    expect(claimed.status).toBe(200);
    expect(claimed.value()).toMatchObject({
      action: "decide",
      payload: { answer: "Yes" },
      snapshot: { rev, value: { title: "Ship it?" } },
    });
    expect((await write(hub, "example/action/claim", { requestId })).status).toBe(409);
    const ack = { status: "done", result: { label: "Shipped", href: "https://example.com/pr/1" } };
    expect((await write(hub, "example/action/ack", { requestId, ...ack })).status).toBe(200);
    expect((await write(hub, "example/action/ack", { requestId, ...ack })).status).toBe(409);
    expect((await states(hub))[0]).toMatchObject({ state: "done", result: ack.result });
    await hub.delivery.runOnce();
    expect(await hub.fake.calls()).toHaveLength(1);
  });

  it("returns the original request for a resubmitted click, even after the item changed", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    const first = click(rev);
    const [one, two] = await Promise.all([
      page(hub, "/api/act", first),
      page(hub, "/api/act", first),
    ]);
    expect([one.status, two.status].toSorted()).toEqual([200, 202]);
    expect(one.value().request.requestId).toBe(two.value().request.requestId);
    // The 202 was lost and the item changed meanwhile; the same click is still the same request.
    await hub.store.post(
      "example",
      "needs",
      "q1",
      { value: { title: "Ship it now?", options: [{ label: "Yes" }] } },
      "env/owner",
    );
    const again = await page(hub, "/api/act", first);
    expect(again.status).toBe(200);
    expect(again.value().request.requestId).toBe(one.value().request.requestId);
    expect((await page(hub, "/api/act", { ...first, payload: { answer: "No" } })).status).toBe(409);
    expect(await states(hub)).toHaveLength(1);
    // A new click on the old revision is refused.
    const stale = await page(hub, "/api/act", click(rev));
    expect(stale.status).toBe(409);
    expect(stale.value().error).toBe("This changed; look again");
  });

  it("refuses bad origins, forms, oversized bodies and payloads, unknown answers and stale collections", async () => {
    const collectionAction = { ...DECIDE, name: "sort", scope: "collection", maxPayloadBytes: 8 };
    const hub = await fixture();
    const rev = await board(hub, [DECIDE, collectionAction]);
    const body = click(rev);
    expect(
      (await page(hub, "/api/act", body, KEY, { origin: hub.config.viewingOrigin })).status,
    ).toBe(403);
    expect((await page(hub, "/api/act", body, KEY, { origin: "null" })).status).toBe(403);
    expect(
      (
        await page(hub, "/api/act", body, KEY, {
          "content-type": "application/x-www-form-urlencoded",
        })
      ).status,
    ).toBe(415);
    expect((await page(hub, "/api/act", { ...body, payload: "x".repeat(40_000) })).status).toBe(
      413,
    );
    expect(
      (await page(hub, "/api/act", click(rev, { payload: { answer: "x".repeat(300) } }))).status,
    ).toBe(413);
    expect((await page(hub, "/api/act", click(rev, { payload: { answer: "Maybe" } }))).status).toBe(
      400,
    );
    const collectionRev = (await hub.store.get("example")).data.collections.needs!.rev;
    const sort = (target: unknown, payload: unknown = null) =>
      page(hub, "/api/act", {
        clickId: `sort-${randomBytes(6).toString("hex")}`,
        action: "sort",
        target,
        payload,
      });
    expect((await sort({ collection: "needs", collectionRev: collectionRev - 1 })).status).toBe(
      409,
    );
    expect((await sort({ collection: "needs", collectionRev }, "123456789")).status).toBe(413);
    expect((await sort({ collection: "needs", collectionRev })).status).toBe(202);
    expect((await page(hub, "/api/act", click(rev, { action: "missing" }))).status).toBe(400);
    expect(await states(hub)).toHaveLength(1);
  });

  it("asks before sending a once-per-item action again", async () => {
    const hub = await fixture();
    const rev = await board(hub, [{ ...DECIDE, oncePerItem: true }]);
    expect((await page(hub, "/api/act", click(rev))).status).toBe(202);
    const duplicate = await page(hub, "/api/act", click(rev));
    expect(duplicate.status).toBe(409);
    expect(duplicate.value().duplicateOf).toMatch(/^r-/);
    expect((await page(hub, "/api/act", click(rev, { confirmDuplicate: true }))).status).toBe(202);
  });

  it("refuses a click for an archived handler and accepts it after reassignment", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    await hub.fake.archive("handler");
    const refused = await page(hub, "/api/act", click(rev));
    expect(refused.status).toBe(409);
    expect(refused.value().error).toBe("The handler thread is unavailable");
    await hub.store.updateManifest("example", {
      handler: { environmentId: ENVIRONMENT, threadId: "next" },
    });
    expect((await page(hub, "/api/act", click(rev))).status).toBe(202);
  });

  it.each(["missing", "broken"])(
    "refuses a click when the handler thread reads as %s",
    async (state) => {
      const hub = await fixture();
      const rev = await board(hub);
      await hub.fake.archive("handler", state);
      expect((await page(hub, "/api/act", click(rev))).status).toBe(409);
      expect(await states(hub)).toHaveLength(0);
    },
  );

  it("treats an omitted payload and a null one as different clicks", async () => {
    const hub = await fixture();
    const rev = await board(hub, [{ ...DECIDE, collections: ["needs"] }]);
    const { payload: _payload, ...first } = click(rev);
    expect((await page(hub, "/api/act", first)).status).toBe(202);
    expect((await page(hub, "/api/act", { ...first, payload: null })).status).toBe(409);
  });

  it("hides a question from Needs you only for an answer to its current revision", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    const pending = async () =>
      (await send(hub, "/api/index")).value().dashboards[0].pendingAnswers;
    await page(hub, "/api/act", click(rev, { payload: null }));
    expect(await pending()).toEqual([]);
    await page(hub, "/api/act", click(rev));
    expect(await pending()).toEqual([{ collection: "needs", key: "q1" }]);
    await hub.store.post(
      "example",
      "needs",
      "q1",
      { value: { title: "Ship it now?", options: [{ label: "Yes" }] } },
      "env/owner",
    );
    expect(await pending()).toEqual([]);
  });
});

describe("delivering", () => {
  it("retries only after a failed reachability check, on schedule, and stalls after five", async () => {
    const hub = await fixture((threadCommand) => ({
      threadEnvironments: { remote: { host: "worker-host", threadCommand } },
    }));
    const rev = await board(hub, [DECIDE], { environmentId: "remote", threadId: "far" });
    await hub.fake.sshUp(false);
    // The handler's machine is unreachable, so the click is accepted and waits for delivery.
    expect((await page(hub, "/api/act", click(rev))).status).toBe(202);
    const delays = [1, 5, 15, 60];
    for (const [index, minutes] of delays.entries()) {
      await hub.delivery.runOnce();
      const [request] = await states(hub);
      expect(request).toMatchObject({
        state: "failed",
        attempts: index + 1,
        mayBeDelivered: false,
      });
      expect(Date.parse(request!.nextAttemptAt!) - clock).toBe(minutes * 60_000);
      await hub.delivery.runOnce();
      expect((await states(hub))[0]!.attempts).toBe(index + 1);
      clock += minutes * 60_000;
    }
    await hub.delivery.runOnce();
    expect((await states(hub))[0]).toMatchObject({
      state: "stalled",
      attempts: 5,
      mayBeDelivered: false,
    });
    expect(await hub.fake.calls()).toHaveLength(0);
    // Retry starts a fresh budget, and the send goes through SSH to the remote thread CLI.
    await hub.fake.sshUp(true);
    const { requestId } = (await states(hub))[0]!;
    expect((await page(hub, "/api/request", { requestId, choice: "retry" })).status).toBe(200);
    await hub.delivery.runOnce();
    expect((await states(hub))[0]).toMatchObject({ state: "delivered", attempts: 1 });
    expect((await hub.fake.calls())[0]!.args).toEqual(["send", "far", "-", "--json"]);
  });

  it("never resends an ambiguous send automatically; Retry resends it and one claim wins", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    await hub.fake.mode("fail");
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    await hub.delivery.runOnce();
    expect((await states(hub))[0]).toMatchObject({ state: "ambiguous", mayBeDelivered: true });
    clock += 2 * 60 * 60_000;
    await hub.delivery.runOnce();
    expect(await hub.fake.calls()).toHaveLength(1);
    await hub.fake.mode("ok");
    await page(hub, "/api/request", { requestId, choice: "retry" });
    await hub.delivery.runOnce();
    const calls = await hub.fake.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toContain(requestId);
    // The first message arrives late; both copies name the same request, so only one claim works.
    expect((await write(hub, "example/action/claim", { requestId })).status).toBe(200);
    expect((await write(hub, "example/action/claim", { requestId })).status).toBe(409);
    expect((await page(hub, "/api/request", { requestId, choice: "retry" })).status).toBe(409);
  });

  it.each([
    ["garbage", "The send gave no receipt"],
    ["hang", "The send timed out"],
  ])("records a %s reply as ambiguous", async (mode, error) => {
    const hub = await fixture({}, { sendTimeoutMs: 300 });
    const rev = await board(hub);
    await hub.fake.mode(mode);
    await page(hub, "/api/act", click(rev));
    await hub.delivery.runOnce();
    expect((await states(hub))[0]).toMatchObject({ state: "ambiguous", mayBeDelivered: true });
    expect(
      ((await page(hub, "/api/actions", undefined)).value().requests[0].error as string).startsWith(
        error,
      ),
    ).toBe(true);
  });

  it("keeps one claim when the handler acts during a paused send and the message arrives twice", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    await hub.fake.mode("block");
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    const pass = hub.delivery.runOnce();
    while ((await hub.fake.calls()).length === 0) await new Promise((done) => setTimeout(done, 20));
    expect((await states(hub))[0]!.state).toBe("sending");
    // Removal waits for the send, even when forced.
    expect((await write(hub, "example/remove", { force: true })).status).toBe(409);
    expect((await write(hub, "example/action/claim", { requestId })).status).toBe(200);
    expect((await write(hub, "example/action/ack", { requestId, status: "done" })).status).toBe(
      200,
    );
    // Still waits once the request is done, because its send has not finished.
    expect((await write(hub, "example/remove", {})).status).toBe(409);
    await hub.fake.release();
    await pass;
    const [request] = await states(hub);
    expect(request).toMatchObject({ state: "done" });
    expect((await page(hub, "/api/request", { requestId, choice: "retry" })).status).toBe(409);
    expect((await write(hub, "example/action/claim", { requestId })).status).toBe(409);
  });

  it("marks a send with no recorded outcome ambiguous at start-up", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    await appendFile(
      join(hub.config.dataRoot, "example", "actions.jsonl"),
      `${JSON.stringify({ event: "transport", requestId, transport: "sending", at: new Date(clock).toISOString(), attempts: 1 })}\n`,
    );
    await hub.close();
    cleanups.splice(cleanups.indexOf(hub.close), 1);
    const restarted = await hub.start();
    cleanups.push(restarted.close);
    const [request] = await states({ ...hub, ...restarted });
    expect(request).toMatchObject({ state: "ambiguous", mayBeDelivered: true });
    await restarted.delivery.runOnce();
    expect(await hub.fake.calls()).toHaveLength(0);
  });

  it("shows a claim with no ack after 30 minutes as unresolved and does not run it again", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    await hub.delivery.runOnce();
    await write(hub, "example/action/claim", { requestId });
    clock += 29 * 60_000;
    expect((await states(hub))[0]!.state).toBe("claimed");
    clock += 2 * 60_000;
    expect((await states(hub))[0]!.state).toBe("unresolved");
    await hub.delivery.runOnce();
    expect(await hub.fake.calls()).toHaveLength(1);
    // The handler finds no evidence it ran and says so; the reader chooses what happens next.
    await write(hub, "example/action/ack", { requestId, status: "unknown" });
    expect((await states(hub))[0]!.state).toBe("unknown");
    const log = join(hub.config.dataRoot, "example", "actions.jsonl");
    const before = (await readFile(log, "utf8")).split("\n").length;
    const rerun = await page(hub, "/api/request", { requestId, choice: "run-again" });
    // One record both closes the old request and opens the new one, so a crash cannot split them.
    expect((await readFile(log, "utf8")).split("\n").length).toBe(before + 1);
    expect(rerun.value().request).toMatchObject({ state: "queued", rerunOf: requestId });
    const after = await states(hub);
    expect(after.find((entry) => entry.requestId === requestId)!.state).toBe("abandoned");
    await hub.delivery.runOnce();
    expect(await hub.fake.calls()).toHaveLength(2);
  });

  it("lets the handler that claimed acknowledge after the dashboard's handler is reassigned", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    await hub.delivery.runOnce();
    await write(hub, "example/action/claim", { requestId });
    await hub.store.updateManifest("example", {
      handler: { environmentId: ENVIRONMENT, threadId: "next" },
    });
    expect(
      (await write(hub, "example/action/ack", { requestId, status: "done" }, `${ENVIRONMENT}/next`))
        .status,
    ).toBe(403);
    expect((await write(hub, "example/action/ack", { requestId, status: "done" })).status).toBe(
      200,
    );
  });
});

function decide(
  hub: Hub,
  requestId: string,
  decision: string,
  headers: Record<string, string> = {},
) {
  return send(hub, `/api/confirm/${KEY}/${requestId}`, {
    method: "POST",
    headers: { origin: hub.config.viewingOrigin, "content-type": "application/json", ...headers },
    body: { decision },
  });
}

describe("confirmation in the shell", () => {
  const CONFIRMED = { ...DECIDE, confirm: true };
  it("queues a confirm action only after Confirm from the control origin", async () => {
    const hub = await fixture();
    const rev = await board(hub, [CONFIRMED]);
    const { requestId, state } = (await page(hub, "/api/act", click(rev))).value().request;
    expect(state).toBe("awaiting-confirmation");
    await hub.delivery.runOnce();
    expect(await hub.fake.calls()).toHaveLength(0);
    // An unconfirmed answer leaves the question open in Needs you.
    expect((await send(hub, "/api/index")).value().dashboards[0].pendingAnswers).toEqual([]);
    // The page's own origin cannot reach the control route, nor confirm with its Origin.
    expect(
      (await page(hub, `/api/confirm/${KEY}/${requestId}`, { decision: "confirm" })).status,
    ).toBe(405);
    expect((await decide(hub, requestId, "confirm", { origin: pageOrigin(hub) })).status).toBe(403);
    expect((await decide(hub, requestId, "confirm", { origin: "null" })).status).toBe(403);
    expect(
      (
        await decide(hub, requestId, "confirm", {
          "content-type": "application/x-www-form-urlencoded",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await send(hub, `/api/confirm/${KEY}/${requestId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: { decision: "confirm" },
        })
      ).status,
    ).toBe(403);
    const shown = (await send(hub, `/api/confirm/${KEY}/${requestId}`)).value();
    expect(shown).toMatchObject({ dashboard: { key: KEY, title: "Example" }, item: "Ship it?" });
    expect((await decide(hub, requestId, "confirm")).status).toBe(200);
    expect((await decide(hub, requestId, "confirm")).status).toBe(409);
    expect((await send(hub, "/api/index")).value().dashboards[0].pendingAnswers).toEqual([
      { collection: "needs", key: "q1" },
    ]);
    await hub.delivery.runOnce();
    expect(await hub.fake.calls()).toHaveLength(1);
  });

  it("abandons a cancelled request and leaves its question open", async () => {
    const hub = await fixture();
    const rev = await board(hub, [CONFIRMED]);
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    expect((await decide(hub, requestId, "cancel")).status).toBe(200);
    expect((await states(hub))[0]!.state).toBe("abandoned");
    expect((await send(hub, "/api/index")).value().dashboards[0].pendingAnswers).toEqual([]);
    await hub.delivery.runOnce();
    expect(await hub.fake.calls()).toHaveLength(0);
  });

  it("confirms a peer dashboard's request through the peer channel only", async () => {
    const peer = await fixture({ machine: "worker", hubId: "peer-hub" });
    const hub = await fixture({
      peer: {
        machine: "worker",
        hubId: "peer-hub",
        origin: `http://127.0.0.1:${peer.port}`,
        host: `127.0.0.1:${peer.port}`,
      },
      peerCredentialFile: peer.peerCredentialFile,
    });
    peer.config.viewingOrigin = hub.config.viewingOrigin;
    const rev = await board(peer, [CONFIRMED]);
    const remote = "example--worker";
    // The page reaches its own hub's action routes through the viewing hub's proxy.
    const accepted = await page(hub, "/api/act", click(rev), remote);
    expect(accepted.status).toBe(202);
    const { requestId } = accepted.value().request;
    expect((await page(hub, "/api/actions", undefined, remote)).value().requests).toHaveLength(1);
    const path = `/api/confirm/${remote}/${requestId}`;
    expect((await send(hub, path)).value().dashboard.machine).toBe("worker");
    // The peer's own route needs the peer credential, so a forged call is refused.
    expect(
      (
        await send(peer, `/api/peer/confirm/${remote}/${requestId}`, {
          method: "POST",
          host: `127.0.0.1:${peer.port}`,
          headers: {
            origin: hub.config.viewingOrigin,
            "content-type": "application/json",
            "x-dopamine-peer": "forged",
          },
          body: { decision: "confirm" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(hub, path, {
          method: "POST",
          headers: { origin: hub.config.viewingOrigin, "content-type": "application/json" },
          body: { decision: "confirm" },
        })
      ).status,
    ).toBe(200);
    expect((await states(peer, remote))[0]!.state).toBe("queued");
  });
});

describe("pull handlers", () => {
  it("leases a request to one consumer, offers it again after the lease, and claims once", async () => {
    const hub = await fixture();
    const rev = await board(hub, [DECIDE], { kind: "pull", name: "poller" });
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    expect(
      (await write(hub, "example/action/next", { handler: "other" })).value().request,
    ).toBeNull();
    const first = await write(hub, "example/action/next", { handler: "poller" });
    expect(first.value().request).toMatchObject({ requestId, state: "delivered" });
    expect(
      (await write(hub, "example/action/next", { handler: "poller" })).value().request,
    ).toBeNull();
    // The first consumer exits without claiming; after the lease the request is offered again.
    clock += 5 * 60_000;
    expect(
      (await write(hub, "example/action/next", { handler: "poller" })).value().request.requestId,
    ).toBe(requestId);
    expect((await write(hub, "example/action/claim", { requestId, handler: "other" })).status).toBe(
      403,
    );
    expect(
      (await write(hub, "example/action/claim", { requestId, handler: "poller" })).status,
    ).toBe(200);
    expect(
      (await write(hub, "example/action/claim", { requestId, handler: "poller" })).status,
    ).toBe(409);
    expect(
      (await write(hub, "example/action/ack", { requestId, handler: "poller", status: "done" }))
        .status,
    ).toBe(200);
    clock += 5 * 60_000;
    expect(
      (await write(hub, "example/action/next", { handler: "poller" })).value().request,
    ).toBeNull();
    await hub.delivery.runOnce();
    expect(await hub.fake.calls()).toHaveLength(0);
  });
});

describe("removal and damaged logs", () => {
  it.each(["truncated", "unterminated"])(
    "sets aside a %s final record during repair",
    async (kind) => {
      const hub = await fixture();
      const rev = await board(hub);
      const directory = join(hub.config.dataRoot, "example");
      const log = join(directory, "actions.jsonl");
      const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
      const complete = await readFile(log);
      expect((await page(hub, "/api/act", click(rev))).status).toBe(202);
      const both = await readFile(log);
      const tail =
        kind === "truncated"
          ? Buffer.concat([Buffer.from('{"event":"transport","error":"'), Buffer.from([0xe2])])
          : both.subarray(complete.length, -1);
      await writeFile(log, Buffer.concat([complete, tail]));
      const configPath = join(hub.root, "config.json");
      await writeFile(configPath, JSON.stringify(hub.config));
      expect(
        await runDash(
          ["--config", configPath, "--as", "environment/owner", "action", "repair", "example"],
          {
            env: {},
          },
        ),
      ).toBe("kept 1, set aside 1");
      const sideFiles = (await readdir(directory)).filter((name) =>
        name.startsWith("actions.tail-"),
      );
      expect(sideFiles).toHaveLength(1);
      expect(await readFile(join(directory, sideFiles[0]!))).toEqual(tail);
      expect((await readFile(log)).subarray(0, complete.length)).toEqual(complete);
      expect(await states(hub)).toEqual([
        expect.objectContaining({ requestId, state: "ambiguous" }),
      ]);
      await hub.delivery.runOnce();
      expect(await hub.fake.calls()).toHaveLength(0);
      expect((await write(hub, "example/action/repair", {})).value()).toEqual({
        kept: 2,
        setAside: 0,
      });
    },
  );

  it("leaves a clean log and its queued request intact during repair", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    const directory = join(hub.config.dataRoot, "example");
    const log = join(directory, "actions.jsonl");
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    const complete = await readFile(log);
    const files = (await readdir(directory)).toSorted();
    expect((await write(hub, "example/action/repair", {})).value()).toEqual({
      kept: 1,
      setAside: 0,
    });
    expect(await readFile(log)).toEqual(complete);
    expect((await readdir(directory)).toSorted()).toEqual(files);
    expect(await states(hub)).toEqual([expect.objectContaining({ requestId, state: "queued" })]);
  });

  it.each([
    ["missing payload", { payload: undefined }],
    ["wrong confirmation state", { confirm: true }],
    ["bad target revision", { target: { collection: "needs", key: "one", itemRev: "1" } }],
    ["bad snapshot", { snapshot: { rev: 1 } }],
    ["bad handler", { handler: { kind: "pull", name: 1 } }],
    ["injected reduced state", { mayBeDelivered: true }],
  ])("sets aside a request record with %s", async (_name, patch) => {
    const hub = await fixture();
    const rev = await board(hub);
    const log = join(hub.config.dataRoot, "example", "actions.jsonl");
    await page(hub, "/api/act", click(rev));
    const { request } = JSON.parse(await readFile(log, "utf8"));
    await writeFile(
      log,
      JSON.stringify({ event: "request", request: { ...request, ...patch } }) + "\n",
    );
    const shown = await write(hub, "example/action/show", {});
    expect(shown.value()).toEqual({ requests: [], damaged: true });
    expect((await page(hub, "/api/act", click(rev))).status).toBe(503);
    expect((await write(hub, "example/action/repair", {})).value()).toEqual({
      kept: 0,
      setAside: 1,
    });
    expect((await write(hub, "example/action/show", {})).value()).toEqual({
      requests: [],
      damaged: false,
    });
  });

  it("skips invalid transitions and fields before repair, including their dependent records", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    const log = join(hub.config.dataRoot, "example", "actions.jsonl");
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    const common = { requestId, at: new Date(clock).toISOString() };
    const rejected = [
      { ...common, event: "handling", handling: "claimed", by: HANDLER_ID },
      { ...common, event: "handling", handling: "done", by: HANDLER_ID },
      { ...common, event: "transport", transport: "delivered", receipt: { messageId: "skipped" } },
      { ...common, event: "transport", transport: "sending", attempts: "1" },
      { ...common, event: "transport", transport: "ambiguous", error: "Dependent on sending" },
    ]
      .map((record) => JSON.stringify(record) + "\n")
      .join("");
    await appendFile(log, rejected);
    const show = () => write(hub, "example/action/show", { requestId });
    expect((await show()).value()).toMatchObject({
      damaged: true,
      requests: [{ state: "queued", handling: "unclaimed", attempts: 0, mayBeDelivered: false }],
    });
    expect((await write(hub, "example/action/claim", { requestId })).status).toBe(503);
    await hub.delivery.runOnce();
    expect(await hub.fake.calls()).toHaveLength(0);
    expect((await write(hub, "example/action/repair", {})).value()).toEqual({
      kept: 1,
      setAside: 5,
    });
    const side = (await readdir(join(hub.config.dataRoot, "example"))).find((name) =>
      name.startsWith("actions.damaged-"),
    );
    expect(await readFile(join(hub.config.dataRoot, "example", side!), "utf8")).toBe(rejected);
    expect((await show()).value()).toMatchObject({
      damaged: false,
      requests: [{ state: "ambiguous", handling: "unclaimed", attempts: 0, mayBeDelivered: false }],
    });
    await hub.delivery.runOnce();
    expect(await hub.fake.calls()).toHaveLength(0);
  });

  it("keeps a valid claim and acknowledgement when damaged records surround them", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    const log = join(hub.config.dataRoot, "example", "actions.jsonl");
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    await hub.delivery.runOnce();
    expect((await write(hub, "example/action/claim", { requestId })).status).toBe(200);
    const ack = await write(hub, "example/action/ack", {
      requestId,
      status: "done",
      result: { label: "Handled" },
    });
    expect(ack.status).toBe(200);

    const at = new Date(clock).toISOString();
    const invalid = [
      { event: "handling", requestId, at, handling: "done", by: "other/handler" },
      { event: "handling", requestId, at, handling: "done", by: HANDLER_ID, result: { label: 1 } },
    ].map((record) => JSON.stringify(record));
    const lines = (await readFile(log, "utf8")).trimEnd().split("\n");
    const ackLine = lines.pop()!;
    const duplicateClaim = lines.at(-1)!;
    await writeFile(log, [...lines, ...invalid, ackLine, duplicateClaim, ""].join("\n"));
    const show = () => write(hub, "example/action/show", { requestId });
    expect((await show()).value()).toEqual({ requests: [ack.value()], damaged: true });
    expect((await write(hub, "example/action/repair", {})).value()).toEqual({
      kept: 5,
      setAside: 3,
    });
    expect((await show()).value()).toEqual({ requests: [ack.value()], damaged: false });
    expect((await write(hub, "example/action/claim", { requestId })).status).toBe(409);
  });

  it("refuses removal with open requests, and a forced removal makes a late claim fail", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    await hub.delivery.runOnce();
    expect((await write(hub, "example/remove", {})).status).toBe(409);
    expect(
      (
        await send(hub, "/api/remove", {
          method: "POST",
          headers: { origin: hub.config.viewingOrigin, "content-type": "application/json" },
          body: { key: KEY },
        })
      ).status,
    ).toBe(409);
    expect((await write(hub, "example/remove", { force: true })).status).toBe(200);
    const claim = await write(hub, "example/action/claim", { requestId });
    expect(claim.status).toBe(409);
    expect(claim.value().error).toBe("This request was already claimed or closed");
    const shown = await write(hub, "example/action/show", { requestId });
    expect(shown.value().requests[0].state).toBe("abandoned");
    // A new dashboard with the same ID does not hide the old copy's request.
    await board(hub);
    expect((await write(hub, "example/action/show", { requestId })).value().requests).toEqual([
      expect.objectContaining({ requestId, state: "abandoned" }),
    ]);
  });

  it("sets aside an incomplete tail and refuses a damaged log until repair", async () => {
    const hub = await fixture();
    const rev = await board(hub);
    const log = join(hub.config.dataRoot, "example", "actions.jsonl");
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    await appendFile(log, '{"event":"transport","requestId"');
    expect((await page(hub, "/api/act", click(rev))).status).toBe(202);
    expect(
      (await readdir(join(hub.config.dataRoot, "example"))).some((name) =>
        name.startsWith("actions.tail-"),
      ),
    ).toBe(true);
    const lines = (await readFile(log, "utf8")).split("\n");
    await writeFile(log, [lines[0], "not json", ...lines.slice(1)].join("\n"));
    const refused = await page(hub, "/api/act", click(rev));
    expect(refused.status).toBe(503);
    expect((await write(hub, "example/remove", { force: true })).status).toBe(409);
    expect(refused.value().error).toContain("dash action repair");
    await appendFile(log, '{"event":');
    expect((await write(hub, "example/action/repair", {})).value()).toEqual({
      kept: 2,
      setAside: 2,
    });
    const directory = join(hub.config.dataRoot, "example");
    const files = await readdir(directory);
    const damaged = files.find((name) => name.startsWith("actions.damaged-"));
    expect(await readFile(join(directory, damaged!), "utf8")).toBe("not json\n");
    // Nothing is resent automatically after a repair.
    expect((await states(hub)).map((entry) => entry.state)).toEqual(["ambiguous", "ambiguous"]);
    await hub.delivery.runOnce();
    expect(await hub.fake.calls()).toHaveLength(0);
    expect((await page(hub, "/api/request", { requestId, choice: "abandon" })).status).toBe(200);
  });
});

describe("dash action", () => {
  it("waits for work as a pull handler, claims it, acknowledges it and shows it", async () => {
    const hub = await fixture();
    const configPath = join(hub.root, "config.json");
    await writeFile(configPath, JSON.stringify(hub.config));
    const dash = (...args: string[]) =>
      runDash(["--config", configPath, "--as", "environment/owner", ...args], {
        pollMs: 20,
        env: {},
      });
    expect(await dash("create", "example", "--title", "Example", "--handler", "pull:poller")).toBe(
      `${hub.config.viewingOrigin}/d/${KEY}`,
    );
    await hub.store.updateManifest("example", {
      collections: { needs: { type: "questions" } },
      actions: [DECIDE],
    });
    await dash(
      "post",
      "example",
      "needs",
      "q1",
      "--json",
      '{"title":"Ship it?","options":[{"label":"Yes"}]}',
    );
    expect(await dash("action", "next", "example", "--handler", "poller")).toBe("No request");
    // A pull handler outside a thread harness needs no thread identity.
    expect(
      await runDash(["--config", configPath, "action", "next", "example", "--handler", "poller"], {
        env: {},
      }),
    ).toBe("No request");
    const waiting = dash("action", "next", "example", "--handler", "poller", "--wait");
    const rev = (await hub.store.get("example")).data.collections.needs!.items.q1!.rev;
    const { requestId } = (await page(hub, "/api/act", click(rev))).value().request;
    expect(JSON.parse(await waiting)).toMatchObject({ requestId, payload: { answer: "Yes" } });
    expect(
      JSON.parse(await dash("action", "claim", "example", requestId, "--handler", "poller")),
    ).toMatchObject({
      requestId,
      state: "claimed",
      snapshot: { rev, value: { title: "Ship it?" } },
    });
    expect(
      await dash(
        "action",
        "ack",
        "example",
        requestId,
        "--handler",
        "poller",
        "--result-json",
        '{"status":"done","result":{"label":"Shipped"}}',
      ),
    ).toBe("done");
    expect(JSON.parse(await dash("action", "show", "example", requestId))).toMatchObject({
      state: "done",
      result: { label: "Shipped" },
    });
    await expect(dash("action", "claim", "example", requestId)).rejects.toThrow("(403)");
    expect(await dash("action", "repair", "example")).toBe("kept 4, set aside 0");
  });
});
