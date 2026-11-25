/* eslint-disable no-await-in-loop -- Fixtures exercise ordered deployment transitions. */
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { promisify } from "node:util";
import { deploy, uninstall } from "./deploy.ts";
import type { DeploymentConfig } from "./deploy.ts";

const execute = promisify(execFile);

describe("private-config deployment", () => {
  let sandbox: string;
  let source: string;
  let cfgFile: string;
  let cfg: DeploymentConfig;
  let server: Server;
  let firstCommit: string;
  let statusFile: string;

  async function git(...args: string[]) {
    return (await execute("git", ["-C", source, ...args])).stdout.trim();
  }

  async function saveConfig() {
    await writeFile(cfgFile, JSON.stringify(cfg));
  }

  beforeEach(async () => {
    sandbox = await mkdtemp(join(await realpath(tmpdir()), "deployment-test-"));
    source = join(sandbox, "source");
    cfgFile = join(sandbox, "private", "config.json");
    statusFile = join(sandbox, "service-status.json");
    await mkdir(join(source, "bin"), { recursive: true });
    await mkdir(join(sandbox, "private"), { mode: 0o700 });
    server = createServer(async (_request, response) => {
      try {
        const status = JSON.parse(await readFile(statusFile, "utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ ...status, ok: true, hubId: "fixture-hub", machine: "workstation" }),
        );
      } catch {
        response.writeHead(503).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const template = join(sandbox, "private", "service.template");
    await writeFile(template, "node={{node}}\napp={{app}}\nconfig={{config}}\nroot={{root}}\n");
    const controller = join(sandbox, "private", "service.mjs");
    await writeFile(
      controller,
      `
      import { readFileSync, writeFileSync, existsSync } from "node:fs";
      import { join } from "node:path";
      const [kind, configFile] = process.argv.slice(2);
      const config = JSON.parse(readFileSync(configFile));
      const app = join(config.deploy.root, "app");
      const state = kind === "stop" ? {} : {
        sourceCommit: existsSync(join(app, "broken")) ? "broken" : JSON.parse(readFileSync(join(app, "deployment.json"))).sourceCommit,
        retained: readFileSync(join(config.dataRoot, "retained.jsonl"), "utf8"),
        service: readFileSync(config.deploy.services[0].destination, "utf8")
      };
      writeFileSync(${JSON.stringify(statusFile)}, JSON.stringify(state));
    `,
    );
    cfg = {
      machine: "workstation",
      hubId: "fixture-hub",
      port: address.port,
      dataRoot: join(sandbox, "dashboards"),
      tokenFile: join(sandbox, "private", "token"),
      peerCredentialFile: join(sandbox, "private", "peer"),
      viewingOrigin: origin,
      dashboardDomain: "dashboard.invalid",
      deploy: {
        root: join(sandbox, "runtime"),
        node: process.execPath,
        dashLink: join(sandbox, "commands", "dash"),
        healthUrl: origin + "/healthz",
        services: [{ template, destination: join(sandbox, "services", "example.service") }],
        stop: [[process.execPath, controller, "stop", "{{config}}"]],
        start: [[process.execPath, controller, "start", "{{config}}"]],
      },
    };
    await saveConfig();
    await mkdir(cfg.dataRoot);
    await writeFile(join(cfg.dataRoot, "retained.jsonl"), '{"entry":"retained"}\n');
    await writeFile(cfg.peerCredentialFile!, "private-peer", { mode: 0o600 });
    await writeFile(
      join(source, "package.json"),
      '{"type":"module","devDependencies":{"example-tool":"1.0.0"}}\n',
    );
    await writeFile(join(source, "server.ts"), "export const running: boolean = true;\n");
    await writeFile(
      join(source, "bin", "dash.ts"),
      `
      import { readFileSync } from "node:fs";
      import { join } from "node:path";
      const cfg = JSON.parse(readFileSync(process.env.DOPAMINE_CONFIG!, "utf8"));
      if (process.argv[2] !== "list") throw new Error("Expected list");
      console.log(readFileSync(join(cfg.dataRoot, "retained.jsonl"), "utf8").trim());
    `,
    );
    await writeFile(join(source, ".gitignore"), "node_modules/\n");
    await mkdir(join(source, "node_modules"));
    await writeFile(join(source, "node_modules", "dev-only"), "never deploy");
    await git("init", "--quiet");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Fixture source",
    );
    firstCommit = await git("rev-parse", "HEAD");
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(sandbox, { recursive: true, force: true });
  });

  it("snapshots the exact committed files and hashes, pins dash and preserves private files", async () => {
    expect(await deploy(cfgFile, { source })).toBe(firstCommit);
    const app = join(cfg.deploy.root, "app");
    const receipt = JSON.parse(await readFile(join(app, "deployment.json"), "utf8")) as {
      sourceCommit: string;
      files: Record<string, string>;
    };
    expect(receipt.sourceCommit).toBe(firstCommit);
    const tracked = (await git("ls-tree", "-r", "--name-only", "HEAD")).split("\n");
    expect(Object.keys(receipt.files).toSorted()).toEqual([...tracked, "dash"].toSorted());
    for (const file of tracked) {
      const blob = (
        await execute("git", ["-C", source, "show", `${firstCommit}:${file}`], {
          encoding: "buffer",
        })
      ).stdout;
      expect(await readFile(join(app, file))).toEqual(blob);
      expect(receipt.files[file]).toBe(createHash("sha256").update(blob).digest("hex"));
    }
    expect(receipt.files.dash).toBe(
      createHash("sha256")
        .update(await readFile(join(app, "dash")))
        .digest("hex"),
    );
    expect(await readlink(cfg.deploy.dashLink)).toBe(join(app, "dash"));
    expect((await readFile(join(app, "dash"), "utf8")).split("\n")[0]).toBe(
      `#!${process.execPath}`,
    );
    expect((await stat(join(app, "dash"))).mode & 0o777).toBe(0o755);
    expect(
      (
        await execute(cfg.deploy.dashLink, ["list"], {
          env: { ...process.env, DOPAMINE_CONFIG: "/unused-fixture-config" },
        })
      ).stdout,
    ).toContain("retained");
    expect(await readFile(cfg.deploy.services[0]!.destination, "utf8")).toContain(
      `config=${cfgFile}`,
    );
    expect(await readdir(app)).not.toContain("node_modules");
    expect(await readdir(app)).not.toContain("dashboards");
    expect((await stat(cfg.tokenFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(sandbox, "private"))).mode & 0o777).toBe(0o700);
    expect((await readFile(cfg.tokenFile, "utf8")).trim()).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(cfg.peerCredentialFile!, "utf8")).toBe("private-peer");
    expect(JSON.parse(await readFile(cfgFile, "utf8"))).toEqual(cfg);
    await writeFile(join(app, ".DS_Store"), "Finder metadata");
    await writeFile(join(app, "bin", ".DS_Store"), "nested metadata");
    expect(await deploy(cfgFile, { source })).toBe(firstCommit);
    expect(await readFile(join(cfg.deploy.root, "last-good", "app", ".DS_Store"), "utf8")).toBe(
      "Finder metadata",
    );
    const status = await readFile(statusFile);
    await writeFile(join(app, "unexpected.js"), "untracked executable content");
    await expect(deploy(cfgFile, { source })).rejects.toThrow("inventory differs");
    expect(await readFile(statusFile)).toEqual(status);
  });

  it("refuses dirty and untracked source without stopping the old app", async () => {
    await deploy(cfgFile, { source });
    const status = await readFile(statusFile);
    await writeFile(join(source, "server.ts"), "changed");
    await expect(deploy(cfgFile, { source })).rejects.toThrow("must be clean");
    expect(await readFile(statusFile)).toEqual(status);
    await git("checkout", "--", "server.ts");
    await writeFile(join(source, "untracked"), "untracked");
    await expect(deploy(cfgFile, { source })).rejects.toThrow("must be clean");
    expect(await readFile(statusFile)).toEqual(status);
  });

  it("recovers the previous running worker after a later stop command fails", async () => {
    await deploy(cfgFile, { source });
    const before = await readFile(join(cfg.deploy.root, "app", "deployment.json"));
    cfg.deploy.stop.push([process.execPath, "-e", "process.exit(1)"]);
    await saveConfig();
    await expect(deploy(cfgFile, { source })).rejects.toThrow(
      "previous app and service files restored",
    );
    expect(await readFile(join(cfg.deploy.root, "app", "deployment.json"))).toEqual(before);
    expect(JSON.parse(await readFile(statusFile, "utf8")).sourceCommit).toBe(firstCommit);
    expect(await readdir(cfg.deploy.root)).not.toContain("recovery");
    cfg.deploy.stop.pop();
    await saveConfig();
    expect(await deploy(cfgFile, { source })).toBe(firstCommit);
  });
  it("restores the exact app, service mode and CLI after a broken candidate restart", async () => {
    await deploy(cfgFile, { source });
    const app = join(cfg.deploy.root, "app");
    const oldReceipt = await readFile(join(app, "deployment.json"));
    const destination = cfg.deploy.services[0]!.destination;
    await writeFile(destination, "previous service bytes\n");
    await chmod(destination, 0o640);
    const oldToken = await readFile(cfg.tokenFile);
    await writeFile(cfg.deploy.services[0]!.template, "changed template\n");
    await writeFile(join(source, "broken"), "candidate cannot report its commit\n");
    await git("add", "broken");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Broken fixture",
    );
    await expect(deploy(cfgFile, { source })).rejects.toThrow(
      "previous app and service files restored",
    );
    expect(await readFile(join(app, "deployment.json"))).toEqual(oldReceipt);
    expect(await readFile(destination, "utf8")).toBe("previous service bytes\n");
    expect((await stat(destination)).mode & 0o777).toBe(0o640);
    const state = JSON.parse(await readFile(statusFile, "utf8")) as {
      sourceCommit: string;
      retained: string;
      service: string;
    };
    expect(state.sourceCommit).toBe(firstCommit);
    expect(state.retained).toBe('{"entry":"retained"}\n');
    expect(state.service).toBe("previous service bytes\n");
    expect((await execute(cfg.deploy.dashLink, ["list"])).stdout).toContain('"entry":"retained"');
    expect(await readFile(cfg.tokenFile)).toEqual(oldToken);
    expect(await readdir(cfg.deploy.root)).not.toContain("recovery");
  }, 35_000);

  it("rolls back to last-good with the matching CLI and service files", async () => {
    await deploy(cfgFile, { source });
    const oldService = await readFile(cfg.deploy.services[0]!.destination);
    await writeFile(join(source, "version"), "next\n");
    await git("add", "version");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Next fixture",
    );
    const secondCommit = await git("rev-parse", "HEAD");
    const queued = join(cfg.dataRoot, "board", "actions.jsonl");
    await mkdir(join(cfg.dataRoot, "board"), { recursive: true });
    await writeFile(queued, '{"event":"request","request":{"requestId":"r-0"}}\n');
    expect(await deploy(cfgFile, { source })).toBe(secondCommit);
    expect(await deploy(cfgFile, { rollback: true })).toBe(firstCommit);
    // Queued actions live with dashboard data, outside the deployment, so a rollback keeps them.
    expect(await readFile(queued, "utf8")).toContain('"requestId":"r-0"');
    expect(await readFile(cfg.deploy.services[0]!.destination)).toEqual(oldService);
    expect((await execute(cfg.deploy.dashLink, ["list"])).stdout).toContain("retained");
    const backup = JSON.parse(
      await readFile(join(cfg.deploy.root, "last-good", "app", "deployment.json"), "utf8"),
    ) as { sourceCommit: string };
    expect(backup.sourceCommit).toBe(secondCommit);
  });

  it("uninstalls only configured files and purges dashboard data only with the explicit flag", async () => {
    await deploy(cfgFile, { source });
    const token = await readFile(cfg.tokenFile);
    const unrelated = join(sandbox, "services", "unrelated.service");
    await writeFile(unrelated, "leave alone");
    await uninstall(cfgFile);
    await expect(stat(join(cfg.deploy.root, "app"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readlink(cfg.deploy.dashLink)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(cfg.deploy.services[0]!.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(unrelated, "utf8")).toBe("leave alone");
    expect(await readFile(join(cfg.dataRoot, "retained.jsonl"), "utf8")).toContain("retained");
    expect(await readFile(cfg.tokenFile)).toEqual(token);
    await uninstall(cfgFile, { purge: true });
    await expect(stat(cfg.dataRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(cfg.tokenFile)).toEqual(token);
    expect(await readFile(cfg.peerCredentialFile!, "utf8")).toBe("private-peer");
    expect(JSON.parse(await readFile(cfgFile, "utf8"))).toEqual(cfg);
  });

  it("refuses managed paths that overlap private data, including symlink aliases", async () => {
    cfg.dataRoot = parse(sandbox).root;
    await saveConfig();
    await expect(uninstall(cfgFile, { purge: true })).rejects.toThrow("outside deployment root");
    cfg.dataRoot = join(cfg.deploy.root, "app", "data");
    await saveConfig();
    await expect(deploy(cfgFile, { source })).rejects.toThrow("outside deployment root");
    cfg.dataRoot = join(sandbox, "dashboards");
    await symlink(cfg.dataRoot, join(sandbox, "data-alias"));
    cfg.deploy.root = join(sandbox, "data-alias", "installation");
    await saveConfig();
    await expect(uninstall(cfgFile, { purge: true })).rejects.toThrow("outside deployment root");
    cfg.deploy.root = join(sandbox, "runtime");
    cfg.tokenFile = join(cfg.dataRoot, "token");
    await saveConfig();
    await expect(uninstall(cfgFile, { purge: true })).rejects.toThrow("outside dashboard data");
    expect(await readFile(join(cfg.dataRoot, "retained.jsonl"), "utf8")).toContain("retained");
  });

  it("fails fast on an existing deployment lock", async () => {
    await mkdir(join(cfg.deploy.root, ".deploy-lock"), { recursive: true });
    await expect(deploy(cfgFile, { source })).rejects.toThrow("Deployment is locked");
    await expect(uninstall(cfgFile)).rejects.toThrow("Deployment is locked");
    expect(await readdir(cfg.deploy.root)).toEqual([".deploy-lock"]);
  });
});
