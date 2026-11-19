/* eslint-disable no-await-in-loop -- Requests are deliberately serialized to observe each boundary and close servers before removing their files. */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { randomBytes } from "node:crypto";
import { startHub } from "./hub.ts";
import type { HubConfig } from "./config.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups.length = 0;
});
async function fixture(extra: Partial<HubConfig> = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "hub-test-"));
  const token = randomBytes(32).toString("hex"),
    secret = randomBytes(32).toString("hex");
  const tokenFile = join(root, "token"),
    peerCredentialFile = join(root, "peer-secret");
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(peerCredentialFile, secret, { mode: 0o600 });
  const hub = await startHub({
    machine: "workstation",
    hubId: "hub-example",
    port: 0,
    dataRoot: join(root, "dashboards"),
    tokenFile,
    peerCredentialFile,
    dashboardDomain: "hub.localhost",
    viewingOrigin: "http://hub.localhost:0",
    ...extra,
  });
  cleanups.push(() => rm(root, { recursive: true, force: true }), hub.close);
  return { ...hub, token, secret, root, peerCredentialFile };
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
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    text: string;
    value: () => any;
  }>((resolve, reject) => {
    const req = request(
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
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            text,
            value: () => JSON.parse(text),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}
const pageHost = (h: Hub, key = "example--workstation") => `${key}.hub.localhost:${h.port}`;
const pageOrigin = (h: Hub, key = "example--workstation") => `http://${pageHost(h, key)}`;
async function create(hub: Hub, extra: Record<string, unknown> = {}) {
  await hub.store.create({ id: "example", title: "Example", ...extra });
  await hub.store.publish("example", {
    "index.html": Buffer.from("<h1>Example</h1>").toString("base64"),
    "details.html": Buffer.from("details").toString("base64"),
  });
}
function write(hub: Hub, path: string, payload: unknown, headers: Record<string, string> = {}) {
  return send(hub, `/api/write/${path}`, {
    method: "POST",
    host: `127.0.0.1:${hub.port}`,
    body: payload,
    headers: {
      authorization: `Bearer ${hub.token}`,
      "content-type": "application/json",
      "x-dopamine-writer": "environment/thread",
      ...headers,
    },
  });
}

describe("hub HTTP boundaries", () => {
  it("serves health and index only on validated control hosts", async () => {
    const hub = await fixture();
    expect((await send(hub, "/healthz")).value()).toMatchObject({
      machine: "workstation",
      hubId: "hub-example",
      schema: 2,
    });
    expect((await send(hub, "/", { host: `attacker.invalid:${hub.port}` })).status).toBe(403);
    expect((await send(hub, "/")).headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect((await send(hub, "/api/index")).headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("accepts authenticated direct CLI writes and refuses tokens on every browser or forwarded route", async () => {
    const hub = await fixture();
    expect((await write(hub, "create", { id: "example", title: "Example" })).status).toBe(201);
    expect(
      (await write(hub, "example/post", { collection: "rows", key: "one", value: 1 })).status,
    ).toBe(200);
    for (const options of [
      { host: new URL(hub.config.viewingOrigin).host },
      { host: pageHost(hub) },
      { host: `127.0.0.1:${hub.port}`, headers: { authorization: "" } },
      { host: `127.0.0.1:${hub.port}`, headers: { forwarded: "for=example" } },
      { host: `127.0.0.1:${hub.port}`, headers: { origin: hub.config.viewingOrigin } },
    ]) {
      const result = await send(hub, "/api/write/example/post", {
        method: "POST",
        body: { collection: "rows", key: "bad", value: 2 },
        ...options,
        headers: {
          authorization: `Bearer ${hub.token}`,
          "content-type": "application/json",
          "x-dopamine-writer": "environment/thread",
          ...options.headers,
        },
      });
      expect(result.status).not.toBe(200);
    }
    expect((await hub.store.get("example")).data.collections.rows!.order).toEqual(["one"]);
  });
  it("serves only its selected dashboard, with ETags and no navigation redirect for data/files/API", async () => {
    const hub = await fixture();
    await create(hub);
    const first = await send(hub, "/data.json", { host: pageHost(hub) });
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeDefined();
    expect(
      (
        await send(hub, "/data.json", {
          host: pageHost(hub),
          headers: { "if-none-match": String(first.headers.etag) },
        })
      ).status,
    ).toBe(304);
    expect((await send(hub, "/", { host: pageHost(hub) })).status).toBe(200);
    for (const path of [
      "/api/list",
      "/api/index",
      "/api/write/example/post",
      "/api/confirm/anything",
      "/%2e%2e/data.json",
      "/api/%2e%2e/list",
    ]) {
      expect((await send(hub, path, { host: pageHost(hub) })).status).toBeGreaterThanOrEqual(400);
    }
    const second = await send(hub, "/data.json?key=other--worker", { host: pageHost(hub) });
    expect(second.value()).toEqual(first.value());
  });
  it("redirects document loads to the shell, preserves their view, and serves direct mode with the page policy", async () => {
    const hub = await fixture();
    await create(hub);
    const redirect = await send(hub, "/details.html?tab=two", {
      host: pageHost(hub),
      headers: { "sec-fetch-dest": "document" },
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toContain("/d/example--workstation?");
    expect(redirect.headers.location).toContain("dopamine-path=%2Fdetails.html");
    expect(redirect.headers.location).toContain("tab=two");
    for (const headers of [{}, { "sec-fetch-dest": "iframe" }, { "sec-fetch-dest": "script" }])
      expect((await send(hub, "/details.html", { host: pageHost(hub), headers })).status).toBe(200);
    const direct = await send(hub, "/details.html?dopamine-direct=1", {
      host: pageHost(hub),
      headers: { "sec-fetch-dest": "document" },
    });
    expect(direct.status).toBe(200);
    expect(direct.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(direct.headers["content-security-policy"]).toContain(
      `frame-ancestors ${hub.config.viewingOrigin}`,
    );
    const data = await send(hub, "/data.json", {
      host: pageHost(hub),
      headers: { "sec-fetch-dest": "document" },
    });
    expect(data.status).toBe(200);
  });
  it("requires exact non-null Origin and JSON for saved reader state, and GET never changes it", async () => {
    const hub = await fixture();
    await create(hub);
    for (const origin of [
      undefined,
      "null",
      hub.config.viewingOrigin,
      pageOrigin(hub, "other--workstation"),
    ]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (origin) headers.origin = origin;
      expect(
        (
          await send(hub, "/api/view", {
            method: "PUT",
            host: pageHost(hub),
            headers,
            body: { open: ["example"] },
          })
        ).status,
      ).toBe(403);
    }
    expect(await hub.store.getView("example")).toEqual({});
    const result = await send(hub, "/api/view", {
      method: "PUT",
      host: pageHost(hub),
      headers: { origin: pageOrigin(hub), "content-type": "application/json" },
      body: { open: ["example"], scrollY: 42 },
    });
    expect(result.status).toBe(200);
    expect((await send(hub, "/api/view", { host: pageHost(hub) })).value()).toEqual({
      open: ["example"],
      scrollY: 42,
    });
    expect((await send(hub, "/api/view?open=bad", { host: pageHost(hub) })).value()).toEqual({
      open: ["example"],
      scrollY: 42,
    });
    expect(
      (
        await send(hub, "/api/view", {
          method: "PUT",
          host: pageHost(hub),
          headers: { origin: pageOrigin(hub), "content-type": "text/plain" },
          body: {},
        })
      ).status,
    ).toBe(415);
  });
  it("serves attachments as sandboxed text and refuses framing the shell", async () => {
    const hub = await fixture();
    await create(hub);
    await hub.store.attach(
      "example",
      "note.html",
      Buffer.from("<script>bad()</script>").toString("base64"),
    );
    const result = await send(hub, "/files/note.html", {
      host: pageHost(hub),
      headers: { "sec-fetch-dest": "document" },
    });
    expect(result.status).toBe(200);
    expect(result.headers["content-security-policy"]).toBe("sandbox");
    expect(result.headers["content-type"]).toContain("text/plain");
    const shell = await send(hub, "/d/example--workstation?tab=one");
    expect(shell.text).toContain('sandbox="allow-scripts allow-same-origin');
    expect(shell.text).not.toContain("allow-top-navigation");
    expect(shell.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
  it("validates declared questions over HTTP while accepting arbitrary generic JSON", async () => {
    const hub = await fixture();
    await create(hub, { collections: { questions: { type: "questions" } } });
    expect(
      (await write(hub, "example/post", { collection: "questions", key: "q", value: {} })).status,
    ).toBe(400);
    expect(
      (
        await write(hub, "example/post", {
          collection: "questions",
          key: "q",
          value: { title: "Choose", options: [{ label: "Proceed" }] },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await write(hub, "example/post", {
          collection: "generic",
          key: "x",
          value: [null, 1, true],
        })
      ).status,
    ).toBe(200);
    expect(
      (await send(hub, "/api/index")).value().dashboards[0].data.collections.questions.items.q.value
        .status,
    ).toBe("open");
  });
  it("exposes the dashboard owner's scoped link in both the index and shell", async () => {
    const hub = await fixture();
    await create(hub, {
      owner: { environmentId: "owner-environment", threadId: "mcp:launch:example" },
      handler: { environmentId: "handler-environment", threadId: "other" },
    });
    await hub.store.create({ id: "unowned", title: "Unowned" });
    const href = "t3-thread://v2/owner-environment/mcp%3Alaunch%3Aexample";
    expect((await send(hub, "/api/shell/example--workstation")).value().ownerThreadUrl).toBe(href);
    expect((await send(hub, "/api/index")).value().dashboards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "example--workstation", ownerThreadUrl: href }),
        expect.objectContaining({ key: "unowned--workstation", ownerThreadUrl: null }),
      ]),
    );
  });
});

async function website(deny: boolean, options: { redirect?: boolean; ancestors?: string } = {}) {
  const server = createServer((req, res) => {
    if (options.redirect && req.url === "/") {
      res.writeHead(302, { location: "/app" });
      res.end();
      return;
    }
    if (deny) res.setHeader("x-frame-options", "DENY");
    if (options.ancestors)
      res.setHeader("content-security-policy", `frame-ancestors ${options.ancestors}`);
    res.end("Example server");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No website address");
  const close = () =>
    new Promise<void>((resolve) => {
      if (server.listening) server.close(() => resolve());
      else resolve();
    });
  cleanups.push(close);
  return { origin: `http://website.localhost:${address.port}`, close };
}

describe("local URL dashboard overrides", () => {
  it("checks the framing policy of the document reached by a same-origin redirect", async () => {
    const source = await website(true, { redirect: true });
    const hub = await fixture();
    await hub.store.create({ id: "example", title: "Example", kind: "url", url: source.origin });
    expect((await send(hub, "/api/shell/example--workstation")).value()).toMatchObject({
      manifest: { url: source.origin },
      status: "reachable",
      frameAllowed: false,
    });
  });

  it.each([
    ["http:", true],
    ["http://*.localhost:*", true],
    ["http://other.localhost", false],
    ["'none'", false],
  ])(
    "respects CSP framing policy %s when it accompanies X-Frame-Options",
    async (ancestors, frameAllowed) => {
      const source = await website(true, { ancestors });
      const hub = await fixture();
      await hub.store.create({ id: "example", title: "Example", kind: "url", url: source.origin });
      expect((await send(hub, "/api/shell/example--workstation")).value().frameAllowed).toBe(
        frameAllowed,
      );
    },
  );

  it("returns the probed viewing-side address without changing the stored registration", async () => {
    const source = await website(false),
      viewing = await website(true);
    const hub = await fixture({ urlOverrides: { "example--workstation": viewing.origin } });
    await hub.store.create({ id: "example", title: "Example", kind: "url", url: source.origin });
    const listing = (await send(hub, "/api/list")).value().dashboards[0];
    expect(listing).toMatchObject({
      manifest: { url: viewing.origin },
      status: "reachable",
      frameAllowed: false,
    });
    expect((await send(hub, "/api/shell/example--workstation")).value().manifest.url).toBe(
      viewing.origin,
    );
    expect((await hub.store.get("example")).manifest.url).toBe(source.origin);
  });
});

describe("authenticated peer routing", () => {
  it("keeps duplicate local IDs separate, forwards views, discards supplied headers and fails closed when the peer is down", async () => {
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
    await create(hub);
    await create(peer);
    await peer.store.post("example", "rows", "peer", { value: "remote" }, "env/thread");
    expect(
      (await send(hub, "/api/index"))
        .value()
        .dashboards.map((d: { key: string }) => d.key)
        .toSorted(),
    ).toEqual(["example--worker", "example--workstation"]);
    const remoteHost = pageHost(hub, "example--worker"),
      remoteOrigin = pageOrigin(hub, "example--worker");
    const result = await send(hub, "/data.json", {
      host: remoteHost,
      headers: { "x-dopamine-key": "example--workstation", "x-dopamine-peer": "forged" },
    });
    // Incoming forwarding keys cannot override the validated browser Host.
    expect(result.status).toBe(200);
    expect(result.value().collections.rows.items.peer.value).toBe("remote");
    const data = await send(hub, "/data.json", {
      host: remoteHost,
      headers: { forwarded: "for=attacker", "x-forwarded-host": "attacker.invalid" },
    });
    expect(data.value().collections.rows.items.peer.value).toBe("remote");
    expect(
      (
        await send(hub, "/api/view", {
          method: "PUT",
          host: remoteHost,
          headers: { origin: remoteOrigin, "content-type": "application/json" },
          body: { open: ["q"] },
        })
      ).status,
    ).toBe(200);
    expect(await peer.store.getView("example")).toEqual({ open: ["q"] });
    expect(
      (
        await send(hub, "/data.json", {
          host: remoteHost,
          headers: { origin: hub.config.viewingOrigin },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(peer, "/data.json", {
          host: `127.0.0.1:${peer.port}`,
          headers: { "x-dopamine-key": "example--worker" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(hub, "/api/write/example/post", {
          method: "POST",
          host: remoteHost,
          headers: { origin: remoteOrigin, "content-type": "application/json" },
          body: {},
        })
      ).status,
    ).toBe(404);
    await peer.close();
    cleanups.splice(cleanups.indexOf(peer.close), 1);
    const index = (await send(hub, "/api/index")).value();
    expect(index.peer.reachable).toBe(false);
    expect(index.dashboards).toHaveLength(1);
    expect((await send(hub, "/data.json", { host: remoteHost })).status).toBe(503);
  });
  it("refuses network-path and absolute targets without sending the peer credential away", async () => {
    let contacted = false;
    const receiver = createServer((_req, res) => {
      contacted = true;
      res.end("unexpected");
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => receiver.close(() => resolve())));
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("Missing receiver address");
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
    await create(peer);
    for (const target of [
      `//127.0.0.1:${address.port}/`,
      `http://127.0.0.1:${address.port}/`,
      `/%2f127.0.0.1:${address.port}/`,
    ])
      expect((await send(hub, target, { host: pageHost(hub, "example--worker") })).status).toBe(
        400,
      );
    expect(contacted).toBe(false);
  });
  it("redirects remote document navigations before proxying, keeping direct, data and frame loads intact", async () => {
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
    await create(peer);
    const host = pageHost(hub, "example--worker");
    const result = await send(hub, "/details.html?tab=two", {
      host,
      headers: { "sec-fetch-dest": "document" },
    });
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(
      `${hub.config.viewingOrigin}/d/example--worker?dopamine-path=%2Fdetails.html&tab=two`,
    );
    expect(
      (
        await send(hub, "/details.html?dopamine-direct=1", {
          host,
          headers: { "sec-fetch-dest": "document" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await send(hub, "/details.html", { host, headers: { "sec-fetch-dest": "iframe" } })).status,
    ).toBe(200);
    expect(
      (await send(hub, "/data.json", { host, headers: { "sec-fetch-dest": "document" } })).status,
    ).toBe(200);
  });
  it("probes remote URL dashboards from the viewing side after applying their URL override", async () => {
    const source = await website(false),
      viewing = await website(true);
    const peer = await fixture({ machine: "worker", hubId: "peer-hub" });
    const hub = await fixture({
      peer: {
        machine: "worker",
        hubId: "peer-hub",
        origin: `http://127.0.0.1:${peer.port}`,
        host: `127.0.0.1:${peer.port}`,
      },
      peerCredentialFile: peer.peerCredentialFile,
      urlOverrides: { "example--worker": viewing.origin },
    });
    peer.config.viewingOrigin = hub.config.viewingOrigin;
    await peer.store.create({
      id: "example",
      title: "Existing server",
      kind: "url",
      url: source.origin,
    });
    const index = (await send(hub, "/api/index")).value();
    expect(index.peer.reachable).toBe(true);
    expect(index.dashboards[0]).toMatchObject({
      status: "reachable",
      frameAllowed: false,
      manifest: { url: viewing.origin },
    });
    await viewing.close();
    const down = (await send(hub, "/api/index")).value();
    expect(down.peer.reachable).toBe(true);
    expect(down.dashboards[0].status).toBe("unreachable");
    expect(down.dashboards[0].frameAllowed).toBe(true);
    expect(
      (await send(peer, "/api/list", { host: `127.0.0.1:${peer.port}` })).value().dashboards[0]
        .status,
    ).toBe("reachable");
  });
  it("uses the peer's loopback Host across a transport endpoint on a different port", async () => {
    const peer = await fixture({ machine: "worker", hubId: "peer-hub" });
    const transport = createServer((incoming, outgoing) => {
      const forward = request(
        {
          hostname: "127.0.0.1",
          port: peer.port,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (reply) => {
          outgoing.writeHead(reply.statusCode!, reply.headers);
          reply.pipe(outgoing);
        },
      );
      forward.on("error", () => outgoing.writeHead(502).end());
      incoming.pipe(forward);
    });
    await new Promise<void>((resolve) => transport.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          transport.closeAllConnections();
          transport.close(() => resolve());
        }),
    );
    const address = transport.address();
    if (!address || typeof address === "string") throw new Error("No transport address");
    const hub = await fixture({
      peer: {
        machine: "worker",
        hubId: "peer-hub",
        origin: `http://127.0.0.1:${address.port}`,
        host: `127.0.0.1:${peer.port}`,
      },
      peerCredentialFile: peer.peerCredentialFile,
    });
    peer.config.viewingOrigin = hub.config.viewingOrigin;
    await create(peer);
    await peer.store.post(
      "example",
      "rows",
      "remote",
      { value: "Through transport" },
      "environment/thread",
    );
    expect((await send(hub, "/api/index")).value().peer.reachable).toBe(true);
    expect(
      (await send(hub, "/data.json", { host: pageHost(hub, "example--worker") })).value()
        .collections.rows.items.remote.value,
    ).toBe("Through transport");
  });
  it("rejects a stray service whose reported peer identity differs", async () => {
    const peer = await fixture({ machine: "worker" });
    const hub = await fixture({
      peer: {
        machine: "worker",
        hubId: "wrong",
        origin: `http://127.0.0.1:${peer.port}`,
        host: `127.0.0.1:${peer.port}`,
      },
    });
    expect((await send(hub, "/api/index")).value().peer.reachable).toBe(false);
  });
});
