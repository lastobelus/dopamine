/* eslint-disable no-await-in-loop -- Ancestor checks and staged writes must finish in order. */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { collectionValue, HttpError, json, manifest, object, slug, text } from "./model.ts";
import { hasOpenRequests, prepareRemoval } from "./actions.ts";
import type {
  DashboardCollection,
  DashboardData,
  DashboardItem,
  DashboardRecord,
  JsonValue,
} from "./model.ts";

const retentionMs = 7 * 24 * 60 * 60 * 1000;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function storageError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  throw new HttpError(500, "Dashboard storage operation failed");
}

function own<T>(entries: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(entries, key) ? entries[key] : undefined;
}

async function noSymlinks(path: string): Promise<void> {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new HttpError(400, "Symlinks are not allowed");
  }
}

async function privateDirectory(path: string): Promise<void> {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let created = false;
    try {
      await mkdir(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new HttpError(400, "Unsafe directory");
    if (created) await syncDirectory(dirname(current));
  }
  await chmod(path, 0o700);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safeRead(path: string): Promise<Buffer> {
  try {
    await noSymlinks(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new HttpError(404, "File not found");
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (missing(error)) throw new HttpError(404, "File not found");
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T> {
  const bytes = await safeRead(path);
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new HttpError(500, "Stored JSON is invalid");
  }
}

async function atomicWrite(
  path: string,
  body: Buffer | string,
  renamed?: () => void,
): Promise<void> {
  const parent = dirname(path);
  await noSymlinks(parent);
  try {
    await noSymlinks(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const temporary = join(parent, `.tmp-${randomUUID()}`);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed?.();
    await syncDirectory(parent);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeJson(path: string, value: unknown, renamed?: () => void): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value)}\n`, renamed);
}

function filePath(value: unknown, single = false): string {
  const path = text(value, "File path");
  if (
    isAbsolute(path) ||
    /[%\\:]/.test(path) ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    (single && path.includes("/"))
  ) {
    throw new HttpError(400, "Unsafe file path");
  }
  return path;
}

function base64(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new HttpError(400, "File body must be base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new HttpError(400, "File body must be base64");
  return bytes;
}

export class DashboardStore {
  readonly root: string;
  readonly machine: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(root: string, machine: string) {
    this.root = resolve(root);
    this.machine = slug(machine, "Machine");
  }

  /** Runs an operation under this dashboard's lock, the only way its files change. */
  async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return await this.locked(id, operation);
  }

  /** The dashboard's record; call it inside `exclusive`. */
  async current(id: string): Promise<DashboardRecord> {
    return await this.readRecord(id);
  }

  async ids(): Promise<string[]> {
    await noSymlinks(this.root);
    return (await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name))
      .map((entry) => entry.name);
  }

  /** Removed copies of a dashboard, newest first. */
  async removedDirectories(id: string): Promise<string[]> {
    return (await this.removedCopies())
      .filter((copy) => copy.id === id)
      .map((copy) => join(this.root, ".removed", copy.name));
  }

  private async locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    slug(id, "Dashboard id");
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((done) => {
      release = done;
    });
    this.locks.set(id, current);
    await previous;
    try {
      return await operation();
    } catch (error) {
      storageError(error);
    } finally {
      release();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }

  async initialize(): Promise<void> {
    try {
      await privateDirectory(this.root);
      for (const name of [".removed", ".revisions", ".view"])
        await privateDirectory(join(this.root, name));
      const removed = await this.removedCopies();
      for (const copy of removed) {
        if (copy.time > Date.now() - retentionMs) continue;
        await this.locked(copy.id, async () => {
          const path = join(this.root, ".removed", copy.name);
          try {
            await noSymlinks(path);
          } catch (error) {
            if (missing(error)) return;
            throw error;
          }
          // A handler may still claim or acknowledge an open request in a removed dashboard.
          if (await hasOpenRequests(path)) return;
          await rm(path, { recursive: true, force: true });
          await syncDirectory(join(this.root, ".removed"));
        });
      }
    } catch (error) {
      storageError(error);
    }
  }

  private async removedCopies(): Promise<{ id: string; time: number; name: string }[]> {
    await noSymlinks(join(this.root, ".removed"));
    const entries = await readdir(join(this.root, ".removed"), { withFileTypes: true });
    return entries
      .flatMap((entry) => {
        const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(\d+)-([a-f0-9-]{36})$/.exec(entry.name);
        if (!entry.isDirectory() || !match) return [];
        return [{ id: match[1]!, time: Number(match[2]), name: entry.name }];
      })
      .toSorted((left, right) => right.time - left.time);
  }

  private async readRecord(id: string): Promise<DashboardRecord> {
    const directory = join(this.root, id);
    const [storedManifest, data] = await Promise.all([
      readJson<DashboardRecord["manifest"]>(join(directory, "dashboard.json")),
      readJson<DashboardData>(join(directory, "data.json")),
    ]);
    const times = await Promise.all(
      ["dashboard.json", "data.json", "page.json", "files"].map(async (name) => {
        try {
          const path = join(directory, name);
          await noSymlinks(path);
          return (await stat(path)).mtimeMs;
        } catch (error) {
          if (missing(error)) return 0;
          throw error;
        }
      }),
    );
    return {
      manifest: storedManifest,
      data,
      updatedAt: new Date(Math.max(...times)).toISOString(),
    };
  }

  async list(): Promise<DashboardRecord[]> {
    try {
      await noSymlinks(this.root);
      const records: DashboardRecord[] = [];
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue;
        try {
          records.push(await this.get(entry.name));
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) throw error;
        }
      }
      return records.toSorted(
        (left, right) =>
          Number(right.manifest.pinned) - Number(left.manifest.pinned) ||
          left.manifest.id.localeCompare(right.manifest.id),
      );
    } catch (error) {
      storageError(error);
    }
  }

  async get(id: string): Promise<DashboardRecord> {
    return await this.locked(id, () => this.readRecord(id));
  }

  private async nextRevision(id: string, floor: number): Promise<number> {
    const path = join(this.root, ".revisions", `${id}.json`);
    let latest = 0;
    try {
      latest = await readJson<number>(path);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error;
    }
    if (!Number.isSafeInteger(latest) || latest < 0 || !Number.isSafeInteger(floor) || floor < 0) {
      throw new HttpError(500, "Stored revision is invalid");
    }
    const next = Math.max(latest, floor) + 1;
    if (!Number.isSafeInteger(next)) throw new HttpError(500, "Revision limit reached");
    await writeJson(path, next);
    return next;
  }

  async create(input: unknown): Promise<DashboardRecord> {
    const parsed = manifest(input, this.machine);
    return await this.locked(parsed.id, async () => {
      try {
        const existing = await this.readRecord(parsed.id);
        const error = new HttpError(409, "Dashboard already exists");
        error.existing = existing;
        throw error;
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 404)) throw error;
      }
      const destination = join(this.root, parsed.id);
      try {
        await lstat(destination);
        throw new HttpError(409, "Dashboard directory already exists");
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const stage = join(this.root, `.create-${randomUUID()}`);
      await privateDirectory(stage);
      try {
        const rev = await this.nextRevision(parsed.id, 0);
        await writeJson(join(stage, "dashboard.json"), parsed);
        await writeJson(join(stage, "data.json"), { schema: 2, rev, collections: {} });
        await rename(stage, destination);
        await syncDirectory(this.root);
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
      return await this.readRecord(parsed.id);
    });
  }

  async updateManifest(id: string, patch: unknown): Promise<DashboardRecord> {
    return await this.locked(id, async () => {
      const record = await this.readRecord(id);
      const parsed = manifest(patch, this.machine, record.manifest);
      for (const [name, collection] of Object.entries(record.data.collections)) {
        for (const item of Object.values(collection.items))
          collectionValue(item.value, own(parsed.collections, name));
      }
      await writeJson(join(this.root, id, "dashboard.json"), parsed);
      return await this.readRecord(id);
    });
  }

  async post(
    id: string,
    collection: string,
    key: string,
    input: unknown,
    by: string,
  ): Promise<DashboardData> {
    text(collection, "Collection name");
    text(key, "Item key");
    text(by, "Writer");
    const request = object(input, "Post");
    if (
      Object.keys(request).some(
        (field) => !["value", "delete", "before", "atEnd"].includes(field),
      ) ||
      (request.delete !== undefined && typeof request.delete !== "boolean") ||
      (request.atEnd !== undefined && typeof request.atEnd !== "boolean")
    ) {
      throw new HttpError(400, "Invalid post fields");
    }
    const deleting = request.delete === true;
    if (
      (deleting &&
        ("value" in request || request.before !== undefined || request.atEnd === true)) ||
      (!deleting && !("value" in request)) ||
      (request.before !== undefined && request.atEnd === true)
    ) {
      throw new HttpError(400, "Post requires a value or delete, and at most one ordering option");
    }
    const before = request.before === undefined ? undefined : text(request.before, "Before key");
    return await this.locked(id, async () => {
      const record = await this.readRecord(id);
      const old = own(record.data.collections, collection);
      const value = deleting
        ? null
        : collectionValue(request.value, own(record.manifest.collections, collection));
      if (before !== undefined && before !== key && !old?.order.includes(before)) {
        throw new HttpError(400, "Before key does not exist");
      }
      if (before === key) throw new HttpError(400, "An item cannot be ordered before itself");
      let items = Object.fromEntries(
        Object.entries(old?.items ?? {}).filter(([name]) => name !== key),
      );
      let order = old?.order.filter((name) => name !== key) ?? [];
      const rev = await this.nextRevision(id, record.data.rev);
      if (!deleting) {
        items = { ...items, [key]: { rev, by, via: "cli", at: new Date().toISOString(), value } };
        const previousIndex = old?.order.indexOf(key) ?? -1;
        const index =
          before !== undefined
            ? order.indexOf(before)
            : request.atEnd === true || previousIndex < 0
              ? order.length
              : previousIndex;
        order = [...order.slice(0, index), key, ...order.slice(index)];
      }
      const data: DashboardData = {
        schema: 2,
        rev,
        collections: { ...record.data.collections, [collection]: { rev, order, items } },
      };
      await writeJson(join(this.root, id, "data.json"), data);
      return data;
    });
  }

  async setCollection(
    id: string,
    collection: string,
    input: unknown,
    by: string,
  ): Promise<DashboardData> {
    text(collection, "Collection name");
    text(by, "Writer");
    const request = object(input, "Collection");
    const rawItems = object(request.items, "Items");
    if (
      !Array.isArray(request.order) ||
      Object.keys(request).some((key) => !["order", "items"].includes(key))
    ) {
      throw new HttpError(400, "Collection requires order and items");
    }
    const order = request.order.map((key) => text(key, "Item key"));
    if (
      new Set(order).size !== order.length ||
      order.length !== Object.keys(rawItems).length ||
      order.some((key) => !Object.hasOwn(rawItems, key))
    ) {
      throw new HttpError(400, "Order must contain every item key exactly once");
    }
    return await this.locked(id, async () => {
      const record = await this.readRecord(id);
      const values = order.map(
        (key) =>
          [
            key,
            collectionValue(rawItems[key], own(record.manifest.collections, collection)),
          ] as const,
      );
      const rev = await this.nextRevision(id, record.data.rev);
      const at = new Date().toISOString();
      const items: Record<string, DashboardItem> = Object.fromEntries(
        values.map(([key, value]) => [key, { rev, by, via: "cli", at, value }]),
      );
      const replacement: DashboardCollection = { rev, order, items };
      const data: DashboardData = {
        schema: 2,
        rev,
        collections: { ...record.data.collections, [collection]: replacement },
      };
      await writeJson(join(this.root, id, "data.json"), data);
      return data;
    });
  }

  async publish(id: string, input: unknown): Promise<DashboardRecord> {
    const files = Object.entries(object(input, "Page files")).map(
      ([name, body]) => [filePath(name), base64(body)] as const,
    );
    if (!files.some(([name]) => name === "index.html"))
      throw new HttpError(400, "Page requires index.html");
    return await this.locked(id, async () => {
      const record = await this.readRecord(id);
      if (record.manifest.kind !== "page")
        throw new HttpError(400, "Only page dashboards can publish files");
      const generations = join(this.root, id, ".pages");
      await privateDirectory(generations);
      const generation = randomUUID();
      const stage = join(generations, generation);
      await privateDirectory(stage);
      let published = false;
      try {
        for (const [name, bytes] of files) {
          const destination = join(stage, name);
          await privateDirectory(dirname(destination));
          await atomicWrite(destination, bytes);
        }
        await syncDirectory(stage);
        await syncDirectory(generations);
        await writeJson(join(this.root, id, "page.json"), { generation }, () => {
          published = true;
        });
      } finally {
        if (!published) await rm(stage, { recursive: true, force: true });
      }
      for (const entry of await readdir(generations, { withFileTypes: true })) {
        if (
          entry.name !== generation &&
          entry.isDirectory() &&
          /^[a-f0-9-]{36}$/.test(entry.name)
        ) {
          await rm(join(generations, entry.name), { recursive: true, force: true });
        }
      }
      await syncDirectory(generations);
      return await this.readRecord(id);
    });
  }

  async attach(id: string, name: string, body: string): Promise<DashboardRecord> {
    filePath(name, true);
    const bytes = base64(body);
    return await this.locked(id, async () => {
      await this.readRecord(id);
      const directory = join(this.root, id, "files");
      await privateDirectory(directory);
      await atomicWrite(join(directory, name), bytes);
      return await this.readRecord(id);
    });
  }

  async remove(id: string, force = false, by = "reader"): Promise<void> {
    if (typeof force !== "boolean") throw new HttpError(400, "Force must be a boolean");
    await this.locked(id, async () => {
      await this.readRecord(id);
      await prepareRemoval(join(this.root, id), force, by);
      const latest = (await this.removedCopies()).find((copy) => copy.id === id);
      const time = Math.max(Date.now(), (latest?.time ?? 0) + 1);
      await rename(
        join(this.root, id),
        join(this.root, ".removed", `${id}-${time}-${randomUUID()}`),
      );
      await syncDirectory(join(this.root, ".removed"));
      await syncDirectory(this.root);
    });
  }

  async restore(id: string): Promise<DashboardRecord> {
    return await this.locked(id, async () => {
      try {
        await lstat(join(this.root, id));
        throw new HttpError(409, "Dashboard already exists");
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const copy = (await this.removedCopies()).find((candidate) => candidate.id === id);
      if (!copy) throw new HttpError(404, "Removed dashboard not found");
      await noSymlinks(join(this.root, ".removed", copy.name));
      await rename(join(this.root, ".removed", copy.name), join(this.root, id));
      await syncDirectory(join(this.root, ".removed"));
      await syncDirectory(this.root);
      return await this.readRecord(id);
    });
  }

  async getView(id: string): Promise<JsonValue> {
    return await this.locked(id, async () => {
      await this.readRecord(id);
      try {
        return await readJson<JsonValue>(join(this.root, ".view", `${id}.json`));
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return {};
        throw error;
      }
    });
  }

  async putView(id: string, value: JsonValue): Promise<void> {
    const checked = json(value);
    await this.locked(id, async () => {
      await this.readRecord(id);
      await writeJson(join(this.root, ".view", `${id}.json`), checked);
    });
  }

  async readPage(id: string, path: string): Promise<Buffer> {
    const name = filePath(path === "" ? "index.html" : path);
    return await this.locked(id, async () => {
      await this.readRecord(id);
      const pointer = await readJson<{ generation: string }>(join(this.root, id, "page.json"));
      if (!/^[a-f0-9-]{36}$/.test(pointer.generation))
        throw new HttpError(500, "Invalid page generation");
      const directory = join(this.root, id, ".pages", pointer.generation);
      const candidate = join(directory, name);
      try {
        await noSymlinks(candidate);
        const [base, target] = await Promise.all([realpath(directory), realpath(candidate)]);
        const rel = relative(base, target);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
          throw new HttpError(400, "Unsafe file path");
        return await safeRead(candidate);
      } catch (error) {
        if (missing(error)) throw new HttpError(404, "Page file not found");
        throw error;
      }
    });
  }

  async readAttachment(id: string, name: string): Promise<Buffer> {
    filePath(name, true);
    return await this.locked(id, async () => {
      await this.readRecord(id);
      return await safeRead(join(this.root, id, "files", name));
    });
  }
}
