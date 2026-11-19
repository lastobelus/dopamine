import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readConfig, readSecret, shellUrl } from "./config.ts";
import type { HubConfig } from "./config.ts";

const MAX_BODY = 32 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_UPLOAD = 16 * 1024 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HELP = `Usage: dash [--config <path>] [--as <environment>/<thread>] <command>

create <name> --title <title> [--owner <environment>/<thread>] [--handler <environment>/<thread>]
  [--url <url>] [--from-starter] [--collections-json <JSON>] [--actions-file <path>]
publish <name> <file-or-folder>
post <name> <collection> <key> (--json <JSON> | --file <path-or-> | --delete)
  [--before <key> | --at-end]
set-collection <name> <collection> (--json <JSON> | --file <path-or->)
attach <name> <path>
list [--json]
show <name>
url <name>
remove <name> [--force]
restore <name>
update-manifest <name> [--json <JSON> | --file <path-or->] [--title <title>]
  [--owner <environment>/<thread>] [--handler <environment>/<thread>] [--url <url>]
  [--kind page|url] [--collections-json <JSON>] [--stale-after-minutes <number>]
  [--pinned | --unpinned] [--actions-file <path>]

Names are local IDs or configured machine/ID pairs. JSON files may use - for stdin.
Actions are unavailable in phase 1a.`;

interface ClientOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: AsyncIterable<Uint8Array | string>;
  retryTimeoutMs?: number;
  retryDelayMs?: number;
  sshExecutable?: string;
}
interface Parsed {
  command: string;
  args: string[];
  flags: Map<string, string | true>;
}
interface Context {
  config: HubConfig;
  options: ClientOptions;
  parsed: Parsed;
  identity?: string;
}
type JsonObject = Record<string, unknown>;
interface Upload {
  name: string;
  body: Buffer;
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "from-starter",
  "delete",
  "at-end",
  "json",
  "force",
  "pinned",
  "unpinned",
  "receive-tar",
  "wait",
]);
const VALUE_FLAGS = new Set([
  "config",
  "as",
  "title",
  "owner",
  "handler",
  "url",
  "actions-file",
  "collections-json",
  "file",
  "before",
  "kind",
  "stale-after-minutes",
]);
const FLAGS: Record<string, string[]> = {
  create: [
    "title",
    "owner",
    "handler",
    "url",
    "from-starter",
    "collections-json",
    "actions-file",
    "stale-after-minutes",
    "pinned",
    "file",
  ],
  publish: ["receive-tar"],
  post: ["json", "file", "delete", "before", "at-end"],
  "set-collection": ["json", "file"],
  attach: ["receive-tar"],
  list: ["json"],
  show: [],
  url: [],
  remove: ["force"],
  restore: [],
  "update-manifest": [
    "json",
    "file",
    "title",
    "owner",
    "handler",
    "url",
    "kind",
    "collections-json",
    "actions-file",
    "stale-after-minutes",
    "pinned",
    "unpinned",
  ],
};

function parse(args: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--" && !literal) {
      literal = true;
      continue;
    }
    if (literal || !arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (flags.has(name)) throw new Error(`Duplicate option --${name}`);
    if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name))
      throw new Error(`Unknown option --${name}`);
    if (BOOLEAN_FLAGS.has(name) && name !== "json") {
      if (eq >= 0) throw new Error(`Option --${name} takes no value`);
      flags.set(name, true);
    } else if (
      name === "json" &&
      (positionals[0] === "list" || (eq < 0 && (!args[i + 1] || args[i + 1]!.startsWith("--"))))
    ) {
      flags.set(name, true);
    } else {
      const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`Option --${name} needs a value`);
      flags.set(name, value);
    }
  }
  return { command: positionals[0] ?? "", args: positionals.slice(1), flags };
}

function stringFlag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === true) throw new Error(`Option --${name} needs a value`);
  return value;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`);
  return value as JsonObject;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON input");
  }
}

function writer(value: string): string {
  if (value.length > 512 || !/^[\x21-\x2e\x30-\x7e]+\/[\x21-\x2e\x30-\x7e]+$/.test(value))
    throw new Error("Writer must be <environment>/<thread>; pass --as explicitly");
  return value;
}

function identity(config: HubConfig, parsed: Parsed, env: NodeJS.ProcessEnv): string {
  const explicit = stringFlag(parsed, "as");
  if (explicit !== undefined) return writer(explicit);
  if (config.adapter && config.adapter.home === env.T3CODE_HOME && env.T3CODE_THREAD_ID)
    return writer(`${config.adapter.environmentId}/${env.T3CODE_THREAD_ID}`);
  throw new Error(
    "Cannot resolve writer identity; pass --as <environment>/<thread> or use the configured adapter",
  );
}

function threadRef(value: string): JsonObject {
  if (value.startsWith("{")) return object(json(value), "Thread reference");
  const [environmentId, threadId] = writer(value).split("/");
  return { environmentId, threadId };
}

function target(
  config: HubConfig,
  name: string,
): { id: string; remote?: NonNullable<HubConfig["remotes"]>[string] } {
  const parts = name.split("/");
  const machine = parts.length === 1 ? config.machine : parts[0]!;
  const id = parts.length === 1 ? parts[0]! : parts[1]!;
  if (parts.length > 2 || !SLUG.test(machine) || !SLUG.test(id))
    throw new Error("Use a dashboard ID or a configured machine/ID");
  if (machine === config.machine) return { id };
  const remote = config.remotes?.[machine];
  if (!remote) throw new Error("Dashboard machine is not configured as a remote");
  return { id, remote };
}

async function bounded(input: AsyncIterable<Uint8Array | string>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("Input exceeds the size limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function fileBytes(path: string, limit = MAX_UPLOAD): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Input must be a regular file");
    if (info.size > limit) throw new Error("Input exceeds the size limit");
    return await bounded(handle.createReadStream({ autoClose: false }), limit);
  } catch (error) {
    if (
      error instanceof Error &&
      ["Input must be a regular file", "Input exceeds the size limit"].includes(error.message)
    )
      throw error;
    throw new Error("Cannot read input file; symlinks are not allowed", { cause: error });
  } finally {
    await handle?.close();
  }
}

async function readJsonInput(
  parsed: Parsed,
  options: ClientOptions,
  optional = false,
): Promise<unknown> {
  const inline = stringFlag(parsed, "json");
  const file = stringFlag(parsed, "file");
  if (inline !== undefined && file !== undefined) throw new Error("Choose --json or --file");
  if (inline !== undefined) {
    if (Buffer.byteLength(inline) > MAX_BODY) throw new Error("Input exceeds the size limit");
    return json(inline);
  }
  if (file !== undefined) {
    const data =
      file === "-"
        ? await bounded(options.stdin ?? process.stdin, MAX_BODY)
        : await fileBytes(file, MAX_BODY);
    return json(data.toString("utf8"));
  }
  if (!optional) throw new Error("Provide --json or --file (- reads stdin)");
  return {};
}

async function manifestInput(ctx: Context): Promise<JsonObject> {
  const { parsed, options } = ctx;
  const body = object(await readJsonInput(parsed, options, true), "Manifest");
  for (const flag of ["title", "url", "kind"]) {
    const value = stringFlag(parsed, flag);
    if (value !== undefined) body[flag] = value;
  }
  for (const flag of ["owner", "handler"]) {
    const value = stringFlag(parsed, flag);
    if (value !== undefined) body[flag] = threadRef(value);
  }
  const collections = stringFlag(parsed, "collections-json");
  if (collections !== undefined) body.collections = object(json(collections), "Collections");
  const stale = stringFlag(parsed, "stale-after-minutes");
  if (stale !== undefined) {
    const minutes = Number(stale);
    if (stale.trim() === "" || !Number.isSafeInteger(minutes) || minutes < 0)
      throw new Error("Stale minutes must be a nonnegative integer");
    body.staleAfterMinutes = minutes;
  }
  if (parsed.flags.has("pinned") && parsed.flags.has("unpinned"))
    throw new Error("Choose --pinned or --unpinned");
  if (parsed.flags.has("pinned")) body.pinned = true;
  if (parsed.flags.has("unpinned")) body.pinned = false;
  const actionsFile = stringFlag(parsed, "actions-file");
  if (actionsFile !== undefined)
    body.actions = json((await fileBytes(actionsFile)).toString("utf8"));
  if (body.actions !== undefined && !Array.isArray(body.actions))
    throw new Error("Actions must be a JSON array");
  if (parsed.command === "create") {
    if (!body.title) throw new Error("Create requires --title");
    body.kind = body.url ? "url" : "page";
    body.owner ??= threadRef(ctx.identity!);
    body.handler ??= body.owner;
    if (body.kind === "url" && parsed.flags.has("from-starter"))
      throw new Error("A URL dashboard cannot use --from-starter");
  }
  return body;
}

function connectionRefused(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ECONNREFUSED";
}

class HubResponseError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function hubRequest(ctx: Context, route: string, body?: JsonObject): Promise<unknown> {
  const write = body !== undefined;
  const payload = write ? Buffer.from(JSON.stringify(body)) : undefined;
  if (payload && payload.length > MAX_BODY) throw new Error("Request exceeds the size limit");
  let token: string | undefined;
  if (write) {
    try {
      token = await readSecret(ctx.config.tokenFile);
    } catch {
      throw new Error(
        "Cannot read the private write token; check its configuration and permissions",
      );
    }
  }
  const timeout = ctx.options.retryTimeoutMs ?? 30_000;
  const deadline = Date.now() + timeout;
  /* eslint-disable no-await-in-loop -- Refused connections retry in sequence until the deadline. */
  for (;;) {
    let connected = false;
    let responseStarted = false;
    try {
      return await new Promise<unknown>((resolveResult, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: ctx.config.port,
            path: route,
            method: write ? "POST" : "GET",
            headers: write
              ? {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                  "content-length": payload!.length,
                  "x-dopamine-writer": ctx.identity!,
                }
              : {},
          },
          (response) => {
            responseStarted = true;
            void (async () => {
              const text = (await bounded(response, MAX_BODY)).toString("utf8");
              const result = json(text);
              if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                const details = object(result, "Hub error");
                const message =
                  typeof details.message === "string"
                    ? details.message
                    : typeof details.error === "string"
                      ? details.error
                      : "Request failed";
                reject(
                  new HubResponseError(
                    response.statusCode ?? 500,
                    `Hub rejected request (${response.statusCode}): ${message}`,
                  ),
                );
              } else resolveResult(result);
            })().catch(reject);
          },
        );
        req.on("socket", (socket) => {
          if (!socket.connecting) connected = true;
          socket.once("connect", () => {
            connected = true;
          });
        });
        req.on("error", reject);
        req.setTimeout(30_000, () =>
          req.destroy(new Error("Hub request timed out; its result may be unknown")),
        );
        req.end(payload);
      });
    } catch (error) {
      if (connected || responseStarted || !connectionRefused(error)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          `Dopamine hub is not running on ${ctx.config.machine}${ctx.config.serviceHint ? `; ${ctx.config.serviceHint}` : "; start the configured hub service"}`,
          { cause: error },
        );
      await delay(Math.min(ctx.options.retryDelayMs ?? 200, remaining));
    }
  }
  /* eslint-enable no-await-in-loop */
}

function controlCharacters(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function safeName(name: string, page: boolean): string {
  if (
    !name ||
    Buffer.byteLength(name) > 240 ||
    controlCharacters(name) ||
    /[\\:%?#]/.test(name) ||
    name.startsWith("/")
  )
    throw new Error("Unsafe upload name");
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("Unsafe upload name");
  if (
    page &&
    [
      "api",
      "files",
      "data.json",
      "dashboard.json",
      "actions.jsonl",
      "dopamine.js",
      "healthz",
      "d",
    ].includes(parts[0]!.toLowerCase())
  )
    throw new Error("Published files cannot replace a reserved hub route");
  return name;
}

async function uploadFiles(path: string, page: boolean): Promise<Upload[]> {
  let rootInfo;
  try {
    rootInfo = await lstat(path);
  } catch {
    throw new Error("Cannot read upload source");
  }
  if (rootInfo.isSymbolicLink()) throw new Error("Upload symlinks are not allowed");
  if (!rootInfo.isDirectory()) {
    const body = await fileBytes(path);
    return [{ name: page ? "index.html" : safeName(basename(path), false), body }];
  }
  if (!page) throw new Error("Attachments must be regular files");
  const files: Upload[] = [];
  let size = 0;
  let entries = 0;
  async function walk(folder: string, prefix: string): Promise<void> {
    let children;
    try {
      children = await readdir(folder, { withFileTypes: true });
    } catch {
      throw new Error("Cannot read upload directory");
    }
    /* eslint-disable no-await-in-loop -- Walk sequentially to enforce the cumulative upload budget. */
    for (const child of children.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > MAX_FILES) throw new Error("Upload contains too many files or directories");
      const name = safeName(`${prefix}${child.name}`, true);
      const source = join(folder, child.name);
      if (child.isSymbolicLink()) throw new Error("Upload symlinks are not allowed");
      if (child.isDirectory()) await walk(source, `${name}/`);
      else if (child.isFile()) {
        const body = await fileBytes(source, MAX_UPLOAD - size);
        size += body.length;
        files.push({ name, body });
      } else throw new Error("Upload contains a nonregular file");
    }
    /* eslint-enable no-await-in-loop */
  }
  await walk(path, "");
  if (!files.some((file) => file.name === "index.html"))
    throw new Error("Published folders need index.html");
  return files;
}

function tar(files: Upload[]): Buffer {
  const chunks: Buffer[] = [];
  let size = 1024;
  for (const file of files) {
    const header = Buffer.alloc(512);
    const parts = file.name.split("/");
    let name = parts.pop()!;
    let prefix = parts.join("/");
    while (Buffer.byteLength(prefix) > 155 && parts.length) {
      name = `${parts.pop()!}/${name}`;
      prefix = parts.join("/");
    }
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
      throw new Error("Upload name is too long for transport");
    header.write(name, 0, 100, "utf8");
    header.write("0000600\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${file.body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write(prefix, 345, 155, "utf8");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    const padding = Buffer.alloc((512 - (file.body.length % 512)) % 512);
    size += 512 + file.body.length + padding.length;
    if (size > MAX_BODY) throw new Error("Archive exceeds the size limit");
    chunks.push(header, file.body, padding);
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

function tarField(header: Buffer, start: number, length: number): string {
  return header
    .subarray(start, start + length)
    .toString("utf8")
    .split("\0")[0]!;
}

function untar(archive: Buffer, page: boolean): Upload[] {
  const files: Upload[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let size = 0;
  let entries = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (archive.length - offset < 1024 || !archive.subarray(offset).every((byte) => byte === 0))
        throw new Error("Invalid archive terminator");
      const names = new Set(files.map((file) => file.name));
      for (const file of files) {
        const parts = file.name.split("/");
        parts.pop();
        while (parts.length) {
          if (names.has(parts.join("/"))) throw new Error("Archive paths conflict");
          parts.pop();
        }
      }
      if (page && !names.has("index.html")) throw new Error("Published archives need index.html");
      if (!page && (files.length !== 1 || files[0]!.name.includes("/")))
        throw new Error("Attachment archive must contain one file");
      return files;
    }
    if (++entries > MAX_FILES) throw new Error("Archive contains too many entries");
    const checksum = tarField(header, 148, 8).trim();
    const expected = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (
      !/^[0-7]+$/.test(checksum) ||
      Number.parseInt(checksum, 8) !== expected ||
      tarField(header, 257, 6) !== "ustar"
    )
      throw new Error("Invalid archive header");
    const type = header[156];
    if (type !== 0 && type !== 48 && type !== 53)
      throw new Error("Archive links and special files are not allowed");
    if (tarField(header, 157, 100)) throw new Error("Archive links are not allowed");
    const prefix = tarField(header, 345, 155);
    const rawName = `${prefix ? `${prefix}/` : ""}${tarField(header, 0, 100)}`;
    const name = safeName(type === 53 ? rawName.replace(/\/$/, "") : rawName, page);
    if (seen.has(name)) throw new Error("Archive contains duplicate names");
    seen.add(name);
    const octal = tarField(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(octal)) throw new Error("Invalid archive size");
    const length = Number.parseInt(octal, 8);
    if (!Number.isSafeInteger(length) || length > MAX_UPLOAD || (type === 53 && length !== 0))
      throw new Error("Invalid archive size");
    const end = offset + 512 + length;
    const next = offset + 512 + Math.ceil(length / 512) * 512;
    if (next > archive.length) throw new Error("Truncated archive");
    size += length;
    if (size > MAX_UPLOAD) throw new Error("Archive exceeds the size limit");
    if (type !== 53) files.push({ name, body: archive.subarray(offset + 512, end) });
    offset = next;
  }
  throw new Error("Truncated archive");
}

async function receiveUpload(options: ClientOptions, page: boolean): Promise<Upload[]> {
  const files = untar(await bounded(options.stdin ?? process.stdin, MAX_BODY), page);
  const temporary = await mkdtemp(join(tmpdir(), "dopamine-upload-"));
  try {
    /* eslint-disable no-await-in-loop -- Materialize validated files in order within the private temporary directory. */
    for (const file of files) {
      const destination = join(temporary, file.name);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.body, { flag: "wx", mode: 0o600 });
    }
    /* eslint-enable no-await-in-loop */
    if (page) return await uploadFiles(temporary, true);
    return await uploadFiles(join(temporary, files[0]!.name), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function quote(arg: string): string {
  if (arg.includes("\0")) throw new Error("Invalid remote argument");
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

async function remoteCommand(
  ctx: Context,
  remote: NonNullable<HubConfig["remotes"]>[string],
  args: string[],
  input: Buffer,
): Promise<string> {
  if (
    !remote.host ||
    remote.host.startsWith("-") ||
    /\s/.test(remote.host) ||
    controlCharacters(remote.host) ||
    !remote.dash ||
    remote.dash.startsWith("-")
  )
    throw new Error("Invalid remote configuration");
  if (input.length > MAX_BODY) throw new Error("Input exceeds the size limit");
  const command = [
    remote.dash,
    ...(remote.config ? ["--config", remote.config] : []),
    ...(ctx.identity ? ["--as", ctx.identity] : []),
    ...args,
  ]
    .map(quote)
    .join(" ");
  return await new Promise<string>((resolveResult, reject) => {
    const child = spawn(
      ctx.options.sshExecutable ?? "ssh",
      ["-T", "-o", "BatchMode=yes", "--", remote.host, command],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const output = bounded(child.stdout, MAX_BODY);
    const errors = bounded(child.stderr, MAX_BODY);
    output.catch(() => {
      child.kill();
    });
    errors.catch(() => {
      child.kill();
    });
    child.on("error", () => reject(new Error("Could not start SSH for the configured remote")));
    child.stdin.on("error", () => {
      /* SSH exit reports a closed input pipe. */
    });
    child.stdin.end(input);
    child.on("close", (code) => {
      void Promise.all([output, errors]).then(([stdout, stderr]) => {
        if (code !== 0)
          reject(
            new Error(
              `Remote dash failed${stderr.length ? `: ${stderr.toString("utf8").trim()}` : ""}`,
            ),
          );
        else resolveResult(stdout.toString("utf8").trimEnd());
      }, reject);
    });
  });
}

function resultUrl(ctx: Context, result: unknown, id: string): string {
  const record = object(result, "Hub response");
  const key = typeof record.key === "string" ? record.key : `${id}--${ctx.config.machine}`;
  return shellUrl(ctx.config, key);
}

function revision(result: unknown): string {
  const rev = object(result, "Hub response").rev;
  if (!Number.isSafeInteger(rev) || Number(rev) < 0)
    throw new Error("Hub returned an invalid revision");
  return String(rev);
}

export async function runDash(argv: string[], options: ClientOptions = {}): Promise<string> {
  const parsed = parse(argv);
  if (parsed.flags.has("help")) return HELP;
  if (parsed.command === "action") throw new Error("Dashboard actions are unavailable in phase 1a");
  const allowed = FLAGS[parsed.command];
  if (!allowed) throw new Error("Unknown command; run dash --help");
  for (const flag of parsed.flags.keys())
    if (!["config", "as", ...allowed].includes(flag))
      throw new Error(`Option --${flag} is not valid for ${parsed.command}`);
  const counts: Record<string, number> = {
    create: 1,
    publish: 2,
    post: 3,
    "set-collection": 2,
    attach: 2,
    list: 0,
    show: 1,
    url: 1,
    remove: 1,
    restore: 1,
    "update-manifest": 1,
  };
  if (parsed.args.length !== counts[parsed.command])
    throw new Error(`Invalid arguments for ${parsed.command}; run dash --help`);
  const env = options.env ?? process.env;
  const configPath = stringFlag(parsed, "config") ?? env.DOPAMINE_CONFIG;
  if (!configPath)
    throw new Error("Set DOPAMINE_CONFIG or pass --config with a private configuration file");
  let config;
  try {
    config = await readConfig(configPath);
  } catch {
    throw new Error("Cannot read private configuration; check --config or DOPAMINE_CONFIG");
  }
  const write = !["list", "show", "url"].includes(parsed.command);
  const ctx: Context = {
    config,
    options,
    parsed,
    ...(write ? { identity: identity(config, parsed, env) } : {}),
  };
  if (parsed.command === "list") {
    const result = object(await hubRequest(ctx, "/api/list"), "Hub response");
    if (!Array.isArray(result.dashboards))
      throw new Error("Hub returned an invalid dashboard list");
    if (parsed.flags.has("json")) return JSON.stringify(result);
    return result.dashboards.length
      ? result.dashboards
          .map((value: unknown) => {
            const record = object(value, "Dashboard");
            const manifest = object(record.manifest, "Manifest");
            return `${config.machine}/${String(manifest.id)}\t${JSON.stringify(manifest.title)}\t${resultUrl(ctx, record, String(manifest.id))}`;
          })
          .join(" | ")
      : "No dashboards";
  }
  const { id, remote } = target(config, parsed.args[0]!);
  if (parsed.command === "url")
    return shellUrl(
      config,
      `${id}--${parsed.args[0]!.includes("/") ? parsed.args[0]!.split("/")[0]! : config.machine}`,
    );
  const route = `/api/write/${encodeURIComponent(id)}`;
  const command = parsed.command;
  if (command === "show") {
    if (remote) return await remoteCommand(ctx, remote, ["show", id], Buffer.alloc(0));
    return JSON.stringify(await hubRequest(ctx, `/api/dashboard/${encodeURIComponent(id)}`));
  }
  if (command === "publish" || command === "attach") {
    const receive = parsed.flags.has("receive-tar");
    if (receive && (remote || parsed.args[1] !== "-"))
      throw new Error("Archive input must target a local dashboard and use -");
    const files = receive
      ? await receiveUpload(options, command === "publish")
      : await uploadFiles(resolve(parsed.args[1]!), command === "publish");
    if (remote)
      return await remoteCommand(ctx, remote, [command, id, "-", "--receive-tar"], tar(files));
    const body =
      command === "publish"
        ? {
            files: Object.fromEntries(
              files.map((file) => [file.name, file.body.toString("base64")]),
            ),
          }
        : { name: files[0]!.name, body: files[0]!.body.toString("base64") };
    return resultUrl(ctx, await hubRequest(ctx, `${route}/${command}`, body), id);
  }
  let body: JsonObject;
  if (command === "create" || command === "update-manifest") {
    body = await manifestInput(ctx);
    if (command === "create") body.id = id;
  } else if (command === "post") {
    if (parsed.flags.has("before") && parsed.flags.has("at-end"))
      throw new Error("Choose --before or --at-end");
    const deleting = parsed.flags.has("delete");
    if (deleting && (parsed.flags.has("json") || parsed.flags.has("file")))
      throw new Error("Delete does not take a value");
    body = { collection: parsed.args[1], key: parsed.args[2] };
    if (deleting) body.delete = true;
    else body.value = await readJsonInput(parsed, options);
    if (parsed.flags.has("before")) body.before = stringFlag(parsed, "before");
    if (parsed.flags.has("at-end")) body.atEnd = true;
  } else if (command === "set-collection") {
    const input = object(await readJsonInput(parsed, options), "Collection");
    if (
      !Array.isArray(input.order) ||
      !input.items ||
      typeof input.items !== "object" ||
      Array.isArray(input.items)
    )
      throw new Error("Collection needs order and items");
    body = { collection: parsed.args[1], order: input.order, items: input.items };
  } else body = command === "remove" ? { force: parsed.flags.has("force") } : {};
  if (remote) {
    if (command === "post") {
      const args = [command, id, parsed.args[1]!, parsed.args[2]!];
      if (body.delete) args.push("--delete");
      else args.push("--file", "-");
      if (body.before !== undefined) args.push("--before", String(body.before));
      if (body.atEnd) args.push("--at-end");
      return await remoteCommand(
        ctx,
        remote,
        args,
        body.delete ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body.value)),
      );
    }
    if (command === "set-collection")
      return await remoteCommand(
        ctx,
        remote,
        [command, id, parsed.args[1]!, "--file", "-"],
        Buffer.from(JSON.stringify({ order: body.order, items: body.items })),
      );
    if (command === "create") {
      const args = [command, id, "--file", "-"];
      if (parsed.flags.has("from-starter")) args.push("--from-starter");
      return await remoteCommand(ctx, remote, args, Buffer.from(JSON.stringify(body)));
    }
    if (command === "update-manifest")
      return await remoteCommand(
        ctx,
        remote,
        [command, id, "--file", "-"],
        Buffer.from(JSON.stringify(body)),
      );
    return await remoteCommand(
      ctx,
      remote,
      [command, id, ...(body.force ? ["--force"] : [])],
      Buffer.alloc(0),
    );
  }
  let starter: Upload[] | undefined;
  if (command === "create" && parsed.flags.has("from-starter"))
    starter = await uploadFiles(fileURLToPath(new URL("../starter/", import.meta.url)), true);
  let result: unknown;
  try {
    result = await hubRequest(
      ctx,
      command === "create"
        ? "/api/write/create"
        : `${route}/${command === "update-manifest" ? "manifest" : command}`,
      body,
    );
  } catch (error) {
    if (command === "create" && error instanceof HubResponseError && error.status === 409)
      throw new Error(`Dashboard already exists: ${shellUrl(config, `${id}--${config.machine}`)}`, {
        cause: error,
      });
    throw error;
  }
  if (starter) {
    try {
      await hubRequest(ctx, `${route}/publish`, {
        files: Object.fromEntries(starter.map((file) => [file.name, file.body.toString("base64")])),
      });
    } catch {
      throw new Error(
        `Dashboard was created, but starter publishing failed; retry dash publish for ${id}`,
      );
    }
  }
  if (command === "post" || command === "set-collection") return revision(result);
  if (command === "remove") return "removed";
  return resultUrl(ctx, result, id);
}
