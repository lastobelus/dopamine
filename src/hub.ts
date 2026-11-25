import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DashboardStore } from "./store.ts";
import { HttpError, isPull } from "./model.ts";
import type { DashboardRecord, Handler, JsonValue } from "./model.ts";
import type { HubConfig } from "./config.ts";
import {
  dashboardOrigin,
  readSecret,
  shellUrl,
  threadEnvironment,
  validateConfig,
} from "./config.ts";
import { ActionStore, publicRequest } from "./actions.ts";
import type { ActionRequest } from "./actions.ts";
import { Delivery, remoteWord } from "./delivery.ts";
import type { DeliveryOptions } from "./delivery.ts";

const execute = promisify(execFile);
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const limit = 32 * 1024 * 1024;
const clickLimit = 32 * 1024;
const pollIdleMs = 24 * 60 * 60 * 1000;
const projectIconLimit = 128 * 1024;
const projectIconTypes = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);
const projectIconRoute = "/api/project-icon/";
const webRoot = new URL("../web/", import.meta.url);
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};
interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
interface ProjectReference {
  id: string;
  title: string;
}
type ProjectSummary = ProjectReference & { iconUrl?: string };
interface ThreadState {
  state: string;
  project: ProjectReference | null;
}
interface Summary extends DashboardRecord {
  key: string;
  url: string;
  origin: string;
  status: string;
  ownerThreadUrl: string | null;
  ownerState: string;
  project: ProjectSummary | null;
  handlerState: string;
  pendingAnswers: { collection: string; key: string }[];
  frameAllowed: boolean;
}
/** A request as its handler sees it, with the snapshot it acts on. */
function fullRequest(request: ActionRequest, now: number) {
  return {
    ...publicRequest(request, now),
    dashboard: request.dashboard,
    handler: request.handler,
    snapshot: request.snapshot,
  };
}
function sameSecret(actual: string | undefined, expected: string): boolean {
  const a = Buffer.from(actual ?? ""),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function originFingerprint(config: HubConfig): string {
  const origins = Object.entries(config.dashboardOrigins ?? {}).toSorted();
  return createHash("sha256")
    .update(JSON.stringify([config.viewingOrigin, config.dashboardDomain, origins]))
    .digest("hex");
}
function keyParts(key: string): { id: string; machine: string } {
  const [id, machine, extra] = key.split("--");
  if (!id || !machine || extra || !slug.test(id) || !slug.test(machine))
    throw new HttpError(400, "Invalid dashboard key");
  return { id, machine };
}
function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
function originGuard(req: IncomingMessage, expected: string, changing: boolean): void {
  const origin = req.headers.origin;
  if ((changing || origin !== undefined) && origin !== expected)
    throw new HttpError(403, "Origin refused");
  if (changing && req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
    throw new HttpError(415, "Use application/json");
}
async function body(req: IncomingMessage, maximum = limit): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maximum) throw new HttpError(413, "Request is too large");
    chunks.push(bytes);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Expected a JSON object");
  }
}
function call(
  url: URL,
  method = "GET",
  headers: Record<string, string> = {},
  bytes?: Buffer,
  timeout = 5000,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) req.destroy(new Error("Peer response is too large"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 502,
            headers: Object.fromEntries(
              Object.entries(res.headers).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            ),
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error("Peer deadline exceeded")));
    req.on("error", reject);
    req.end(bytes);
  });
}
function safePath(raw: string): string {
  if (!raw.startsWith("/") || raw.startsWith("//"))
    throw new HttpError(400, "Invalid request target");
  let path: string;
  try {
    path = decodeURIComponent(raw.split("?")[0] ?? "/");
  } catch {
    throw new HttpError(400, "Invalid path");
  }
  if (
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((p) => p === "." || p === "..")
  )
    throw new HttpError(400, "Invalid path");
  return path;
}
function pagePolicy(config: HubConfig): string {
  return `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors ${config.viewingOrigin}`;
}
function canAttemptFrame(headers: Reply["headers"], target: URL, viewingOrigin: string): boolean {
  const ancestors = headers["content-security-policy"]?.match(
    /(?:^|[;,])\s*frame-ancestors(?:\s+([^;,]*))?(?=[;,]|$)/i,
  );
  if (!ancestors) {
    const option = headers["x-frame-options"]?.trim().toUpperCase();
    return option !== "DENY" && (option !== "SAMEORIGIN" || target.origin === viewingOrigin);
  }

  // Only preempt a frame when the simple policy clearly denies the shell.
  // The browser handles broader CSP expressions and any additional policies.
  return (ancestors[1] ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .some((source) => {
      if (source.toLowerCase() === "'none'") return false;
      const allowed =
        source.toLowerCase() === "'self'"
          ? target
          : /^https?:\/\/[a-z\d.-]+(?::\d+)?\/?$/i.test(source)
            ? URL.parse(source)
            : null;
      return !allowed || allowed.origin === viewingOrigin;
    });
}
const projectText = (text: unknown): text is string =>
  typeof text === "string" && text.trim().length > 0 && text.length <= 200;
function projectReference(value: unknown): ProjectReference | null {
  if (!value || typeof value !== "object") return null;
  const { id, title } = value as { id?: unknown; title?: unknown };
  return projectText(id) && projectText(title) ? { id, title } : null;
}
function projectSummary(value: unknown, iconUrl?: string): ProjectSummary | null {
  const project = projectReference(value);
  return project && iconUrl ? { ...project, iconUrl } : project;
}

async function readProjectIcon(command: string[], projectId: string) {
  try {
    const { stdout } = await execute(command[0]!, [...command.slice(1), projectId, "--json"], {
      timeout: 8000,
      maxBuffer: Math.ceil(projectIconLimit / 3) * 4 + 1024,
    });
    const icon = JSON.parse(stdout) as { mediaType?: unknown; base64?: unknown } | null;
    if (
      typeof icon?.mediaType !== "string" ||
      !projectIconTypes.has(icon.mediaType) ||
      typeof icon.base64 !== "string"
    )
      return null;
    const bytes = Buffer.from(icon.base64, "base64");
    if (
      !bytes.length ||
      bytes.length > projectIconLimit ||
      bytes.toString("base64") !== icon.base64
    )
      return null;
    return { mediaType: icon.mediaType, bytes };
  } catch {
    return null;
  }
}

async function threadState(
  config: HubConfig,
  owner: Handler | null,
  remote?: { ssh: string },
): Promise<ThreadState> {
  const unknown = { state: "unknown", project: null };
  if (!owner || isPull(owner)) return unknown;
  const environment = threadEnvironment(config, owner.environmentId);
  // Index summaries read only this machine's threads; accepting a click may ask over SSH.
  if (!environment || (environment.host && !remote)) return unknown;
  const command = [...environment.threadCommand, "read", owner.threadId, "--json"];
  try {
    const { stdout } = environment.host
      ? await execute(
          remote!.ssh,
          [
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=5",
            "--",
            environment.host,
            command.map(remoteWord).join(" "),
          ],
          { timeout: 10_000, maxBuffer: 1024 * 1024 },
        )
      : await execute(command[0]!, command.slice(1), { timeout: 1000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout) as {
      thread?: { archived?: boolean };
      archived?: boolean;
      project?: unknown;
    };
    return {
      state: (result.thread?.archived ?? result.archived) ? "archived" : "available",
      project: projectReference(result.project),
    };
  } catch {
    return unknown;
  }
}

export async function startHub(
  input: HubConfig,
  options: DeliveryOptions = {},
): Promise<{
  config: HubConfig;
  store: DashboardStore;
  actions: ActionStore;
  delivery: Delivery;
  server: Server;
  port: number;
  close: () => Promise<void>;
}> {
  const config = validateConfig({ ...input });
  const store = new DashboardStore(config.dataRoot, config.machine);
  await store.initialize();
  const now = options.now ?? Date.now;
  const actions = new ActionStore(store, now);
  const delivery = new Delivery(config, actions, options);
  const token = await readSecret(config.tokenFile);
  const peerSecret = config.peerCredentialFile ? await readSecret(config.peerCredentialFile) : "";
  let commit = config.sourceCommit ?? "development";
  try {
    commit = (
      JSON.parse(await readFile(new URL("../deployment.json", import.meta.url), "utf8")) as {
        sourceCommit: string;
      }
    ).sourceCommit;
  } catch {
    /* A source checkout has no deployment receipt. */
  }
  async function peerReady(): Promise<void> {
    if (!config.peer) throw new HttpError(503, "Peer is not configured");
    try {
      const result = await call(new URL("/healthz", config.peer.origin), "GET", {
        host: config.peer.host,
      });
      const health = JSON.parse(result.body.toString()) as {
        machine: string;
        hubId: string;
        originFingerprint: string;
      };
      if (
        result.status !== 200 ||
        health.machine !== config.peer.machine ||
        health.hubId !== config.peer.hubId ||
        health.originFingerprint !== originFingerprint(config)
      )
        throw new Error();
    } catch {
      throw new HttpError(503, "Peer is unreachable");
    }
  }
  async function probeUrl(address: string): Promise<{ status: string; frameAllowed: boolean }> {
    const registered = new URL(address);
    try {
      const request = (target: URL) => {
        const probe = new URL(target);
        probe.hostname = "127.0.0.1";
        return call(probe, "GET", { host: registered.host }, undefined, 1000);
      };
      let target = registered;
      let result = await request(target);
      for (let redirects = 0; [301, 302, 303, 307, 308].includes(result.status); redirects++) {
        const location = result.headers.location;
        if (!location) break;
        const next = new URL(location, target);
        // Keep the probe on the configured origin and its existing loopback listener.
        if (next.origin !== registered.origin || next.username || next.password) break;
        if (redirects === 3) return { status: "unreachable", frameAllowed: true };
        target = next;
        // eslint-disable-next-line no-await-in-loop -- Each response determines the next URL.
        result = await request(target);
      }
      return {
        status: result.status < 400 ? "reachable" : "unreachable",
        frameAllowed: canAttemptFrame(result.headers, target, config.viewingOrigin),
      };
    } catch {
      return { status: "unreachable", frameAllowed: true };
    }
  }
  async function summary(record: DashboardRecord): Promise<Summary> {
    const key = `${record.manifest.id}--${record.manifest.machine}`;
    const manifest = { ...record.manifest };
    const owner = manifest.owner;
    const { state: ownerState, project } = await threadState(config, owner);
    const handler = record.manifest.handler;
    let { state: handlerState } = await threadState(config, handler);
    if (handler && isPull(handler)) {
      const last = actions.lastPoll(record.manifest.id, handler.name);
      handlerState = last && now() - last < pollIdleMs ? "polling" : "not polling";
    }
    const pendingAnswers: Summary["pendingAnswers"] = [];
    try {
      for (const request of (await actions.list(record.manifest.id)).requests) {
        const { collection, key: item } = request.target;
        if (
          item !== undefined &&
          record.manifest.collections[collection]?.type === "questions" &&
          request.transport !== "awaiting-confirmation" &&
          request.transport !== "abandoned" &&
          request.handling !== "abandoned"
        )
          pendingAnswers.push({ collection, key: item });
      }
    } catch {
      /* A dashboard removed meanwhile has no answers to show. */
    }
    let status =
      ownerState === "archived"
        ? "stale"
        : record.manifest.staleAfterMinutes > 0 &&
            Date.now() - Date.parse(record.updatedAt) > record.manifest.staleAfterMinutes * 60000
          ? "stale"
          : "fresh";
    let frameAllowed = true;
    if (manifest.kind === "url") {
      manifest.url = config.urlOverrides?.[key] ?? manifest.url!;
      ({ status, frameAllowed } = await probeUrl(manifest.url));
    }
    return {
      ...record,
      manifest,
      key,
      url: shellUrl(config, key),
      origin: dashboardOrigin(config, key),
      status,
      ownerThreadUrl: owner
        ? `t3-thread://v2/${encodeURIComponent(owner.environmentId)}/${encodeURIComponent(owner.threadId)}`
        : null,
      ownerState,
      handlerState,
      pendingAnswers,
      project: projectSummary(
        project,
        config.adapter?.projectIconCommand?.[0] && projectIconRoute + key,
      ),
      frameAllowed,
    };
  }
  async function localList(): Promise<Summary[]> {
    return Promise.all((await store.list()).map(summary));
  }
  async function combined(): Promise<{
    dashboards: Summary[];
    peer: { machine: string; reachable: boolean } | null;
  }> {
    const dashboards = await localList();
    let peer: { machine: string; reachable: boolean } | null = null;
    if (config.peer) {
      peer = { machine: config.peer.machine, reachable: false };
      try {
        await peerReady();
        const response = await call(new URL("/api/list", config.peer.origin), "GET", {
          "x-dopamine-peer": peerSecret,
          host: config.peer.host,
        });
        const result = JSON.parse(response.body.toString()) as { dashboards: Summary[] };
        if (response.status !== 200 || !Array.isArray(result.dashboards)) throw new Error();
        const remote = await Promise.all(
          result.dashboards.map(async (item) => {
            if (item.manifest.machine !== config.peer!.machine) throw new Error();
            item.key = `${item.manifest.id}--${item.manifest.machine}`;
            keyParts(item.key);
            item.url = shellUrl(config, item.key);
            item.origin = dashboardOrigin(config, item.key);
            // Each hub resolves its own owners' projects; an older peer sends none.
            const iconUrl = projectIconRoute + item.key;
            item.project = projectSummary(
              item.project,
              item.project?.iconUrl === iconUrl ? iconUrl : undefined,
            );
            if (item.manifest.kind === "url") {
              item.manifest.url = config.urlOverrides?.[item.key] ?? item.manifest.url!;
              Object.assign(item, await probeUrl(item.manifest.url));
            }
            return item;
          }),
        );
        dashboards.push(...remote);
        peer.reachable = true;
      } catch {
        /* Show the unreachable peer explicitly; never pretend it is empty. */
      }
    }
    dashboards.sort(
      (a, b) =>
        Number(b.manifest.pinned) - Number(a.manifest.pinned) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
    return { dashboards, peer };
  }
  async function projectIcon(path: string, peerAuthenticated: boolean) {
    const { id, machine } = keyParts(path.slice(projectIconRoute.length));
    if (machine !== config.machine) {
      if (peerAuthenticated || machine !== config.peer?.machine)
        throw new HttpError(404, "Project icon unavailable");
      await peerReady();
      const response = await call(
        new URL(path, config.peer.origin),
        "GET",
        { host: config.peer.host, "x-dopamine-peer": peerSecret },
        undefined,
        10000,
      );
      const mediaType = response.headers["content-type"];
      if (
        response.status !== 200 ||
        !mediaType ||
        !projectIconTypes.has(mediaType) ||
        !response.body.length ||
        response.body.length > projectIconLimit
      )
        throw new HttpError(404, "Project icon unavailable");
      return { mediaType, bytes: response.body };
    }
    const command = config.adapter?.projectIconCommand;
    if (!command?.[0]) throw new HttpError(404, "Project icon unavailable");
    const { manifest } = await store.get(id);
    const { project } = await threadState(config, manifest.owner);
    if (!project || project.id.startsWith("-"))
      throw new HttpError(404, "Project icon unavailable");
    const icon = await readProjectIcon(command, project.id);
    if (!icon) throw new HttpError(404, "Project icon unavailable");
    return icon;
  }
  async function handlerAvailable(handler: Handler): Promise<boolean> {
    if (isPull(handler)) return true;
    if (!threadEnvironment(config, handler.environmentId)) return false;
    const { state } = await threadState(config, handler, { ssh: options.ssh ?? "ssh" });
    return state !== "archived";
  }
  async function actionCommand(
    id: string,
    operation: string,
    payload: Record<string, unknown>,
    by: string,
  ) {
    const pull = payload.handler === undefined ? undefined : String(payload.handler);
    const claimant = pull === undefined ? by : `pull:${pull}`;
    switch (operation) {
      case "next": {
        if (pull === undefined || !slug.test(pull))
          throw new HttpError(400, "Name the pull handler");
        const request = await actions.next(id, pull);
        return { request: request && fullRequest(request, now()) };
      }
      case "claim":
        return fullRequest(await actions.claim(id, String(payload.requestId), claimant), now());
      case "ack": {
        const { requestId, handler: _handler, ...result } = payload;
        return fullRequest(await actions.ack(id, String(requestId), claimant, result), now());
      }
      case "show": {
        const { requests, damaged } = await actions.list(id);
        const chosen =
          payload.requestId === undefined
            ? requests
            : requests.filter((request) => request.requestId === payload.requestId);
        if (payload.requestId !== undefined && !chosen.length)
          throw new HttpError(404, "Action request not found");
        return { requests: chosen.map((request) => fullRequest(request, now())), damaged };
      }
      case "repair":
        return await actions.repair(id, by);
      default:
        throw new HttpError(404, "Route not found");
    }
  }
  /** The shell's confirmation: read the stored request, or Confirm or Cancel it. */
  async function confirm(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    requestId: string,
    peerRoute: boolean,
  ): Promise<void> {
    if (!["GET", "POST"].includes(req.method ?? "")) throw new HttpError(405, "Method refused");
    const parts = keyParts(key);
    if (parts.machine !== config.machine) {
      if (peerRoute || parts.machine !== config.peer?.machine)
        throw new HttpError(404, "Dashboard is on another hub");
      await peerReady();
      const forwarded =
        req.method === "POST" ? Buffer.from(JSON.stringify(await body(req, 1024))) : undefined;
      const response = await call(
        new URL(`/api/peer/confirm/${encodeURIComponent(key)}/${requestId}`, config.peer.origin),
        req.method,
        {
          "x-dopamine-peer": peerSecret,
          host: config.peer.host,
          origin: config.viewingOrigin,
          ...(forwarded ? { "content-type": "application/json" } : {}),
        },
        forwarded,
      );
      res.writeHead(response.status, { "content-type": "application/json; charset=utf-8" });
      res.end(response.body);
      return;
    }
    if (req.method === "POST") {
      const { decision } = await body(req, 1024);
      const request = await actions.decide(parts.id, requestId, decision, "reader");
      delivery.wake();
      return json(res, { request: publicRequest(request, now()) });
    }
    const record = await store.get(parts.id);
    const request = (await actions.list(parts.id)).requests.find(
      (candidate) => candidate.requestId === requestId && candidate.dashboard === key,
    );
    if (!request) throw new HttpError(404, "Action request not found");
    const snapshot = request.snapshot as { value?: { title?: unknown } } | null;
    const handler = request.handler;
    return json(res, {
      request: publicRequest(request, now()),
      dashboard: { key, title: record.manifest.title, machine: record.manifest.machine },
      item:
        typeof snapshot?.value?.title === "string"
          ? snapshot.value.title
          : (request.target.key ?? null),
      handler: isPull(handler)
        ? `pull handler ${handler.name}`
        : (handler.title ?? `thread ${handler.threadId}`),
    });
  }
  async function proxy(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    path: string,
  ): Promise<void> {
    const { machine } = keyParts(key);
    if (machine !== config.peer?.machine) throw new HttpError(404, "Dashboard is on another hub");
    const changing = req.method !== "GET" && req.method !== "HEAD";
    originGuard(req, dashboardOrigin(config, key), changing);
    const writable: Record<string, string> = {
      "/api/view": "PUT",
      "/api/act": "POST",
      "/api/request": "POST",
    };
    if (
      path.startsWith("/api/") &&
      !["/api/view", "/api/actions", ...Object.keys(writable)].includes(path)
    )
      throw new HttpError(404, "Route not found");
    if (
      !["GET", "HEAD", "PUT", "POST"].includes(req.method ?? "") ||
      (changing && writable[path] !== req.method)
    )
      throw new HttpError(405, "Method refused");
    await peerReady();
    const bytes = changing
      ? Buffer.from(JSON.stringify(await body(req, path === "/api/view" ? limit : clickLimit)))
      : undefined;
    const headers: Record<string, string> = {
      host: config.peer!.host,
      "x-dopamine-peer": peerSecret,
      "x-dopamine-key": key,
    };
    if (req.headers.origin) headers.origin = req.headers.origin;
    if (req.headers["if-none-match"]) headers["if-none-match"] = req.headers["if-none-match"];
    if (bytes) headers["content-type"] = "application/json";
    const target = new URL(config.peer!.origin);
    target.pathname = path;
    target.search = (req.url ?? "").includes("?")
      ? (req.url ?? "").slice((req.url ?? "").indexOf("?"))
      : "";
    const response = await call(target, req.method, headers, bytes);
    const returned: Record<string, string> = {};
    for (const header of [
      "content-type",
      "content-security-policy",
      "referrer-policy",
      "etag",
      "content-disposition",
      "cache-control",
    ])
      if (response.headers[header]) returned[header] = response.headers[header];
    res.writeHead(response.status, returned);
    res.end(req.method === "HEAD" ? undefined : response.body);
  }
  async function dashboard(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    path: string,
    forwarded: boolean,
  ): Promise<void> {
    const parts = keyParts(key);
    originGuard(req, dashboardOrigin(config, key), !["GET", "HEAD"].includes(req.method ?? ""));
    const address = new URL(req.url ?? "/", dashboardOrigin(config, key));
    const pageRoute =
      !path.startsWith("/api/") &&
      !path.startsWith("/files/") &&
      !["/data.json", "/dopamine.js", "/dopamine-meta.json", "/healthz"].includes(path);
    if (
      !forwarded &&
      req.method === "GET" &&
      pageRoute &&
      req.headers["sec-fetch-dest"] === "document" &&
      address.searchParams.get("dopamine-direct") !== "1"
    ) {
      const shell = new URL(shellUrl(config, key));
      if (path !== "/") shell.searchParams.set("dopamine-path", path);
      for (const [name, value] of address.searchParams) shell.searchParams.append(name, value);
      res.writeHead(302, { location: shell.href });
      res.end();
      return;
    }
    if (parts.machine !== config.machine) return proxy(req, res, key, path);
    const record = await store.get(parts.id);
    if (path === "/api/view") {
      if (req.method === "GET") return json(res, await store.getView(parts.id));
      if (req.method === "PUT") {
        const value = await body(req);
        await store.putView(parts.id, value as JsonValue);
        return json(res, { saved: true });
      }
      throw new HttpError(405, "Method refused");
    }
    if (path === "/api/act") {
      if (req.method !== "POST") throw new HttpError(405, "Method refused");
      const { request, existing } = await actions.accept(
        parts.id,
        await body(req, clickLimit),
        handlerAvailable,
      );
      if (!existing) delivery.wake();
      return json(res, { request: publicRequest(request, now()) }, existing ? 200 : 202);
    }
    if (path === "/api/request") {
      if (req.method !== "POST") throw new HttpError(405, "Method refused");
      const choice = await body(req, clickLimit);
      const request = await actions.choose(
        parts.id,
        String(choice.requestId),
        choice.choice,
        "reader",
      );
      delivery.wake();
      return json(res, { request: publicRequest(request, now()) });
    }
    if (path === "/api/actions") {
      if (req.method !== "GET") throw new HttpError(405, "Method refused");
      const filter: { collection?: string; key?: string } = {};
      for (const name of ["collection", "key"] as const) {
        const value = address.searchParams.get(name);
        if (value !== null) filter[name] = value;
      }
      const { requests, damaged } = await actions.list(parts.id, filter);
      return json(res, {
        requests: requests.map((request) => publicRequest(request, now())),
        damaged,
      });
    }
    if (!["GET", "HEAD"].includes(req.method ?? "")) throw new HttpError(405, "Method refused");
    if (path.startsWith("/api/")) throw new HttpError(404, "Route not found");
    if (path === "/data.json") {
      const etag = `"${record.data.rev}"`;
      res.setHeader("etag", etag);
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      return json(res, record.data);
    }
    if (path === "/dopamine-meta.json")
      return json(res, { ...(await summary(record)), shell: shellUrl(config, key) });
    if (path === "/dopamine.js") {
      res.setHeader("content-type", mime[".js"]!);
      res.end(await readFile(new URL("dopamine.js", webRoot)));
      return;
    }
    if (path.startsWith("/files/")) {
      const name = path.slice(7);
      res.setHeader("content-security-policy", "sandbox");
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.end(await store.readAttachment(parts.id, name));
      return;
    }
    if (record.manifest.kind !== "page")
      throw new HttpError(404, "Open this dashboard through its shell");
    res.setHeader("content-security-policy", pagePolicy(config));
    const relative = path === "/" ? "index.html" : path.slice(1);
    res.setHeader("content-type", mime[extname(relative)] ?? "application/octet-stream");
    res.end(req.method === "HEAD" ? undefined : await store.readPage(parts.id, relative));
  }
  async function control(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    direct: boolean,
    peerAuthenticated: boolean,
  ): Promise<void> {
    if (path === "/healthz" && req.method === "GET")
      return json(res, {
        ok: true,
        machine: config.machine,
        hubId: config.hubId,
        originFingerprint: originFingerprint(config),
        sourceCommit: commit,
        schema: 2,
        processId: process.pid,
      });
    if (path.startsWith("/api/write/")) {
      if (
        !direct ||
        req.method !== "POST" ||
        !sameSecret(req.headers.authorization, `Bearer ${token}`)
      )
        throw new HttpError(403, "Write API refused");
      if (req.headers.origin) throw new HttpError(403, "Browser writes are refused");
      if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
        throw new HttpError(415, "Use application/json");
      const by = req.headers["x-dopamine-writer"];
      if (typeof by !== "string" || !by || by.length > 512)
        throw new HttpError(400, "Writer identity is required");
      const payload = await body(req);
      const route = path.slice("/api/write/".length).split("/");
      if (route[0] === "create" && route.length === 1)
        return json(res, await store.create(payload), 201);
      const [id, operation] = route;
      if (id && slug.test(id) && operation === "action" && route.length === 3)
        return json(res, await actionCommand(id, route[2]!, payload, by));
      if (!id || !slug.test(id) || route.length !== 2) throw new HttpError(404, "Route not found");
      switch (operation) {
        case "manifest":
          return json(res, await store.updateManifest(id, payload));
        case "post": {
          const { collection, key, ...value } = payload;
          if (typeof collection !== "string" || typeof key !== "string")
            throw new HttpError(400, "Collection and key are required");
          return json(res, await store.post(id, collection, key, value, by));
        }
        case "set-collection": {
          const { collection, ...value } = payload;
          if (typeof collection !== "string") throw new HttpError(400, "Collection is required");
          return json(res, await store.setCollection(id, collection, value, by));
        }
        case "publish":
          return json(res, await store.publish(id, payload.files as Record<string, string>));
        case "attach":
          return json(res, await store.attach(id, String(payload.name), payload.body as string));
        case "remove":
          await store.remove(id, payload.force === true, by);
          return json(res, { removed: true });
        case "restore":
          return json(res, await store.restore(id));
        default:
          throw new HttpError(404, "Route not found");
      }
    }
    originGuard(req, config.viewingOrigin, !["GET", "HEAD"].includes(req.method ?? ""));
    if ((path === "/api/remove" || path === "/api/peer/remove") && req.method === "POST") {
      if (path === "/api/peer/remove" && !peerAuthenticated)
        throw new HttpError(403, "Peer credential required");
      const payload = await body(req),
        key = String(payload.key);
      const parts = keyParts(key);
      if (parts.machine === config.machine) await store.remove(parts.id);
      else {
        await peerReady();
        if (parts.machine !== config.peer?.machine)
          throw new HttpError(404, "Dashboard is on another hub");
        const response = await call(
          new URL("/api/peer/remove", config.peer.origin),
          "POST",
          {
            "x-dopamine-peer": peerSecret,
            host: config.peer.host,
            origin: config.viewingOrigin,
            "content-type": "application/json",
          },
          Buffer.from(JSON.stringify({ key })),
        );
        if (response.status !== 200) throw new HttpError(response.status, "Peer refused removal");
      }
      return json(res, { removed: true });
    }
    const confirmation = /^\/api\/(peer\/)?confirm\/([^/]+)\/(r-[a-f0-9]{16})$/.exec(path);
    if (confirmation) {
      const [, peerRoute, key, requestId] = confirmation as unknown as [
        string,
        string,
        string,
        string,
      ];
      if (peerRoute && !peerAuthenticated) throw new HttpError(403, "Peer credential required");
      return confirm(req, res, key, requestId, Boolean(peerRoute));
    }
    if (req.method !== "GET") throw new HttpError(405, "Method refused");
    if (path.startsWith(projectIconRoute)) {
      const { mediaType, bytes } = await projectIcon(path, peerAuthenticated);
      res.writeHead(200, {
        "content-type": mediaType,
        "content-security-policy": "sandbox; default-src 'none'",
        "cache-control": "private, max-age=300",
      });
      res.end(bytes);
      return;
    }
    if (path === "/api/list") return json(res, { dashboards: await localList() });
    if (path === "/api/index")
      return json(res, {
        ...(await combined()),
        machine: config.machine,
        viewingOrigin: config.viewingOrigin,
        combined: Boolean(config.peer),
      });
    if (path.startsWith("/api/dashboard/")) return json(res, await store.get(path.slice(15)));
    if (path.startsWith("/api/shell/")) {
      const key = path.slice(11);
      keyParts(key);
      const { dashboards, peer } = await combined();
      const item = dashboards.find((d) => d.key === key);
      if (!item)
        throw new HttpError(
          peer?.reachable === false ? 503 : 404,
          peer?.reachable === false
            ? "Peer is unreachable"
            : "Dashboard is unavailable on this hub",
        );
      return json(res, item);
    }
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-src http: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (path === "/" || path.startsWith("/d/")) {
      if (path.startsWith("/d/")) keyParts(path.slice(3));
      res.setHeader("content-type", mime[".html"]!);
      res.end(await readFile(new URL(path === "/" ? "index.html" : "shell.html", webRoot)));
      return;
    }
    if (["/hub.js", "/shell.js", "/style.css", "/favicon.svg", "/favicon.ico"].includes(path)) {
      res.setHeader("content-type", mime[extname(path)]!);
      res.end(await readFile(fileURLToPath(new URL(path.slice(1), webRoot))));
      return;
    }
    throw new HttpError(404, "Route not found");
  }
  const server = createServer((req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-cache");
    void (async () => {
      const path = safePath(req.url ?? "/");
      const host = req.headers.host;
      if (!host || /[\s/@\\]/.test(host)) throw new HttpError(400, "Invalid Host");
      const addressed = new URL(`http://${host}`);
      if (addressed.host.toLowerCase() !== host.toLowerCase())
        throw new HttpError(400, "Invalid Host");
      const hostname = addressed.hostname.toLowerCase();
      const ownPort = addressed.port || "80";
      const allowedPort = [
        String(config.port),
        ...Object.values(config.dashboardOrigins ?? {}).map((o) => new URL(o).port || "80"),
      ].includes(ownPort);
      if (!allowedPort) throw new HttpError(403, "Host refused");
      const direct = ["127.0.0.1", "[::1]"].includes(hostname);
      const peerAuthenticated =
        direct &&
        Boolean(peerSecret) &&
        sameSecret(req.headers["x-dopamine-peer"] as string | undefined, peerSecret);
      const forwardedKey = req.headers["x-dopamine-key"];
      if (forwardedKey !== undefined && direct) {
        if (!peerAuthenticated || typeof forwardedKey !== "string")
          throw new HttpError(403, "Forwarded dashboard refused");
        if (keyParts(forwardedKey).machine !== config.machine)
          throw new HttpError(403, "Forwarded dashboard refused");
        return dashboard(req, res, forwardedKey, path, true);
      }
      const assigned = Object.entries(config.dashboardOrigins ?? {}).find(
        ([, origin]) => new URL(origin).host === host,
      )?.[0];
      const suffix = `.${config.dashboardDomain}`;
      const key =
        assigned ?? (hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : null);
      if (key) return dashboard(req, res, key, path, false);
      const viewing = new URL(config.viewingOrigin);
      if (host !== viewing.host && !direct && hostname !== "localhost")
        throw new HttpError(403, "Host refused");
      if (
        path === "/" &&
        req.method === "GET" &&
        req.headers["sec-fetch-dest"] === "document" &&
        host !== viewing.host &&
        !peerAuthenticated
      ) {
        res.writeHead(302, { location: config.viewingOrigin + (req.url ?? "/") });
        res.end();
        return;
      }
      return control(
        req,
        res,
        path,
        direct &&
          !req.headers["x-dopamine-peer"] &&
          !req.headers.forwarded &&
          !Object.keys(req.headers).some((name) => name.startsWith("x-forwarded-")),
        peerAuthenticated,
      );
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status =
        error instanceof HttpError
          ? error.status
          : (error as NodeJS.ErrnoException).code === "ENOENT"
            ? 404
            : 500;
      json(
        res,
        {
          error:
            status === 500
              ? "Hub request failed"
              : error instanceof Error
                ? error.message
                : "Request failed",
          ...(error instanceof HttpError && error.duplicateOf
            ? { duplicateOf: error.duplicateOf }
            : {}),
        },
        status,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  if (config.port === 0) {
    config.port = port;
    config.viewingOrigin = config.viewingOrigin.replace(":0", `:${port}`);
  }
  const listener = server.listeners("request")[0] as Parameters<typeof createServer>[0];
  const extraPorts = [
    ...new Set(
      Object.values(config.dashboardOrigins ?? {}).map((origin) =>
        Number(new URL(origin).port || 80),
      ),
    ),
  ].filter((value) => value !== port);
  const listeners = [server];
  try {
    await Promise.all(
      [
        { port, host: "::1" },
        ...extraPorts.flatMap((value) => [
          { port: value, host: "127.0.0.1" },
          { port: value, host: "::1" },
        ]),
      ].map(async (endpoint) => {
        const extra = createServer(listener!);
        listeners.push(extra);
        await new Promise<void>((resolve, reject) => {
          extra.once("error", reject);
          extra.listen(endpoint.port, endpoint.host, resolve);
        });
      }),
    );
  } catch (error) {
    for (const entry of listeners) entry.close();
    throw error;
  }
  await delivery.start();
  const housekeeping = setInterval(
    () => {
      void store.initialize().catch(() => console.error("Dashboard retention cleanup failed"));
    },
    60 * 60 * 1000,
  );
  housekeeping.unref();
  return {
    config,
    store,
    actions,
    delivery,
    server,
    port,
    close: async () => {
      clearInterval(housekeeping);
      await delivery.stop();
      await Promise.all(
        listeners.map(
          (entry) =>
            new Promise<void>((resolve, reject) => {
              entry.closeAllConnections();
              entry.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
    },
  };
}
