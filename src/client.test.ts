import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { runDash } from "./client.ts";
import type { HubConfig } from "./config.ts";

const execute = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/dash.ts", import.meta.url));
const fixtures: Array<{ directory: string; server: Server }> = [];
interface Call {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function fixture(respond?: (req: IncomingMessage, res: ServerResponse, call: Call) => void) {
  const directory = await mkdtemp(join(tmpdir(), "dopamine-client-"));
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const call = {
        path: req.url!,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>,
      };
      calls.push(call);
      res.setHeader("content-type", "application/json");
      if (respond) {
        respond(req, res, call);
        return;
      }
      if (call.path.endsWith("/post") || call.path.endsWith("/set-collection"))
        res.end('{"schema":2,"rev":7,"collections":{}}');
      else if (call.path === "/api/list")
        res.end(
          JSON.stringify({
            dashboards: [{ manifest: { id: "board", title: "Board" }, key: "board--workstation" }],
          }),
        );
      else if (call.path.endsWith("/remove")) res.end('{"removed":true}');
      else res.end(JSON.stringify({ manifest: { id: "board", title: "Board" }, data: { rev: 0 } }));
    })().catch(() => {
      res.statusCode = 500;
      res.end('{"error":"Fixture failure"}');
    });
  });
  fixtures.push({ directory, server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no address");
  const secret = randomBytes(32).toString("hex");
  const config: HubConfig = {
    machine: "workstation",
    hubId: "fixture-hub",
    port: address.port,
    dataRoot: join(directory, "data"),
    tokenFile: join(directory, "token"),
    viewingOrigin: `http://hub.localhost:${address.port}`,
    dashboardDomain: "hub.localhost",
    adapter: { home: join(directory, "adapter"), environmentId: "environment" },
  };
  await writeFile(config.tokenFile, secret, { mode: 0o600 });
  const configPath = join(directory, "config.json");
  async function save() {
    await writeFile(configPath, JSON.stringify(config));
  }
  await save();
  const args = ["--config", configPath, "--as", "environment/thread"];
  return { directory, server, calls, config, configPath, args, secret, save };
}

async function close(server: Server) {
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (item) => {
      await close(item.server);
      await rm(item.directory, { force: true, recursive: true });
    }),
  );
});

async function fakeSsh(f: Awaited<ReturnType<typeof fixture>>) {
  const script = join(f.directory, "fake-ssh.mjs");
  const captured = join(f.directory, "ssh.json");
  const payload = join(f.directory, "ssh-input");
  const remoteConfig = join(f.directory, "worker's config.json");
  await writeFile(remoteConfig, JSON.stringify({ ...f.config, machine: "worker" }));
  await writeFile(
    script,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);
await writeFile(${JSON.stringify(captured)}, JSON.stringify(args));
await writeFile(${JSON.stringify(payload)}, input);
const child = spawn('/bin/sh', ['-c', args.at(-1)], {stdio: ['pipe', 'inherit', 'inherit']});
child.stdin.end(input);
child.on('exit', code => { process.exitCode = code ?? 1; });
`,
  );
  await chmod(script, 0o700);
  f.config.remotes = { worker: { host: "worker", dash: bin, config: remoteConfig } };
  await f.save();
  return { script, captured, payload };
}

function tarEntry(name: string, type: string, body = Buffer.from("page")): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.fill(32, 148, 156);
  header.write(type, 156, 1);
  header.write("ustar\0", 257, 6);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}

describe("dash client", () => {
  it("runs help without config and rejects phase 1b commands", async () => {
    expect(await runDash(["--help"], { env: {} })).toContain("--collections-json");
    await expect(runDash(["action", "next", "--wait"], { env: {} })).rejects.toThrow(
      "unavailable in phase 1a",
    );
    await expect(runDash(["action", "next"], { env: {} })).rejects.toThrow(
      "unavailable in phase 1a",
    );
    const { stdout, stderr } = await execute(process.execPath, [bin, "--help"], {
      env: { ...process.env, DOPAMINE_CONFIG: "" },
    });
    expect(stdout).toContain("Usage: dash");
    expect(stderr).toBe("");
  });

  it("requires configuration and refuses invented attribution", async () => {
    await expect(runDash(["list"], { env: {} })).rejects.toThrow("DOPAMINE_CONFIG");
    const f = await fixture();
    await expect(
      runDash(["--config", f.configPath, "post", "board", "queue", "one", "--json", "null"], {
        env: { T3CODE_THREAD_ID: "thread", T3CODE_HOME: join(f.directory, "other") },
      }),
    ).rejects.toThrow("Cannot resolve writer");
    expect(f.calls).toHaveLength(0);
    expect(
      await runDash(["post", "board", "queue", "one", "--json", "null"], {
        env: {
          DOPAMINE_CONFIG: f.configPath,
          T3CODE_HOME: f.config.adapter!.home,
          T3CODE_THREAD_ID: "adapter-thread",
        },
      }),
    ).toBe("7");
    expect(f.calls[0]!.headers["x-dopamine-writer"]).toBe("environment/adapter-thread");
    await expect(
      runDash(["--config", f.configPath, "--as", "bad\nwriter/thread", "remove", "board"]),
    ).rejects.toThrow("Writer must");
  });

  it("creates declared questions and dormant actions with explicit attribution", async () => {
    const f = await fixture();
    const actions = [
      {
        name: "answer",
        label: "Answer",
        collections: ["questions"],
        scope: "item",
        confirm: false,
        oncePerItem: false,
        maxPayloadBytes: 1024,
      },
    ];
    const actionsPath = join(f.directory, "actions.json");
    await writeFile(actionsPath, JSON.stringify(actions));
    expect(
      await runDash([
        ...f.args,
        "create",
        "workstation/board",
        "--title",
        "Board",
        "--owner",
        "owner/thread",
        "--handler",
        "handler/thread",
        "--collections-json",
        '{"questions":{"type":"questions"}}',
        "--actions-file",
        actionsPath,
      ]),
    ).toBe(`${f.config.viewingOrigin}/d/board--workstation`);
    expect(f.calls[0]!.body).toEqual({
      id: "board",
      title: "Board",
      kind: "page",
      owner: { environmentId: "owner", threadId: "thread" },
      handler: { environmentId: "handler", threadId: "thread" },
      collections: { questions: { type: "questions" } },
      actions,
    });
    expect(f.calls[0]!.headers.authorization).toBe(`Bearer ${f.secret}`);
    expect(f.calls[0]!.headers["content-type"]).toBe("application/json");
    expect(f.calls[0]!.headers["x-dopamine-writer"]).toBe("environment/thread");
  });

  it("publishes the repository starter after creation", async () => {
    const f = await fixture();
    await runDash([...f.args, "create", "board", "--title", "Board", "--from-starter"]);
    expect(f.calls.map((call) => call.path)).toEqual([
      "/api/write/create",
      "/api/write/board/publish",
    ]);
    const files = f.calls[1]!.body.files as Record<string, string>;
    expect(Buffer.from(files["index.html"]!, "base64").toString()).toContain("<html");
    expect(f.calls[0]!.body.owner).toEqual({ environmentId: "environment", threadId: "thread" });
  });

  it("refuses duplicate creation and reports the existing shell address", async () => {
    const f = await fixture((_req, res) => {
      res.statusCode = 409;
      res.end('{"error":"Dashboard already exists"}');
    });
    await expect(runDash([...f.args, "create", "board", "--title", "Board"])).rejects.toThrow(
      `Dashboard already exists: ${f.config.viewingOrigin}/d/board--workstation`,
    );
    expect(f.calls).toHaveLength(1);
  });

  it("posts, deletes, and replaces collections through the hub", async () => {
    const f = await fixture();
    const value = { title: "A question", options: [{ label: "Proceed" }] };
    expect(
      await runDash(
        [...f.args, "post", "board", "questions", "one", "--file", "-", "--before", "two"],
        { stdin: Readable.from([JSON.stringify(value)]) },
      ),
    ).toBe("7");
    expect(f.calls.at(-1)!.body).toEqual({
      collection: "questions",
      key: "one",
      value,
      before: "two",
    });
    await runDash([...f.args, "post", "board", "questions", "one", "--delete"]);
    expect(f.calls.at(-1)!.body).toEqual({ collection: "questions", key: "one", delete: true });
    await runDash([...f.args, "post", "board", "queue", "two", "--json", "false", "--at-end"]);
    expect(f.calls.at(-1)!.body).toEqual({
      collection: "queue",
      key: "two",
      value: false,
      atEnd: true,
    });
    expect(
      await runDash([
        ...f.args,
        "set-collection",
        "board",
        "queue",
        "--json",
        '{"order":["two"],"items":{"two":null}}',
      ]),
    ).toBe("7");
    expect(f.calls.at(-1)!.body).toEqual({
      collection: "queue",
      order: ["two"],
      items: { two: null },
    });
    await expect(
      runDash([...f.args, "post", "board", "queue", "two", "--delete", "--json", "1"]),
    ).rejects.toThrow("Delete");
    await expect(
      runDash([
        ...f.args,
        "post",
        "board",
        "queue",
        "two",
        "--json",
        "1",
        "--before",
        "one",
        "--at-end",
      ]),
    ).rejects.toThrow("Choose");
    await expect(
      runDash([...f.args, "post", "board", "queue", "two", "--json", "1", "--file", "-"]),
    ).rejects.toThrow("Choose");
  });

  it("reads without writer identity or access to a token", async () => {
    const f = await fixture();
    await rm(f.config.tokenFile);
    const args = ["--config", f.configPath];
    expect(JSON.parse(await runDash([...args, "list", "--json"], { env: {} }))).toHaveProperty(
      "dashboards",
    );
    expect(await runDash([...args, "list"], { env: {} })).toContain("workstation/board");
    expect(
      JSON.parse(await runDash([...args, "show", "workstation/board"], { env: {} })),
    ).toHaveProperty("manifest");
    expect(await runDash([...args, "url", "workstation/board"], { env: {} })).toBe(
      `${f.config.viewingOrigin}/d/board--workstation`,
    );
    expect(
      f.calls.every(
        (call) =>
          call.headers.authorization === undefined &&
          call.headers["x-dopamine-writer"] === undefined,
      ),
    ).toBe(true);
  });

  it("updates manifests, removes, and restores", async () => {
    const f = await fixture();
    await runDash([
      ...f.args,
      "update-manifest",
      "board",
      "--json",
      '{"title":"Updated"}',
      "--collections-json",
      '{"questions":{"type":"questions"}}',
      "--pinned",
      "--stale-after-minutes",
      "0",
    ]);
    expect(f.calls.at(-1)).toMatchObject({
      path: "/api/write/board/manifest",
      body: {
        title: "Updated",
        collections: { questions: { type: "questions" } },
        pinned: true,
        staleAfterMinutes: 0,
      },
    });
    expect(await runDash([...f.args, "remove", "board", "--force"])).toBe("removed");
    expect(f.calls.at(-1)).toMatchObject({
      path: "/api/write/board/remove",
      body: { force: true },
    });
    await runDash([...f.args, "restore", "board"]);
    expect(f.calls.at(-1)).toMatchObject({ path: "/api/write/board/restore", body: {} });
  });

  it("uploads local page assets and attachments only through HTTP", async () => {
    const f = await fixture();
    const page = join(f.directory, "page");
    await mkdir(join(page, "assets"), { recursive: true });
    await writeFile(join(page, "index.html"), "<h1>Page</h1>");
    await writeFile(join(page, "assets", "style.css"), "h1 { color: green }");
    await runDash([...f.args, "publish", "board", page]);
    expect(f.calls.at(-1)).toMatchObject({
      path: "/api/write/board/publish",
      body: {
        files: {
          "index.html": Buffer.from("<h1>Page</h1>").toString("base64"),
          "assets/style.css": Buffer.from("h1 { color: green }").toString("base64"),
        },
      },
    });
    const html = join(f.directory, "standalone.html");
    await writeFile(html, "<p>Single</p>");
    await runDash([...f.args, "publish", "board", html]);
    expect(f.calls.at(-1)!.body).toEqual({
      files: { "index.html": Buffer.from("<p>Single</p>").toString("base64") },
    });
    await runDash([...f.args, "attach", "board", html]);
    expect(f.calls.at(-1)!.body).toEqual({
      name: "standalone.html",
      body: Buffer.from("<p>Single</p>").toString("base64"),
    });
  });

  it("refuses symlinks, reserved routes, and oversized uploads before writing", async () => {
    const f = await fixture();
    const page = join(f.directory, "page");
    await mkdir(page);
    await writeFile(join(page, "index.html"), "page");
    await symlink(join(page, "index.html"), join(page, "link.html"));
    await expect(runDash([...f.args, "publish", "board", page])).rejects.toThrow("symlinks");
    await rm(join(page, "link.html"));
    await writeFile(join(page, "data.json"), "{}");
    await expect(runDash([...f.args, "publish", "board", page])).rejects.toThrow("reserved");
    await rm(join(page, "data.json"));
    await writeFile(join(page, "large.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(runDash([...f.args, "publish", "board", page])).rejects.toThrow("size limit");
    expect(f.calls).toHaveLength(0);
  });

  it("uses quoted SSH arguments and stdin JSON with locally resolved attribution", async () => {
    const f = await fixture();
    const ssh = await fakeSsh(f);
    const options = {
      sshExecutable: ssh.script,
      env: {
        DOPAMINE_CONFIG: f.configPath,
        T3CODE_HOME: f.config.adapter!.home,
        T3CODE_THREAD_ID: "local-thread",
      },
    };
    const value = { title: "No shell expansion: ' $(false) `false`" };
    expect(
      await runDash(
        ["post", "worker/board", "queue", "key'$(false)", "--json", JSON.stringify(value)],
        options,
      ),
    ).toBe("7");
    expect(f.calls.at(-1)!.headers["x-dopamine-writer"]).toBe("environment/local-thread");
    expect(f.calls.at(-1)!.body).toMatchObject({ key: "key'$(false)", value });
    const argv = JSON.parse(await readFile(ssh.captured, "utf8")) as string[];
    expect(argv.slice(0, -1)).toEqual(["-T", "-o", "BatchMode=yes", "--", "worker"]);
    expect(argv.at(-1)).not.toContain(value.title);
    expect(argv.at(-1)).not.toContain(f.secret);
    expect(JSON.parse(await readFile(ssh.payload, "utf8"))).toEqual(value);
    await runDash(
      [
        "create",
        "worker/board",
        "--title",
        "Remote ' title",
        "--collections-json",
        '{"questions":{"type":"questions"}}',
      ],
      options,
    );
    expect(f.calls.at(-1)!.body).toMatchObject({
      title: "Remote ' title",
      collections: { questions: { type: "questions" } },
    });
    expect((JSON.parse(await readFile(ssh.captured, "utf8")) as string[]).at(-1)).not.toContain(
      "Remote ' title",
    );
    await runDash(["update-manifest", "worker/board", "--json", '{"title":"Updated"}'], options);
    expect(JSON.parse(await readFile(ssh.payload, "utf8"))).toEqual({ title: "Updated" });
  });

  it("streams tar for remote publish and attach into the remote hub", async () => {
    const f = await fixture();
    const ssh = await fakeSsh(f);
    const page = join(f.directory, "page");
    await mkdir(join(page, "assets"), { recursive: true });
    await writeFile(join(page, "index.html"), "remote page");
    await writeFile(join(page, "assets", "file ' name.txt"), "asset");
    const opts = { sshExecutable: ssh.script };
    expect(await runDash([...f.args, "publish", "worker/board", page], opts)).toBe(
      `${f.config.viewingOrigin}/d/board--worker`,
    );
    expect(f.calls.at(-1)!.body).toEqual({
      files: {
        "index.html": Buffer.from("remote page").toString("base64"),
        "assets/file ' name.txt": Buffer.from("asset").toString("base64"),
      },
    });
    const archive = await readFile(ssh.payload);
    expect(archive.subarray(257, 262).toString()).toBe("ustar");
    expect((JSON.parse(await readFile(ssh.captured, "utf8")) as string[]).at(-1)).toContain(
      "--receive-tar",
    );
    await runDash(
      [...f.args, "attach", "worker/board", join(page, "assets", "file ' name.txt")],
      opts,
    );
    expect(f.calls.at(-1)!.body).toEqual({
      name: "file ' name.txt",
      body: Buffer.from("asset").toString("base64"),
    });
  });

  it.each([
    ["../escape", "0"],
    ["/absolute", "0"],
    ["index.html", "2"],
    ["index.html", "1"],
    ["api/write", "0"],
    ["data.json", "0"],
    ["folder\\escape", "0"],
  ])("validates archive names and refuses links before upload: %s %s", async (name, type) => {
    const f = await fixture();
    const input = tarEntry(name, type);
    await expect(
      runDash([...f.args, "publish", "board", "-", "--receive-tar"], {
        stdin: Readable.from([input]),
      }),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it("does not retry an HTTP rejection or an ambiguous accepted mutation", async () => {
    const f = await fixture((_req, res) => {
      res.statusCode = 400;
      res.end('{"error":"bad_value","message":"Invalid question"}');
    });
    await expect(
      runDash([...f.args, "post", "board", "questions", "one", "--json", "{}"], {
        retryTimeoutMs: 20,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow("Invalid question");
    expect(f.calls).toHaveLength(1);
    const ambiguous = await fixture((req) => req.socket.destroy());
    await expect(
      runDash([...ambiguous.args, "post", "board", "queue", "one", "--json", "{}"], {
        retryTimeoutMs: 20,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow();
    expect(ambiguous.calls).toHaveLength(1);
  });

  it("validates every archive entry before uploading any files", async () => {
    const f = await fixture();
    const archive = Buffer.concat([
      tarEntry("index.html", "0").subarray(0, -1024),
      tarEntry("../escape", "0"),
    ]);
    await expect(
      runDash([...f.args, "publish", "board", "-", "--receive-tar"], {
        stdin: Readable.from([archive]),
      }),
    ).rejects.toThrow("Unsafe upload name");
    expect(f.calls).toHaveLength(0);
  });

  it("retries connection refusal while the hub starts", async () => {
    const f = await fixture();
    await close(f.server);
    const restart = new Promise<void>((resolve) => {
      setTimeout(() => {
        f.server.listen(f.config.port, "127.0.0.1", resolve);
      }, 20);
    });
    expect(
      await runDash([...f.args, "post", "board", "queue", "one", "--json", "{}"], {
        retryTimeoutMs: 1000,
        retryDelayMs: 5,
      }),
    ).toBe("7");
    await restart;
    expect(f.calls).toHaveLength(1);
  });

  it("bounds stopped-hub retries and includes the configured service hint", async () => {
    const f = await fixture();
    f.config.serviceHint = "Start the dashboard service";
    await f.save();
    await close(f.server);
    await expect(
      runDash([...f.args, "post", "board", "queue", "one", "--json", "{}"], {
        retryTimeoutMs: 20,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow("Dopamine hub is not running on workstation; Start the dashboard service");
  });
});
