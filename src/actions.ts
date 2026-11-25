/* eslint-disable no-await-in-loop -- Log operations on one dashboard run in order under its lock. */
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { HttpError, handlerReference, isPull, json, object, text } from "./model.ts";
import type { DashboardRecord, Handler, JsonValue } from "./model.ts";
import type { DashboardStore } from "./store.ts";

export type Transport =
  | "awaiting-confirmation"
  | "queued"
  | "sending"
  | "delivered"
  | "failed"
  | "stalled"
  | "ambiguous"
  | "abandoned";
type Handling = "unclaimed" | "claimed" | "done" | "unknown" | "abandoned";

export interface ActionTarget {
  collection: string;
  key?: string;
  itemRev?: number;
  collectionRev?: number;
}

interface ActionResult {
  label: string;
  href?: string;
}

/** One request, reduced from the events in `actions.jsonl` in order. */
export interface ActionRequest {
  requestId: string;
  clickId: string;
  click: string;
  dashboard: string;
  target: ActionTarget;
  snapshot: JsonValue;
  action: string;
  label: string;
  payload: JsonValue;
  handler: Handler;
  confirm: boolean;
  at: string;
  rerunOf?: string;
  transport: Transport;
  mayBeDelivered: boolean;
  handling: Handling;
  attempts: number;
  nextAttemptAt?: string;
  error?: string;
  receipt?: { messageId: string; runId?: string };
  leaseUntil?: string;
  claimedBy?: string;
  claimedAt?: string;
  result?: ActionResult;
  rerunAs?: string;
  updatedAt: string;
}

interface RequestEvent {
  event: "request";
  request: Omit<
    ActionRequest,
    | "transport"
    | "mayBeDelivered"
    | "handling"
    | "attempts"
    | "updatedAt"
    | "nextAttemptAt"
    | "error"
    | "receipt"
    | "leaseUntil"
    | "claimedBy"
    | "claimedAt"
    | "result"
    | "rerunAs"
  > & { transport: "queued" | "awaiting-confirmation" };
}
interface TransportEvent {
  event: "transport";
  requestId: string;
  transport: Transport;
  at: string;
  by?: string;
  attempts?: number;
  nextAttemptAt?: string | null;
  error?: string | null;
  receipt?: { messageId: string; runId?: string };
  leaseUntil?: string;
}
interface HandlingEvent {
  event: "handling";
  requestId: string;
  handling: Handling;
  at: string;
  by: string;
  result?: ActionResult;
}
type LogEvent = RequestEvent | TransportEvent | HandlingEvent;

const LOG = "actions.jsonl";
/** A claim with no ack after this long shows as unresolved. */
const UNRESOLVED_MS = 30 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
export const MAX_DELIVERY_ATTEMPTS = 5;
const REPAIR_ERROR = "Action log was repaired; check before retrying";
const REPAIRABLE_TRANSPORTS = new Set<Transport>(["queued", "sending", "failed", "delivered"]);

/** JSON with object keys sorted at every level, so equal clicks compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function handlerIdentity(handler: Handler): string {
  return isPull(handler) ? `pull:${handler.name}` : `${handler.environmentId}/${handler.threadId}`;
}

/** A request is open while it may still be delivered, handled or need the reader. */
function isOpen(request: ActionRequest): boolean {
  if (["done", "abandoned"].includes(request.handling)) return false;
  return request.handling !== "unclaimed" || request.transport !== "abandoned";
}

/** What the page shows for a request: its handling once claimed, otherwise its transport. */
function requestState(request: ActionRequest, now = Date.now()): string {
  if (request.handling === "claimed")
    return now - Date.parse(request.claimedAt!) > UNRESOLVED_MS ? "unresolved" : "claimed";
  if (request.handling !== "unclaimed") return request.handling;
  return request.transport;
}

/** The fields a page may read about a request; the snapshot and receipt stay in the log. */
export function publicRequest(request: ActionRequest, now = Date.now()) {
  return {
    requestId: request.requestId,
    action: request.action,
    label: request.label,
    target: request.target,
    payload: request.payload,
    at: request.at,
    state: requestState(request, now),
    transport: request.transport,
    handling: request.handling,
    mayBeDelivered: request.mayBeDelivered,
    attempts: request.attempts,
    ...(request.nextAttemptAt ? { nextAttemptAt: request.nextAttemptAt } : {}),
    ...(request.error ? { error: request.error } : {}),
    ...(request.result ? { result: request.result } : {}),
    ...(request.rerunOf ? { rerunOf: request.rerunOf } : {}),
    ...(request.rerunAs ? { rerunAs: request.rerunAs } : {}),
  };
}

function logFields(value: unknown, ...allowed: string[]): Record<string, unknown> {
  const input = object(value, "Log record");
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error("Unexpected log field");
  return input;
}

function logDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateLoggedClick(request: RequestEvent["request"]): void {
  if (request.rerunOf !== undefined) {
    if (
      request.clickId !== `rerun-${request.requestId}` ||
      request.click !== canonical({ rerunOf: request.rerunOf })
    )
      throw new Error("Invalid rerun click");
    return;
  }

  const click = logFields(
    JSON.parse(request.click),
    "clickId",
    "action",
    "target",
    "payload",
    "confirmDuplicate",
  );
  if (
    click.clickId !== request.clickId ||
    click.action !== request.action ||
    canonical(click.target) !== canonical(request.target) ||
    canonical(click.payload ?? null) !== canonical(request.payload) ||
    (click.confirmDuplicate !== undefined && typeof click.confirmDuplicate !== "boolean") ||
    canonical(click) !== request.click
  )
    throw new Error("Logged click does not match the request");
}

function readRequest(value: unknown): RequestEvent["request"] {
  const request = logFields(
    value,
    "requestId",
    "clickId",
    "click",
    "dashboard",
    "target",
    "snapshot",
    "action",
    "label",
    "payload",
    "handler",
    "confirm",
    "at",
    "rerunOf",
    "transport",
  );
  for (const field of ["requestId", "clickId", "click", "dashboard", "action", "label"])
    text(request[field], field);
  if (request.rerunOf !== undefined) text(request.rerunOf, "Original request ID");
  if (
    typeof request.confirm !== "boolean" ||
    request.transport !== (request.confirm ? "awaiting-confirmation" : "queued") ||
    !logDate(request.at)
  )
    throw new Error("Invalid request record");
  json(request.payload);
  const handler = object(request.handler, "Handler");
  if (handler.kind !== "pull") logFields(handler, "environmentId", "threadId", "title");
  handlerReference(handler);

  const target = object(request.target, "Target");
  text(target.collection, "Target collection");
  if (target.key !== undefined) {
    logFields(target, "collection", "key", "itemRev");
    text(target.key, "Target key");
    const rev = integer(target.itemRev, "Item revision");
    const snapshot = logFields(request.snapshot, "rev", "value");
    if (snapshot.rev !== rev) throw new Error("Item snapshot revision does not match");
    json(snapshot.value);
  } else {
    logFields(target, "collection", "collectionRev");
    const rev = integer(target.collectionRev, "Collection revision");
    const snapshot = logFields(request.snapshot, "rev", "order");
    if (
      snapshot.rev !== rev ||
      !Array.isArray(snapshot.order) ||
      !snapshot.order.every((key) => typeof key === "string")
    )
      throw new Error("Invalid collection snapshot");
  }
  const logged = request as unknown as RequestEvent["request"];
  validateLoggedClick(logged);
  return logged;
}

function transportFields(event: TransportEvent, ...fields: (keyof TransportEvent)[]): boolean {
  const allowed = new Set<string>(["event", "requestId", "at", "transport", ...fields]);
  return Object.keys(event).every((field) => allowed.has(field));
}

function isRepairTransport(event: TransportEvent): boolean {
  return event.transport === "ambiguous" && event.by !== undefined && event.error === REPAIR_ERROR;
}

function canApplyTransport(
  request: ActionRequest,
  event: TransportEvent,
  attemptsBeforeRetry: number | undefined,
): boolean {
  const { transport: from, handling } = request;
  const unclaimed = handling === "unclaimed";
  const pull = isPull(request.handler);
  switch (event.transport) {
    case "queued":
      if (!unclaimed || event.by === undefined) return false;
      if (from === "awaiting-confirmation") return transportFields(event, "by");
      return (
        ["failed", "stalled", "ambiguous"].includes(from) &&
        transportFields(event, "by", "attempts", "nextAttemptAt", "error") &&
        event.attempts === 0 &&
        event.nextAttemptAt === null &&
        event.error === null
      );
    case "sending":
      return (
        unclaimed &&
        !pull &&
        ["queued", "failed"].includes(from) &&
        transportFields(event, "attempts") &&
        event.attempts === request.attempts + 1
      );
    case "failed":
    case "stalled": {
      const { attempts } = event;
      // A reachability check may finish after a late claim or after Retry reset the budget.
      return (
        !pull &&
        ["queued", "failed"].includes(from) &&
        transportFields(event, "attempts", "nextAttemptAt", "error") &&
        attempts !== undefined &&
        (attempts === request.attempts + 1 ||
          (attemptsBeforeRetry !== undefined && attempts === attemptsBeforeRetry + 1)) &&
        typeof event.error === "string" &&
        (event.transport === "failed"
          ? attempts < MAX_DELIVERY_ATTEMPTS && logDate(event.nextAttemptAt)
          : attempts === MAX_DELIVERY_ATTEMPTS && event.nextAttemptAt === null)
      );
    }
    case "delivered":
      if (!pull) {
        if (
          from !== "sending" ||
          event.error !== null ||
          !transportFields(event, "receipt", "error")
        )
          return false;
        const receipt = logFields(event.receipt, "messageId", "runId");
        return (
          typeof receipt.messageId === "string" &&
          !!receipt.messageId &&
          (receipt.runId === undefined || typeof receipt.runId === "string")
        );
      }
      return (
        unclaimed &&
        event.by === handlerIdentity(request.handler) &&
        transportFields(event, "by", "leaseUntil") &&
        logDate(event.leaseUntil) &&
        Date.parse(event.leaseUntil) > Date.parse(event.at) &&
        (from === "queued" ||
          (from === "delivered" && Date.parse(request.leaseUntil!) <= Date.parse(event.at)))
      );
    case "ambiguous":
      // Repair already writes this marker, including on logs from before validation.
      if (isRepairTransport(event))
        return (
          unclaimed && REPAIRABLE_TRANSPORTS.has(from) && transportFields(event, "by", "error")
        );
      return (
        from === "sending" && typeof event.error === "string" && transportFields(event, "error")
      );
    case "abandoned":
      return (
        unclaimed &&
        from !== "sending" &&
        from !== "abandoned" &&
        event.by !== undefined &&
        transportFields(event, "by")
      );
    default:
      return false;
  }
}

function canApplyHandling(request: ActionRequest, event: HandlingEvent): boolean {
  switch (event.handling) {
    case "claimed":
      return (
        request.handling === "unclaimed" &&
        request.transport !== "abandoned" &&
        request.mayBeDelivered &&
        event.by === handlerIdentity(request.handler)
      );
    case "done":
      if (request.handling === "unknown") return event.result === undefined;
    // Falls through to the acknowledgement check.
    case "unknown":
      return request.handling === "claimed" && event.by === request.claimedBy;
    case "abandoned":
      return (
        request.handling === "unknown" ||
        (request.handling === "unclaimed" && request.transport === "abandoned")
      );
    default:
      return false;
  }
}

function apply({ requests, clicks, attemptsBeforeRetry }: Log, raw: unknown): void {
  const event = object(raw, "Log event");
  if (event.event === "request") {
    logFields(event, "event", "request");
    const request = readRequest(event.request);
    if (requests.has(request.requestId)) throw new Error("Duplicate request ID");
    if (clicks.has(request.clickId)) throw new Error("Duplicate click ID");
    // Run again is one record: the new request closes the one it reruns.
    const rerun = request.rerunOf === undefined ? undefined : requests.get(request.rerunOf);
    if (request.rerunOf !== undefined) {
      if (rerun?.handling !== "unknown") throw new Error("Invalid rerun record");
      const copied = [
        "dashboard",
        "target",
        "snapshot",
        "action",
        "label",
        "payload",
        "handler",
        "confirm",
      ] as const;
      if (copied.some((field) => canonical(rerun[field]) !== canonical(request[field])))
        throw new Error("Rerun does not match the original request");
    }
    requests.set(request.requestId, {
      ...request,
      mayBeDelivered: false,
      handling: "unclaimed",
      attempts: 0,
      updatedAt: request.at,
    });
    clicks.set(request.clickId, request.requestId);
    if (rerun)
      Object.assign(rerun, {
        handling: "abandoned",
        rerunAs: request.requestId,
        updatedAt: request.at,
      });
    return;
  }
  const request = requests.get(text(event.requestId, "Request ID"));
  if (!request || !logDate(event.at)) throw new Error("Invalid event request or time");
  if (event.event === "transport") {
    if (event.by !== undefined) text(event.by, "Actor");
    const change = event as unknown as TransportEvent;
    if (!canApplyTransport(request, change, attemptsBeforeRetry.get(request.requestId)))
      throw new Error("Invalid transport transition");
    if (change.transport === "queued" || isRepairTransport(change)) {
      // Repair and Retry can both happen while the same reachability check is still pending.
      if (request.transport === "failed")
        attemptsBeforeRetry.set(request.requestId, request.attempts);
    } else {
      attemptsBeforeRetry.delete(request.requestId);
    }
    request.updatedAt = change.at;
    request.transport = change.transport;
    if (change.transport === "sending" || change.leaseUntil) request.mayBeDelivered = true;
    if (change.attempts !== undefined) request.attempts = change.attempts;
    for (const field of ["nextAttemptAt", "error"] as const) {
      if (change[field] === null) delete request[field];
      else if (change[field] !== undefined) request[field] = change[field];
    }
    if (change.receipt) request.receipt = change.receipt;
    if (change.leaseUntil) request.leaseUntil = change.leaseUntil;
    return;
  }
  if (event.event === "handling") {
    logFields(event, "event", "requestId", "at", "handling", "by", "result");
    const by = text(event.by, "Actor");
    if (event.result !== undefined && event.handling !== "done" && event.handling !== "unknown")
      throw new Error("Unexpected action result");
    if (event.result !== undefined) {
      const result = logFields(event.result, "label", "href");
      // The writer truncates after checking the label, so a stored label may be all whitespace.
      if (typeof result.label !== "string" || !result.label || result.label.length > 500)
        throw new Error("Invalid logged result label");
      if (result.href !== undefined) resultHref(result.href);
    }
    const change = event as unknown as HandlingEvent;
    if (!canApplyHandling(request, change)) throw new Error("Invalid handling transition");
    request.updatedAt = change.at;
    request.handling = change.handling;
    if (change.handling === "claimed") {
      request.claimedBy = by;
      request.claimedAt = change.at;
    }
    if (change.result) request.result = change.result;
    return;
  }
  throw new Error("Unknown log event");
}

interface Log {
  requests: Map<string, ActionRequest>;
  clicks: Map<string, string>;
  attemptsBeforeRetry: Map<string, number>;
  damaged: boolean;
}

function emptyLog(): Log {
  return { requests: new Map(), clicks: new Map(), attemptsBeforeRetry: new Map(), damaged: false };
}
async function readBytes(path: string): Promise<Buffer> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

/** Reads a log; an incomplete final line is ignored here and set aside before the next append. */
async function readLog(directory: string): Promise<Log> {
  const bytes = await readBytes(join(directory, LOG));
  const end = bytes.lastIndexOf(10) + 1;
  const log = emptyLog();
  for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      apply(log, JSON.parse(line));
    } catch {
      log.damaged = true;
    }
  }
  return log;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeSide(path: string, body: Buffer | string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeTail(directory: string, tail: Buffer): Promise<void> {
  await writeSide(join(directory, `actions.tail-${Date.now()}-${randomUUID()}`), tail);
}

/** Sets aside an incomplete final record, then refuses to continue a damaged log. */
async function prepareAppend(directory: string): Promise<Log> {
  const path = join(directory, LOG);
  const bytes = await readBytes(path);
  const end = bytes.lastIndexOf(10) + 1;
  if (end < bytes.length) {
    await writeTail(directory, bytes.subarray(end));
    const handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      await handle.truncate(end);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const log = await readLog(directory);
  if (log.damaged)
    throw new HttpError(503, "Action log damaged; run dash action repair for this dashboard");
  return log;
}

async function append(directory: string, events: LogEvent[]): Promise<void> {
  const path = join(directory, LOG);
  let created = false;
  try {
    await lstat(path);
  } catch {
    created = true;
  }
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (created) await syncDirectory(directory);
}

/** Before removal: refuse while work may be running, and with force abandon what was never sent. */
export async function prepareRemoval(directory: string, force: boolean, by: string): Promise<void> {
  const log = await readLog(directory);
  if (log.damaged)
    throw new HttpError(409, "Action log damaged; run dash action repair before removing");
  const requests = [...log.requests.values()];
  // A request can be done while its send is still running; removal waits for the send either way.
  if (requests.some((request) => request.transport === "sending" || request.handling === "claimed"))
    throw new HttpError(409, "An action request is being sent or handled; try again later");
  const pending = requests.filter(isOpen);
  if (!pending.length) return;
  if (!force)
    throw new HttpError(409, "This dashboard has open action requests; remove it with --force");
  const at = new Date().toISOString();
  await prepareAppend(directory);
  const events: LogEvent[] = [];
  for (const { requestId, handling } of pending) {
    if (handling === "unclaimed")
      events.push({ event: "transport", requestId, transport: "abandoned", at, by });
    events.push({ event: "handling", requestId, handling: "abandoned", at, by });
  }
  await append(directory, events);
}

export async function hasOpenRequests(directory: string): Promise<boolean> {
  const log = await readLog(directory);
  return log.damaged || [...log.requests.values()].some(isOpen);
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new HttpError(400, `${label} must be a nonnegative integer`);
  return value;
}

function resultHref(value: unknown): string {
  const href = text(value, "Result href");
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new HttpError(400, "Result href must be a URL");
  }
  if (!["http:", "https:", "t3-thread:"].includes(url.protocol))
    throw new HttpError(400, "Result href must use http, https or t3-thread");
  return url.href;
}

function resultValue(value: unknown): ActionResult | undefined {
  if (value === undefined) return undefined;
  const input = object(value, "Result");
  if (Object.keys(input).some((key) => !["label", "href"].includes(key)))
    throw new HttpError(400, "Result has only label and href");
  const result: ActionResult = { label: text(input.label, "Result label").slice(0, 500) };
  if (input.href !== undefined) result.href = resultHref(input.href);
  return result;
}

interface Located {
  directory: string;
  live: boolean;
}

/**
 * Action requests: accepted from a page, confirmed in the shell, delivered by the worker,
 * claimed and acknowledged by the handler. Every change is a locked append that checks the
 * reduced state first.
 */
export class ActionStore {
  readonly store: DashboardStore;
  private readonly now: () => number;
  private readonly polls = new Map<string, number>();

  constructor(store: DashboardStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }

  private key(id: string): string {
    return `${id}--${this.store.machine}`;
  }

  /** The live dashboard first, then removed copies, newest first. */
  private async locate(id: string, requestId?: string): Promise<Located> {
    const live = join(this.store.root, id);
    const candidates: Located[] = [{ directory: live, live: true }];
    for (const directory of await this.store.removedDirectories(id))
      candidates.push({ directory, live: false });
    for (const candidate of candidates) {
      try {
        await lstat(join(candidate.directory, "dashboard.json"));
      } catch {
        continue;
      }
      if (!requestId) return candidate;
      if ((await readLog(candidate.directory)).requests.has(requestId)) return candidate;
    }
    throw new HttpError(404, requestId ? "Action request not found" : "Dashboard not found");
  }

  async accept(
    id: string,
    input: unknown,
    available: (handler: Handler) => Promise<boolean>,
  ): Promise<{ request: ActionRequest; existing: boolean }> {
    const click = object(input, "Click");
    if (
      Object.keys(click).some(
        (field) => !["clickId", "action", "target", "payload", "confirmDuplicate"].includes(field),
      )
    )
      throw new HttpError(400, "Unknown click field");
    const clickId = text(click.clickId, "Click ID");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(clickId))
      throw new HttpError(400, "Click ID must be 8 to 128 letters, digits, - or _");
    if (click.confirmDuplicate !== undefined && typeof click.confirmDuplicate !== "boolean")
      throw new HttpError(400, "confirmDuplicate must be a boolean");
    const payload = json(click.payload ?? null);
    // Every field as sent, so a resent click matches only if nothing in it changed.
    const fingerprint = canonical(click);
    const { manifest } = await this.store.get(id);
    const checked = manifest.handler;
    const handlerUp = checked ? await available(checked) : false;
    return await this.store.exclusive(id, async () => {
      const directory = join(this.store.root, id);
      const record = await this.store.current(id);
      const log = await prepareAppend(directory);
      const { requests, clicks } = log;
      const previousId = clicks.get(clickId);
      const previous = previousId === undefined ? undefined : requests.get(previousId);
      if (previous) {
        if (previous.click !== fingerprint)
          throw new HttpError(409, "This click ID was already used for a different click");
        return { request: previous, existing: true };
      }
      const action = record.manifest.actions.find((entry) => entry.name === click.action);
      if (!action) throw new HttpError(400, "Unknown action");
      const target = this.target(record, action.scope, click.target);
      if (!action.collections.includes(target.collection))
        throw new HttpError(400, "This action is not declared for that collection");
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      if (bytes > action.maxPayloadBytes)
        throw new HttpError(413, `Payload exceeds ${action.maxPayloadBytes} bytes`);
      const collection = record.data.collections[target.collection]!;
      const item = target.key === undefined ? undefined : collection.items[target.key]!;
      if (
        item &&
        record.manifest.collections[target.collection]?.type === "questions" &&
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        "answer" in payload
      ) {
        const options = (item.value as { options: { label: string }[] }).options;
        if (!options.some((option) => option.label === payload.answer))
          throw new HttpError(400, "The answer must be one of the question's options");
      }
      const handler = record.manifest.handler;
      if (!handler) throw new HttpError(409, "This dashboard has no handler for actions");
      if (canonical(handler) !== canonical(checked))
        throw new HttpError(409, "The handler changed; try again");
      if (!handlerUp) throw new HttpError(409, "The handler thread is unavailable");
      if (action.oncePerItem && click.confirmDuplicate !== true) {
        const earlier = [...requests.values()].find(
          (request) =>
            request.action === action.name &&
            request.target.collection === target.collection &&
            request.target.key === target.key &&
            request.handling !== "abandoned" &&
            request.transport !== "abandoned",
        );
        if (earlier) {
          const error = new HttpError(409, "Already requested; confirm to send it again");
          error.duplicateOf = earlier.requestId;
          throw error;
        }
      }
      const at = this.at();
      const request: RequestEvent["request"] = {
        requestId: `r-${randomBytes(8).toString("hex")}`,
        clickId,
        click: fingerprint,
        dashboard: this.key(id),
        target,
        snapshot: item
          ? { rev: item.rev, value: item.value }
          : { rev: collection.rev, order: collection.order },
        action: action.name,
        label: action.label,
        payload,
        handler,
        confirm: action.confirm,
        at,
        transport: action.confirm ? "awaiting-confirmation" : "queued",
      };
      const event: RequestEvent = { event: "request", request };
      apply(log, event);
      await append(directory, [event]);
      return { request: requests.get(request.requestId)!, existing: false };
    });
  }

  private target(record: DashboardRecord, scope: string, value: unknown): ActionTarget {
    const input = object(value, "Target");
    const collection = text(input.collection, "Target collection");
    const fields =
      scope === "item" ? ["collection", "key", "itemRev"] : ["collection", "collectionRev"];
    if (Object.keys(input).some((field) => !fields.includes(field)))
      throw new HttpError(400, `A ${scope} action targets ${fields.join(", ")}`);
    const current = Object.hasOwn(record.data.collections, collection)
      ? record.data.collections[collection]
      : undefined;
    const changed = new HttpError(409, "This changed; look again");
    if (scope === "item") {
      const key = text(input.key, "Target key");
      const itemRev = integer(input.itemRev, "Item revision");
      const item = current && Object.hasOwn(current.items, key) ? current.items[key] : undefined;
      if (!item || item.rev !== itemRev) throw changed;
      return { collection, key, itemRev };
    }
    const collectionRev = integer(input.collectionRev, "Collection revision");
    if (!current || current.rev !== collectionRev) throw changed;
    return { collection, collectionRev };
  }

  /** The live dashboard's requests, or for a request ID, the copy that holds that request. */
  async list(
    id: string,
    filter: { collection?: string; key?: string; requestId?: string } = {},
  ): Promise<{ requests: ActionRequest[]; damaged: boolean }> {
    return await this.store.exclusive(id, async () => {
      const { directory } = await this.locate(id, filter.requestId);
      const log = await readLog(directory);
      return {
        damaged: log.damaged,
        requests: [...log.requests.values()].filter(
          (request) =>
            (filter.requestId === undefined || request.requestId === filter.requestId) &&
            (filter.collection === undefined || request.target.collection === filter.collection) &&
            (filter.key === undefined || request.target.key === filter.key),
        ),
      };
    });
  }

  /** The shell's Confirm or Cancel, from the exact control origin. */
  async decide(
    id: string,
    requestId: string,
    decision: unknown,
    by: string,
  ): Promise<ActionRequest> {
    if (decision !== "confirm" && decision !== "cancel")
      throw new HttpError(400, "Decision must be confirm or cancel");
    return await this.change(id, requestId, (request, at): LogEvent[] => {
      if (request.transport !== "awaiting-confirmation")
        throw new HttpError(409, "This request is not awaiting confirmation");
      return decision === "confirm"
        ? [{ event: "transport", requestId, transport: "queued", at, by }]
        : [
            { event: "transport", requestId, transport: "abandoned", at, by },
            { event: "handling", requestId, handling: "abandoned", at, by },
          ];
    });
  }

  /** The reader's choices on a request the page shows: Retry, Abandon, Mark done, Run again. */
  async choose(id: string, requestId: string, choice: unknown, by: string): Promise<ActionRequest> {
    let rerun: RequestEvent["request"] | undefined;
    const result = await this.change(id, requestId, (request, at): LogEvent[] => {
      const unclaimed = request.handling === "unclaimed";
      switch (choice) {
        case "retry":
          if (!unclaimed || !["failed", "stalled", "ambiguous"].includes(request.transport))
            throw new HttpError(
              409,
              "Only an unclaimed failed, stalled or ambiguous request can be retried",
            );
          return [
            {
              event: "transport",
              requestId,
              transport: "queued",
              at,
              by,
              attempts: 0,
              error: null,
              nextAttemptAt: null,
            },
          ];
        case "abandon":
          if (request.handling === "unknown")
            return [{ event: "handling", requestId, handling: "abandoned", at, by }];
          if (!unclaimed || ["sending", "abandoned"].includes(request.transport))
            throw new HttpError(409, "This request can no longer be abandoned");
          return [
            { event: "transport", requestId, transport: "abandoned", at, by },
            { event: "handling", requestId, handling: "abandoned", at, by },
          ];
        case "mark-done":
          if (request.handling !== "unknown")
            throw new HttpError(
              409,
              "Only a request the handler could not confirm can be marked done",
            );
          return [{ event: "handling", requestId, handling: "done", at, by }];
        case "run-again": {
          if (request.handling !== "unknown")
            throw new HttpError(409, "Only a request the handler could not confirm can run again");
          const newId = `r-${randomBytes(8).toString("hex")}`;
          rerun = {
            requestId: newId,
            clickId: `rerun-${newId}`,
            click: canonical({ rerunOf: requestId }),
            dashboard: request.dashboard,
            target: request.target,
            snapshot: request.snapshot,
            action: request.action,
            label: request.label,
            payload: request.payload,
            handler: request.handler,
            confirm: request.confirm,
            at,
            rerunOf: requestId,
            transport: request.confirm ? "awaiting-confirmation" : "queued",
          };
          return [{ event: "request", request: rerun }];
        }
        default:
          throw new HttpError(400, "Choice must be retry, abandon, mark-done or run-again");
      }
    });
    if (!rerun) return result;
    return (await this.list(id)).requests.find(
      (request) => request.requestId === rerun!.requestId,
    )!;
  }

  private async change(
    id: string,
    requestId: string,
    events: (request: ActionRequest, at: string) => LogEvent[],
    options: { live?: boolean } = { live: true },
  ): Promise<ActionRequest> {
    return await this.store.exclusive(id, async () => {
      const located = await this.locate(id, requestId);
      if (options.live && !located.live) throw new HttpError(404, "Dashboard was removed");
      const log = await prepareAppend(located.directory);
      const request = log.requests.get(requestId);
      if (!request) throw new HttpError(404, "Action request not found");
      const changes = events(request, this.at());
      for (const change of changes) apply(log, change);
      await append(located.directory, changes);
      return request;
    });
  }

  /** The handler takes a request, exactly once. */
  async claim(id: string, requestId: string, claimant: string): Promise<ActionRequest> {
    return await this.change(
      id,
      requestId,
      (request, at) => {
        if (handlerIdentity(request.handler) !== claimant)
          throw new HttpError(403, "Only the handler recorded for this request can claim it");
        if (request.handling !== "unclaimed")
          throw new HttpError(409, "This request was already claimed or closed");
        if (request.transport === "abandoned")
          throw new HttpError(409, "This request was abandoned");
        if (!request.mayBeDelivered)
          throw new HttpError(409, "This request has not been delivered");
        return [{ event: "handling", requestId, handling: "claimed", at, by: claimant }];
      },
      {},
    );
  }

  async ack(
    id: string,
    requestId: string,
    claimant: string,
    input: unknown,
  ): Promise<ActionRequest> {
    const body = object(input, "Ack");
    if (Object.keys(body).some((key) => !["status", "result"].includes(key)))
      throw new HttpError(400, "Ack has only status and result");
    if (body.status !== "done" && body.status !== "unknown")
      throw new HttpError(400, "Ack status must be done or unknown");
    const result = resultValue(body.result);
    return await this.change(
      id,
      requestId,
      (request, at) => {
        if (request.handling !== "claimed")
          throw new HttpError(409, "Only a claimed request can be acknowledged, once");
        if (request.claimedBy !== claimant)
          throw new HttpError(403, "Only the handler that claimed this request can acknowledge it");
        return [
          {
            event: "handling",
            requestId,
            handling: body.status as Handling,
            at,
            by: claimant,
            ...(result ? { result } : {}),
          },
        ];
      },
      {},
    );
  }

  /** A pull handler's next request, leased for five minutes. */
  async next(id: string, name: string): Promise<ActionRequest | null> {
    const claimant = `pull:${name}`;
    return await this.store.exclusive(id, async () => {
      const directory = join(this.store.root, id);
      await this.store.current(id);
      this.polls.set(`${id}\0${name}`, this.now());
      const { requests } = await prepareAppend(directory);
      const now = this.now();
      const request = [...requests.values()].find(
        (candidate) =>
          handlerIdentity(candidate.handler) === claimant &&
          candidate.handling === "unclaimed" &&
          (candidate.transport === "queued" ||
            (candidate.transport === "delivered" && Date.parse(candidate.leaseUntil!) <= now)),
      );
      if (!request) return null;
      const leaseUntil = new Date(now + LEASE_MS).toISOString();
      await append(directory, [
        {
          event: "transport",
          requestId: request.requestId,
          transport: "delivered",
          at: this.at(),
          by: claimant,
          leaseUntil,
        },
      ]);
      return { ...request, transport: "delivered", mayBeDelivered: true, leaseUntil };
    });
  }

  /** When a pull handler last asked for work on this dashboard, if this hub saw it. */
  lastPoll(id: string, name: string): number | undefined {
    return this.polls.get(`${id}\0${name}`);
  }

  /** Repair a damaged log: keep the records that still apply, and send nothing automatically. */
  async repair(id: string, by: string): Promise<{ kept: number; setAside: number }> {
    return await this.store.exclusive(id, async () => {
      const { directory } = await this.locate(id);
      const path = join(directory, LOG);
      const bytes = await readBytes(path);
      const end = bytes.lastIndexOf(10) + 1;
      const tail = bytes.subarray(end);
      const log = emptyLog();
      const kept: string[] = [];
      const damaged: string[] = [];
      for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
        if (!line) continue;
        try {
          apply(log, JSON.parse(line));
          kept.push(line);
        } catch {
          damaged.push(line);
        }
      }
      const setAside = damaged.length + Number(tail.length > 0);
      if (!setAside) return { kept: kept.length, setAside };
      if (tail.length) await writeTail(directory, tail);
      if (damaged.length)
        await writeSide(
          join(directory, `actions.damaged-${Date.now()}-${randomUUID()}.jsonl`),
          `${damaged.join("\n")}\n`,
        );
      // Make the saved records durable before replacing the original log.
      await syncDirectory(directory);
      const at = this.at();
      const recovered = [...log.requests.values()]
        .filter(
          (request) =>
            request.handling === "unclaimed" && REPAIRABLE_TRANSPORTS.has(request.transport),
        )
        .map((request) =>
          JSON.stringify({
            event: "transport",
            requestId: request.requestId,
            transport: "ambiguous",
            at,
            by,
            error: REPAIR_ERROR,
          } satisfies TransportEvent),
        );
      const temporary = join(dirname(path), `.tmp-${randomUUID()}`);
      try {
        await writeSide(temporary, [...kept, ...recovered].map((line) => `${line}\n`).join(""));
        await rename(temporary, path);
        await syncDirectory(directory);
      } finally {
        await rm(temporary, { force: true });
      }
      return { kept: kept.length, setAside };
    });
  }

  // The delivery worker's steps. Each checks the reduced state under the lock first.

  async liveRequests(): Promise<{ id: string; requests: ActionRequest[] }[]> {
    const result: { id: string; requests: ActionRequest[] }[] = [];
    for (const id of await this.store.ids()) {
      try {
        const log = await this.store.exclusive(id, () => readLog(join(this.store.root, id)));
        if (!log.damaged) result.push({ id, requests: [...log.requests.values()] });
      } catch {
        /* A dashboard removed meanwhile has nothing left to deliver. */
      }
    }
    return result;
  }

  /** Marks a send as started, if the request still wants one. */
  async beginSend(id: string, requestId: string): Promise<ActionRequest | null> {
    try {
      return await this.change(id, requestId, (request, at) => {
        if (
          request.handling !== "unclaimed" ||
          !["queued", "failed"].includes(request.transport) ||
          isPull(request.handler)
        )
          throw new HttpError(409, "skip");
        return [
          {
            event: "transport",
            requestId,
            transport: "sending",
            at,
            attempts: request.attempts + 1,
          },
        ];
      });
    } catch (error) {
      if (error instanceof HttpError && [404, 409].includes(error.status)) return null;
      throw error;
    }
  }

  /** Records a send's outcome. A transport record never changes handling. */
  async recordTransport(
    id: string,
    requestId: string,
    from: Transport[],
    change: Omit<TransportEvent, "event" | "requestId" | "at">,
  ): Promise<void> {
    try {
      await this.change(
        id,
        requestId,
        (request, at) => {
          if (!from.includes(request.transport)) throw new HttpError(409, "skip");
          return [{ event: "transport", requestId, at, ...change }];
        },
        {},
      );
    } catch (error) {
      if (!(error instanceof HttpError && [404, 409].includes(error.status))) throw error;
    }
  }

  /** At start-up, a send with no recorded outcome may have arrived: never resend it automatically. */
  async recoverSending(): Promise<void> {
    for (const { id, requests } of await this.liveRequests())
      for (const request of requests)
        if (request.transport === "sending")
          await this.recordTransport(id, request.requestId, ["sending"], {
            transport: "ambiguous",
            error: "The hub stopped during this send",
          });
  }
}
