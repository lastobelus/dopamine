/* eslint-disable no-await-in-loop -- Deployment steps and recovery must run in order. */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { loopback, readConfig, readSecret } from "./config.ts";
import type { HubConfig } from "./config.ts";

interface DeployConfig {
  root: string;
  node: string;
  dashLink: string;
  healthUrl: string;
  services: { template: string; destination: string }[];
  stop: string[][];
  start: string[][];
}

export type DeploymentConfig = HubConfig & { deploy: DeployConfig };
interface Receipt {
  sourceCommit: string;
  files: Record<string, string>;
}
interface SavedService {
  destination: string;
  mode: number | null;
}
interface SavedState {
  app: boolean;
  link: boolean;
  services: SavedService[];
}
interface Context {
  config: DeploymentConfig;
  configFile: string;
  root: string;
  app: string;
}

class DeploymentError extends Error {}
const execute = promisify(execFile);
const digest = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const inside = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function info(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!absent(error)) throw error;
    return join(await canonical(dirname(path)), relative(dirname(path), path));
  }
}

function absolute(path: unknown): asserts path is string {
  if (typeof path !== "string" || !isAbsolute(path) || /[\r\n\0]/.test(path))
    throw new DeploymentError("Deployment paths must be absolute and contain no line breaks");
}

async function context(configFile: string): Promise<Context> {
  absolute(configFile);
  const config = (await readConfig(configFile)) as DeploymentConfig;
  const settings = config.deploy;
  if (
    !settings ||
    !Array.isArray(settings.services) ||
    !Array.isArray(settings.stop) ||
    !Array.isArray(settings.start)
  )
    throw new DeploymentError("Private configuration needs a deployment section");
  for (const commandList of [settings.stop, settings.start]) {
    if (
      !commandList.length ||
      commandList.some(
        (command) =>
          !Array.isArray(command) ||
          !command.length ||
          command.some((arg) => typeof arg !== "string" || arg.includes("\0")),
      )
    )
      throw new DeploymentError("Service commands must be nonempty argv arrays");
  }
  const paths = [
    settings.root,
    settings.node,
    settings.dashLink,
    config.dataRoot,
    config.tokenFile,
    configFile,
  ];
  if (config.peerCredentialFile) paths.push(config.peerCredentialFile);
  for (const service of settings.services) paths.push(service.template, service.destination);
  for (const path of paths) absolute(path);
  const root = await canonical(settings.root);
  if (root === dirname(root))
    throw new DeploymentError("Deployment root cannot be a filesystem root");
  const data = await canonical(config.dataRoot);
  const protectedPaths = await Promise.all(
    [
      configFile,
      config.tokenFile,
      ...(config.peerCredentialFile ? [config.peerCredentialFile] : []),
    ].map(canonical),
  );
  const templates = await Promise.all(
    settings.services.map((service) => canonical(service.template)),
  );
  const node = await canonical(settings.node);
  const destinations = await Promise.all(
    [settings.dashLink, ...settings.services.map((service) => service.destination)].map(canonical),
  );
  // An existing managed link resolves into app; inspect its parent instead of following it.
  destinations[0] = join(
    await canonical(dirname(settings.dashLink)),
    relative(dirname(settings.dashLink), settings.dashLink),
  );
  for (const path of [data, ...protectedPaths, ...templates, node])
    if (overlap(root, path))
      throw new DeploymentError(
        "Data, secrets, configuration, templates and Node must be outside deployment root",
      );
  if (protectedPaths.some((path) => overlap(data, path)))
    throw new DeploymentError("Secrets and configuration must be outside dashboard data");
  for (let index = 0; index < destinations.length; index++) {
    const path = destinations[index]!;
    if (
      [root, data, node, ...protectedPaths, ...templates, ...destinations.slice(0, index)].some(
        (other) => overlap(other, path),
      )
    )
      throw new DeploymentError(
        "Managed destinations must be separate from deployment root, data and private files",
      );
  }
  const health = new URL(settings.healthUrl);
  if (
    health.protocol !== "http:" ||
    !loopback(health) ||
    health.pathname !== "/healthz" ||
    health.username ||
    health.password ||
    health.search ||
    health.hash
  )
    throw new DeploymentError("Health URL must be a loopback HTTP healthz endpoint");
  if (!(await stat(settings.node)).isFile() || /\s/.test(settings.node))
    throw new DeploymentError("Pinned Node must be an executable file with a shebang-safe path");
  await access(settings.node, constants.X_OK);
  for (const name of ["app", "candidate", "last-good", "recovery", ".deploy-lock"])
    if ((await info(join(root, name)))?.isSymbolicLink())
      throw new DeploymentError("Managed deployment paths cannot be symlinks");
  for (const service of settings.services) {
    const existing = await info(service.destination);
    if (existing && !existing.isFile())
      throw new DeploymentError("Service destinations must be regular files");
  }
  const link = await info(settings.dashLink);
  if (
    link &&
    (!link.isSymbolicLink() ||
      resolve(dirname(settings.dashLink), await readlink(settings.dashLink)) !==
        join(root, "app", "dash"))
  )
    throw new DeploymentError("Dash destination is already owned by another file");
  return { config, configFile, root, app: join(root, "app") };
}

function render(text: string, ctx: Context): string {
  const values: Record<string, string> = {
    node: ctx.config.deploy.node,
    app: ctx.app,
    config: ctx.configFile,
    root: ctx.root,
  };
  return text.replace(/\{\{([^{}]+)\}\}/g, (_match, key: string) => {
    if (!(key in values)) throw new DeploymentError("Unknown deployment template placeholder");
    return values[key]!;
  });
}

async function commands(ctx: Context, kind: "stop" | "start", continueAfterError = false) {
  let failed = false;
  for (const command of ctx.config.deploy[kind]) {
    const args = command.map((arg) => render(arg, ctx));
    try {
      await execute(args[0]!, args.slice(1), {
        cwd: ctx.root,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      failed = true;
      if (!continueAfterError)
        throw new DeploymentError(`Configured service ${kind} command failed`);
    }
  }
  if (failed) throw new DeploymentError(`Configured service ${kind} command failed`);
}

async function atomicFile(path: string, body: Uint8Array | string, mode: number) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, body, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function token(ctx: Context) {
  const path = ctx.config.tokenFile;
  if (await info(path)) {
    await readSecret(path);
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
}

async function git(source: string, ...args: string[]): Promise<Buffer> {
  try {
    return (
      await execute("git", ["-C", source, ...args], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new DeploymentError("Could not read committed source checkout");
  }
}

async function snapshot(ctx: Context, source: string, bundle: string): Promise<Receipt> {
  source = await realpath(source);
  if ((await git(source, "rev-parse", "--show-toplevel")).toString().trim() !== source)
    throw new DeploymentError("Source must be the checkout root");
  if (overlap(source, ctx.root))
    throw new DeploymentError("Deployment root must be separate from source checkout");
  for (const path of [
    ctx.config.dataRoot,
    ctx.config.tokenFile,
    ctx.config.peerCredentialFile,
    ctx.configFile,
  ].filter((candidatePath): candidatePath is string => !!candidatePath))
    if (overlap(source, await canonical(path)))
      throw new DeploymentError("Private data and configuration must be outside source checkout");
  if ((await git(source, "status", "--porcelain", "--untracked-files=all")).length)
    throw new DeploymentError("Source checkout must be clean; commit changes before deployment");
  const sourceCommit = (await git(source, "rev-parse", "HEAD")).toString().trim();
  const entries = (await git(source, "ls-tree", "-rz", "--full-tree", sourceCommit))
    .toString()
    .split("\0")
    .filter(Boolean);
  const app = join(bundle, "app");
  await mkdir(app);
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/s.exec(entry);
    if (!match) throw new DeploymentError("Source snapshot supports regular tracked files only");
    const mode = match[1]!;
    const object = match[2]!;
    const name = match[3]!;
    if (
      name.split("/").some((part) => ["node_modules", ".git"].includes(part)) ||
      ["dash", "deployment.json"].includes(name)
    )
      throw new DeploymentError("Source contains a reserved deployment path or dependency tree");
    const body = await git(source, "cat-file", "blob", object);
    const destination = join(app, name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, body, { mode: mode === "100755" ? 0o755 : 0o644 });
    files[name] = digest(body);
  }
  if (!files["server.ts"] || !files["bin/dash.ts"] || !files["package.json"])
    throw new DeploymentError("Source snapshot is missing required entrypoints");
  const wrapper = `#!${ctx.config.deploy.node}\nprocess.env.DOPAMINE_CONFIG = ${JSON.stringify(ctx.configFile)};\nawait import("./bin/dash.ts");\n`;
  await writeFile(join(app, "dash"), wrapper, { mode: 0o755 });
  files.dash = digest(Buffer.from(wrapper));
  const metadata = { sourceCommit, files };
  await writeFile(join(app, "deployment.json"), JSON.stringify(metadata, null, 2) + "\n");
  // Pin validation to the same interpreter that will run the service, without a build.
  for (const file of Object.keys(files).filter((name) => name.endsWith(".ts") || name === "dash")) {
    try {
      await execute(ctx.config.deploy.node, ["--check", join(app, file)], { timeout: 20_000 });
    } catch {
      throw new DeploymentError("Committed source does not pass pinned Node syntax validation");
    }
  }
  if (
    (await git(source, "rev-parse", "HEAD")).toString().trim() !== sourceCommit ||
    (await git(source, "status", "--porcelain", "--untracked-files=all")).length
  )
    throw new DeploymentError("Source changed while preparing deployment");
  return metadata;
}

async function treeFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...(await treeFiles(join(root, entry.name), name + "/")));
    else if (entry.isFile()) files.push(name);
    else throw new DeploymentError("Saved app contains a non-regular file");
  }
  return files;
}

async function receipt(app: string): Promise<Receipt> {
  if (!(await info(app))?.isDirectory())
    throw new DeploymentError("Saved app must be a regular directory");
  const value = JSON.parse(await readFile(join(app, "deployment.json"), "utf8")) as Receipt;
  if (
    !/^[a-f0-9]{40,64}$/.test(value.sourceCommit) ||
    !value.files ||
    typeof value.files !== "object"
  )
    throw new DeploymentError("Saved deployment receipt is invalid");
  const names = await treeFiles(app);
  if (names.length !== Object.keys(value.files).length + 1)
    throw new DeploymentError("Saved app file inventory differs from receipt");
  for (const name of names.filter((file) => file !== "deployment.json"))
    if (value.files[name] !== digest(await readFile(join(app, name))))
      throw new DeploymentError("Saved app hash differs from receipt");
  return value;
}

async function capture(ctx: Context, bundle: string): Promise<SavedState> {
  await mkdir(bundle);
  const app = await info(ctx.app);
  if (app && !app.isDirectory()) throw new DeploymentError("Installed app must be a directory");
  if (app) {
    await receipt(ctx.app);
    await cp(ctx.app, join(bundle, "app"), { recursive: true });
  }
  const state: SavedState = {
    app: !!app,
    link: !!(await info(ctx.config.deploy.dashLink)),
    services: [],
  };
  for (const [index, service] of ctx.config.deploy.services.entries()) {
    const file = await info(service.destination);
    state.services.push({
      destination: service.destination,
      mode: file ? file.mode & 0o777 : null,
    });
    if (file)
      await writeFile(join(bundle, `service-${index}`), await readFile(service.destination), {
        mode: 0o600,
      });
  }
  await writeFile(join(bundle, "state.json"), JSON.stringify(state), { mode: 0o600 });
  return state;
}

async function savedState(ctx: Context, bundle: string): Promise<SavedState> {
  const state = JSON.parse(await readFile(join(bundle, "state.json"), "utf8")) as SavedState;
  if (
    typeof state.app !== "boolean" ||
    typeof state.link !== "boolean" ||
    !Array.isArray(state.services) ||
    state.services.length !== ctx.config.deploy.services.length ||
    state.services.some(
      (service, index) =>
        service.destination !== ctx.config.deploy.services[index]!.destination ||
        (service.mode !== null &&
          (!Number.isInteger(service.mode) || service.mode < 0 || service.mode > 0o777)),
    )
  )
    throw new DeploymentError("Saved services do not match configured destinations");
  return state;
}

async function restore(ctx: Context, bundle: string, state: SavedState) {
  await rm(ctx.app, { recursive: true, force: true });
  if (state.app) await cp(join(bundle, "app"), ctx.app, { recursive: true });
  for (const [index, service] of state.services.entries()) {
    if (service.mode === null) await rm(service.destination, { force: true });
    else
      await atomicFile(
        service.destination,
        await readFile(join(bundle, `service-${index}`)),
        service.mode,
      );
  }
  await rm(ctx.config.deploy.dashLink, { force: true });
  if (state.link) await linkDash(ctx);
}

async function linkDash(ctx: Context) {
  const path = ctx.config.deploy.dashLink;
  await mkdir(dirname(path), { recursive: true });
  if (!(await info(path))) await symlink(join(ctx.app, "dash"), path);
}

async function healthy(ctx: Context, sourceCommit: string) {
  const deadline = performance.now() + 20_000;
  do {
    try {
      const response = await fetch(ctx.config.deploy.healthUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(1000, Math.ceil(deadline - performance.now()))),
        ),
      });
      const value = (await response.json()) as {
        ok?: boolean;
        sourceCommit?: string;
        hubId?: string;
        machine?: string;
      };
      if (
        response.ok &&
        value.ok === true &&
        value.sourceCommit === sourceCommit &&
        value.hubId === ctx.config.hubId &&
        value.machine === ctx.config.machine
      )
        return;
    } catch {
      /* A service can take a moment to bind after restart. */
    }
    if (performance.now() < deadline) await delay(Math.min(100, deadline - performance.now()));
  } while (performance.now() < deadline);
  throw new DeploymentError("Service did not report the expected deployment within 20 seconds");
}

async function locked<T>(ctx: Context, operation: () => Promise<T>): Promise<T> {
  await mkdir(ctx.root, { recursive: true, mode: 0o700 });
  const lock = join(ctx.root, ".deploy-lock");
  try {
    await mkdir(lock);
  } catch {
    throw new DeploymentError(
      "Deployment is locked; check for an active operation before removing the lock",
    );
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function deploy(
  configFile: string,
  options: { source?: string; rollback?: boolean } = {},
): Promise<string> {
  try {
    const ctx = await context(resolve(configFile));
    return await locked(ctx, async () => {
      const candidate = join(ctx.root, "candidate");
      const recovery = join(ctx.root, "recovery");
      const previous = join(ctx.root, "last-good");
      if ((await info(candidate)) || (await info(recovery)))
        throw new DeploymentError("A retained deployment bundle needs inspection before retrying");
      await mkdir(candidate);
      try {
        let next: Receipt;
        let rollbackState: SavedState | undefined;
        if (options.rollback) {
          rollbackState = await savedState(ctx, previous);
          if (!rollbackState.app)
            throw new DeploymentError("No previous app is available for rollback");
          next = await receipt(join(previous, "app"));
          await cp(previous, candidate, { recursive: true });
        } else {
          next = await snapshot(ctx, options.source ?? process.cwd(), candidate);
          for (const [index, service] of ctx.config.deploy.services.entries())
            await writeFile(
              join(candidate, `service-${index}`),
              render(await readFile(service.template, "utf8"), ctx),
              { mode: 0o600 },
            );
        }
        await token(ctx);
        const old = await capture(ctx, recovery);
        try {
          await commands(ctx, "stop");
          if (rollbackState) await restore(ctx, candidate, rollbackState);
          else {
            await rm(ctx.app, { recursive: true, force: true });
            await rename(join(candidate, "app"), ctx.app);
            for (const [index, service] of ctx.config.deploy.services.entries())
              await atomicFile(
                service.destination,
                await readFile(join(candidate, `service-${index}`)),
                0o600,
              );
            await linkDash(ctx);
          }
          await commands(ctx, "start");
          await healthy(ctx, next.sourceCommit);
        } catch {
          try {
            await commands(ctx, "stop", true).catch(() => undefined);
            await restore(ctx, recovery, old);
            if (old.app) {
              await commands(ctx, "start", true);
              await healthy(ctx, (await receipt(ctx.app)).sourceCommit);
            }
          } catch {
            throw new DeploymentError(
              "Deployment and recovery failed; recovery bundle retained for repair",
            );
          }
          await rm(recovery, { recursive: true });
          throw new DeploymentError("Deployment failed; previous app and service files restored");
        }
        await rm(previous, { recursive: true, force: true });
        await rename(recovery, previous);
        return next.sourceCommit;
      } finally {
        await rm(candidate, { recursive: true, force: true });
      }
    });
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw new DeploymentError(
      "Deployment failed; check private configuration and filesystem access",
    );
  }
}

export async function uninstall(
  configFile: string,
  options: { purge?: boolean } = {},
): Promise<void> {
  try {
    const ctx = await context(resolve(configFile));
    await locked(ctx, async () => {
      await commands(ctx, "stop");
      for (const service of ctx.config.deploy.services)
        await rm(service.destination, { force: true });
      await rm(ctx.config.deploy.dashLink, { force: true });
      for (const name of ["app", "last-good", "candidate", "recovery"])
        await rm(join(ctx.root, name), { recursive: true, force: true });
      if (options.purge) await rm(ctx.config.dataRoot, { recursive: true, force: true });
    });
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw new DeploymentError(
      "Uninstall failed; check private configuration and filesystem access",
    );
  }
}
