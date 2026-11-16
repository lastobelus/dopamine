export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface ThreadReference {
  environmentId: string;
  threadId: string;
  title?: string;
}

interface ManifestAction {
  name: string;
  label: string;
  collections: string[];
  scope: "item" | "collection";
  confirm: boolean;
  oncePerItem: boolean;
  maxPayloadBytes: number;
}

export interface Manifest {
  schema: 2;
  id: string;
  machine: string;
  title: string;
  kind: "page" | "url";
  url: string | null;
  owner: ThreadReference | null;
  handler: ThreadReference | null;
  staleAfterMinutes: number;
  pinned: boolean;
  collections: Record<string, { type: "questions" }>;
  actions: ManifestAction[];
  createdAt: string;
}

export interface DashboardItem {
  rev: number;
  by: string;
  via: "cli";
  at: string;
  value: JsonValue;
}

export interface DashboardCollection {
  rev: number;
  order: string[];
  items: Record<string, DashboardItem>;
}

export interface DashboardData {
  schema: 2;
  rev: number;
  collections: Record<string, DashboardCollection>;
}

export interface DashboardRecord {
  manifest: Manifest;
  data: DashboardData;
  updatedAt: string;
}

export class HttpError extends Error {
  status: number;
  existing?: DashboardRecord;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new HttpError(400, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new HttpError(400, `${label} must be a nonempty string`);
  }
  return value;
}

export function slug(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result) || result.length > 100) {
    throw new HttpError(400, `${label} must use lowercase letters, digits and single hyphens`);
  }
  return result;
}

export function json(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  function check(current: unknown): void {
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number" && Number.isFinite(current)) return;
    if (typeof current !== "object" || current === null || ancestors.has(current)) {
      throw new HttpError(400, "Value must be JSON");
    }
    ancestors.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) check(current[index]);
    } else {
      object(current, "Value");
      if (Object.getOwnPropertySymbols(current).length > 0) {
        throw new HttpError(400, "Value must be JSON");
      }
      for (const child of Object.values(current)) check(child);
    }
    ancestors.delete(current);
  }
  try {
    check(value);
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) {
      throw new HttpError(413, "Value exceeds 64 KB");
    }
    return JSON.parse(encoded) as JsonValue;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Value must be JSON");
  }
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, `${label} must be a boolean`);
  return value;
}

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, `${label} must be a nonnegative integer`);
  }
  return value;
}

function reference(value: unknown, label: string): ThreadReference | null {
  if (value === null) return null;
  const input = object(value, label);
  const result: ThreadReference = {
    environmentId: text(input.environmentId, `${label} environmentId`),
    threadId: text(input.threadId, `${label} threadId`),
  };
  if (input.title !== undefined) result.title = text(input.title, `${label} title`);
  return result;
}

export function manifest(input: unknown, machine: string, previous?: Manifest): Manifest {
  const patch = object(input, "Manifest");
  const allowed = new Set([
    "schema",
    "id",
    "machine",
    "title",
    "kind",
    "url",
    "owner",
    "handler",
    "staleAfterMinutes",
    "pinned",
    "collections",
    "actions",
    "createdAt",
  ]);
  if (Object.keys(patch).some((key) => !allowed.has(key))) {
    throw new HttpError(400, "Unknown manifest field");
  }
  if (patch.schema !== undefined && patch.schema !== 2) throw new HttpError(400, "Invalid schema");
  if (patch.machine !== undefined && patch.machine !== machine) {
    throw new HttpError(400, "Machine is immutable");
  }
  if (previous && patch.id !== undefined && patch.id !== previous.id) {
    throw new HttpError(400, "Dashboard id is immutable");
  }
  if (patch.createdAt !== undefined && patch.createdAt !== previous?.createdAt) {
    throw new HttpError(400, "Creation time is assigned by the hub");
  }
  const merged = { ...previous, ...patch };
  const kind = merged.kind === undefined ? "page" : merged.kind;
  if (kind !== "page" && kind !== "url") throw new HttpError(400, "Invalid dashboard kind");
  const url = merged.url ?? null;
  if (kind === "page" && url !== null)
    throw new HttpError(400, "Page dashboards cannot have a URL");
  if (kind === "url") {
    try {
      const parsed = new URL(text(url, "URL"));
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error("Invalid URL");
      }
    } catch {
      throw new HttpError(400, "URL dashboards require an HTTP or HTTPS URL without credentials");
    }
  }
  const declarations = object(
    merged.collections === undefined ? {} : merged.collections,
    "Collections",
  );
  const collections = Object.fromEntries(
    Object.entries(declarations).map(([name, declaration]) => {
      text(name, "Collection name");
      const entry = object(declaration, "Collection declaration");
      if (entry.type !== "questions" || Object.keys(entry).some((key) => key !== "type")) {
        throw new HttpError(400, "Unknown collection type");
      }
      return [name, { type: "questions" as const }];
    }),
  );
  const rawActions = merged.actions === undefined ? [] : merged.actions;
  if (!Array.isArray(rawActions)) throw new HttpError(400, "Actions must be an array");
  const actionNames = new Set<string>();
  const actions = rawActions.map((raw): ManifestAction => {
    const action = object(raw, "Action");
    const name = slug(action.name, "Action name");
    if (actionNames.has(name)) throw new HttpError(400, "Duplicate action name");
    actionNames.add(name);
    if (!Array.isArray(action.collections))
      throw new HttpError(400, "Action collections must be an array");
    const scope = action.scope;
    if (scope !== "item" && scope !== "collection")
      throw new HttpError(400, "Invalid action scope");
    return {
      name,
      label: text(action.label, "Action label"),
      collections: action.collections.map((collection) => text(collection, "Collection name")),
      scope,
      confirm: boolean(action.confirm, "Action confirm"),
      oncePerItem: boolean(action.oncePerItem, "Action oncePerItem"),
      maxPayloadBytes: nonnegative(action.maxPayloadBytes, "Action maxPayloadBytes"),
    };
  });
  return {
    schema: 2,
    id: slug(merged.id, "Dashboard id"),
    machine,
    title: text(merged.title, "Title"),
    kind,
    url: url as string | null,
    owner: reference(merged.owner ?? null, "Owner"),
    handler: reference(merged.handler ?? null, "Handler"),
    staleAfterMinutes: nonnegative(
      merged.staleAfterMinutes === undefined ? 60 : merged.staleAfterMinutes,
      "Stale interval",
    ),
    pinned: boolean(merged.pinned === undefined ? false : merged.pinned, "Pinned"),
    collections,
    actions,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
}

export function collectionValue(value: unknown, declaration?: { type: "questions" }): JsonValue {
  const checked = json(value);
  if (!declaration) return checked;
  const question = object(checked, "Question");
  text(question.title, "Question title");
  for (const key of ["recommendation", "context"]) {
    if (question[key] !== undefined && typeof question[key] !== "string") {
      throw new HttpError(400, `Question ${key} must be a string`);
    }
  }
  const status = question.status === undefined ? "open" : question.status;
  if (!["open", "answered", "withdrawn"].includes(status as string)) {
    throw new HttpError(400, "Invalid question status");
  }
  if (!Array.isArray(question.options) || question.options.length === 0) {
    throw new HttpError(400, "Question options must be a nonempty array");
  }
  const labels = new Set<string>();
  for (const raw of question.options) {
    const option = object(raw, "Question option");
    const label = text(option.label, "Option label");
    if (labels.has(label)) throw new HttpError(400, "Question option labels must be unique");
    labels.add(label);
    for (const key of ["pros", "cons"]) {
      const field = option[key];
      if (
        field !== undefined &&
        typeof field !== "string" &&
        !(Array.isArray(field) && field.every((entry) => typeof entry === "string"))
      ) {
        throw new HttpError(400, `Option ${key} must be a string or string array`);
      }
    }
  }
  return json({ ...question, status });
}
