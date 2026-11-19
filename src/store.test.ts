/* eslint-disable no-await-in-loop -- These checks exercise sequential mutations and observe concurrent writes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { DashboardStore } from "./store.ts";
import { HttpError } from "./model.ts";
import type { DashboardData, JsonValue } from "./model.ts";

const writer = "environment/thread";
const encoded = (value: string) => Buffer.from(value).toString("base64");

describe("DashboardStore", () => {
  let sandbox: string;
  let root: string;
  let store: DashboardStore;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(await realpath(tmpdir()), "dashboard-store-"));
    root = join(sandbox, "dashboards");
    store = new DashboardStore(root, "workstation");
    await store.initialize();
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  async function create(extra: Record<string, unknown> = {}) {
    return await store.create({ id: "example", title: "Example", ...extra });
  }

  async function pageDirectory(): Promise<string> {
    const pointer = JSON.parse(await readFile(join(root, "example", "page.json"), "utf8")) as {
      generation: string;
    };
    return join(root, "example", ".pages", pointer.generation);
  }

  it("creates schema 2 records and reports the existing record on duplicate creation", async () => {
    const created = await create();
    expect(created.manifest).toMatchObject({
      schema: 2,
      id: "example",
      machine: "workstation",
      kind: "page",
      url: null,
      owner: null,
      handler: null,
      staleAfterMinutes: 60,
      pinned: false,
      collections: {},
      actions: [],
    });
    expect(created.data).toEqual({ schema: 2, rev: 1, collections: {} });
    await expect(create()).rejects.toMatchObject({ status: 409, existing: created });
    expect(await store.list()).toEqual([created]);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "example"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "example", "dashboard.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "example", "data.json"))).mode & 0o777).toBe(0o600);
  });

  it("retains the visible page generation when directory sync fails after pointer rename", async () => {
    await create();
    await store.publish("example", { "index.html": encoded("old page") });
    const previous = JSON.parse(
      await readFile(join(root, "example", "page.json"), "utf8"),
    ).generation;
    const handle = await open(root, "r");
    const prototype = Object.getPrototypeOf(handle) as { sync: FileHandle["sync"] };
    const original = prototype.sync;
    await handle.close();
    let injected = false;
    const spy = vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
      if (!injected && (await this.stat()).isDirectory()) {
        const current = JSON.parse(
          await readFile(join(root, "example", "page.json"), "utf8"),
        ).generation;
        if (current !== previous) {
          injected = true;
          throw Object.assign(new Error("Injected sync failure"), { code: "EIO" });
        }
      }
      await original.call(this);
    });
    try {
      await expect(
        store.publish("example", { "index.html": encoded("new page") }),
      ).rejects.toMatchObject({ status: 500 });
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect((await store.readPage("example", "index.html")).toString()).toBe("new page");
  });
  it("validates naming, manifests and immutable fields", async () => {
    for (const id of ["Upper", "two--parts", "-start", "end-", "../outside", "a/b", ""]) {
      await expect(create({ id })).rejects.toMatchObject({ status: 400 });
    }
    for (const invalid of [
      { machine: "worker" },
      { schema: 1 },
      { title: "" },
      { kind: "other" },
      { kind: "url" },
      { kind: "url", url: "file:///example" },
      { url: "https://example.invalid/" },
      { staleAfterMinutes: -1 },
      { staleAfterMinutes: null },
      { pinned: "yes" },
      { pinned: null },
      { collections: { queue: { type: "unknown" } } },
      { collections: null },
      { actions: {} },
      { actions: null },
      { unexpected: true },
      { createdAt: "untrusted" },
    ])
      await expect(create(invalid)).rejects.toBeInstanceOf(HttpError);
    const created = await create();
    await expect(store.updateManifest("example", { id: "another" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(store.updateManifest("example", { machine: "worker" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(store.updateManifest("example", { createdAt: "untrusted" })).rejects.toMatchObject(
      { status: 400 },
    );
    const updated = await store.updateManifest("example", {
      title: "Changed",
      pinned: true,
      staleAfterMinutes: 0,
    });
    expect(updated.manifest.createdAt).toBe(created.manifest.createdAt);
    expect(updated.manifest).toMatchObject({
      title: "Changed",
      pinned: true,
      staleAfterMinutes: 0,
    });
  });

  it("keeps 20 simultaneous independent writes and leaves valid JSON throughout", async () => {
    await create();
    let writing = true;
    let observations = 0;
    const observer = (async () => {
      // The writer's finally block ends this observer.
      // eslint-disable-next-line no-unmodified-loop-condition
      while (writing) {
        const data = JSON.parse(
          await readFile(join(root, "example", "data.json"), "utf8"),
        ) as DashboardData;
        expect(data.schema).toBe(2);
        observations++;
        await setImmediate();
      }
    })();
    let results: DashboardData[];
    try {
      results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.post(
            "example",
            "streams",
            `task-${index}`,
            { value: { index } },
            `environment/task-${index}`,
          ),
        ),
      );
    } finally {
      writing = false;
      await observer;
    }
    const data = (await store.get("example")).data;
    const collection = data.collections.streams!;
    expect(collection.order).toHaveLength(20);
    expect(Object.keys(collection.items)).toHaveLength(20);
    expect(new Set(results.map((result) => result.rev)).size).toBe(20);
    expect(data.rev).toBe(21);
    expect(collection.rev).toBe(21);
    expect(observations).toBeGreaterThan(1);
    for (let index = 0; index < 20; index++) {
      expect(collection.items[`task-${index}`]).toMatchObject({
        by: `environment/task-${index}`,
        via: "cli",
        value: { index },
      });
      expect(Number.isNaN(Date.parse(collection.items[`task-${index}`]!.at))).toBe(false);
    }
  });

  it("retains revisions across deletion, collection replacement, restart and recreation", async () => {
    await create();
    const first = await store.post("example", "queue", "entry", { value: "first" }, writer);
    const removed = await store.post("example", "queue", "entry", { delete: true }, writer);
    const next = await store.post("example", "queue", "entry", { value: "next" }, writer);
    const emptied = await store.setCollection("example", "queue", { order: [], items: {} }, writer);
    store = new DashboardStore(root, "workstation");
    const replaced = await store.setCollection(
      "example",
      "queue",
      { order: ["entry"], items: { entry: "replaced" } },
      writer,
    );
    await store.remove("example");
    const recreated = await create();
    const posted = await store.post("example", "queue", "entry", { value: "recreated" }, writer);
    const revisions = [
      first.rev,
      removed.rev,
      next.rev,
      emptied.rev,
      replaced.rev,
      recreated.data.rev,
      posted.rev,
    ];
    expect(revisions.every((rev, index) => index === 0 || rev > revisions[index - 1]!)).toBe(true);
    expect(posted.collections.queue!.items.entry!.rev).toBe(posted.rev);
  });

  it("orders inserts, moves and replacements and rejects inconsistent orders", async () => {
    await create();
    for (const key of ["a", "b", "c"])
      await store.post("example", "queue", key, { value: key }, writer);
    let data = await store.post("example", "queue", "b", { value: "updated" }, writer);
    expect(data.collections.queue!.order).toEqual(["a", "b", "c"]);
    data = await store.post("example", "queue", "c", { value: "moved", before: "a" }, writer);
    expect(data.collections.queue!.order).toEqual(["c", "a", "b"]);
    data = await store.post("example", "queue", "a", { value: "last", atEnd: true }, writer);
    expect(data.collections.queue!.order).toEqual(["c", "b", "a"]);
    await expect(
      store.post("example", "queue", "d", { value: 1, before: "missing" }, writer),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.post("example", "queue", "a", { value: 1, before: "a" }, writer),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.post("example", "queue", "d", { value: 1, before: "a", atEnd: true }, writer),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.post("example", "queue", "d", { delete: true, value: 1 }, writer),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.setCollection("example", "queue", { order: ["a", "a"], items: { a: 1 } }, writer),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.setCollection("example", "queue", { order: [], items: { a: 1 } }, writer),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.setCollection("example", "queue", { order: ["a"], items: { b: 1 } }, writer),
    ).rejects.toMatchObject({ status: 400 });
    data = await store.setCollection(
      "example",
      "queue",
      { order: ["z", "y"], items: { y: null, z: [1] } },
      writer,
    );
    expect(data.collections.queue!.order).toEqual(["z", "y"]);
    expect(Object.keys(data.collections.queue!.items)).toEqual(["z", "y"]);
    expect(data.collections.queue!.items.y).toMatchObject({
      rev: data.rev,
      by: writer,
      via: "cli",
      value: null,
    });
  });

  it("accepts arbitrary JSON, including prototype-like keys, without accepting non-JSON or oversized values", async () => {
    await create();
    for (const value of [null, true, 42, "text", [1, null], { nested: [false] }]) {
      const data = await store.post("example", "generic", "entry", { value }, writer);
      expect(data.collections.generic!.items.entry!.value).toEqual(value);
    }
    const special = await store.post(
      "example",
      "__proto__",
      "__proto__",
      { value: { safe: true } },
      writer,
    );
    expect(Object.hasOwn(special.collections, "__proto__")).toBe(true);
    expect(special.collections.__proto__!.items.__proto__!.value).toEqual({ safe: true });
    await store.post("example", "toString", "constructor", { value: "ordinary" }, writer);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      () => {},
      new Date(),
      cyclic,
      { invalid: undefined },
    ]) {
      await expect(
        store.post("example", "generic", "entry", { value }, writer),
      ).rejects.toMatchObject({ status: 400 });
    }
    await store.post("example", "generic", "entry", { value: "a".repeat(65534) }, writer);
    await expect(
      store.post("example", "generic", "entry", { value: "a".repeat(65535) }, writer),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      store.post("example", "generic", "entry", { value: "🙂".repeat(17000) }, writer),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("checks declared questions and defaults their status to open", async () => {
    await create({ collections: { questions: { type: "questions" } } });
    const valid = {
      title: "Choose",
      recommendation: "First",
      context: "Example context",
      options: [
        { label: "First", pros: "Simple", cons: ["Limited"] },
        { label: "Second", pros: ["Flexible"], cons: "Larger" },
      ],
    };
    const data = await store.post("example", "questions", "q1", { value: valid }, writer);
    expect(data.collections.questions!.items.q1!.value).toEqual({ ...valid, status: "open" });
    for (const status of ["answered", "withdrawn"]) {
      await store.post("example", "questions", "q1", { value: { ...valid, status } }, writer);
    }
    for (const value of [
      null,
      "question",
      { ...valid, title: "" },
      { ...valid, options: [] },
      { ...valid, options: [{ label: "" }] },
      { ...valid, options: [{ label: "Same" }, { label: "Same" }] },
      { ...valid, recommendation: 1 },
      { ...valid, context: [] },
      { ...valid, status: "closed" },
      { ...valid, status: null },
      { ...valid, options: [{ label: "Choice", pros: [1] }] },
    ])
      await expect(
        store.post("example", "questions", "q1", { value }, writer),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.setCollection(
        "example",
        "questions",
        { order: ["bad"], items: { bad: false } },
        writer,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await store.post("example", "generic", "entry", { value: false }, writer);
    await expect(
      store.updateManifest("example", { collections: { generic: { type: "questions" } } }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await store.get("example")).manifest.collections).toEqual({
      questions: { type: "questions" },
    });
  });

  it("publishes complete generations and preserves the previous page on staging failure", async () => {
    await create();
    await store.publish("example", {
      "index.html": encoded("old"),
      "assets/style.css": encoded("old style"),
    });
    expect((await store.readPage("example", "")).toString()).toBe("old");
    await expect(
      store.publish("example", {
        "index.html": encoded("broken"),
        conflict: encoded("file"),
        "conflict/child.js": encoded("child"),
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect((await store.readPage("example", "index.html")).toString()).toBe("old");
    expect((await store.readPage("example", "assets/style.css")).toString()).toBe("old style");
    const reads = Array.from({ length: 10 }, () => store.readPage("example", "index.html"));
    const published = store.publish("example", {
      "index.html": encoded("new"),
      "new.js": encoded("new script"),
    });
    const later = Array.from({ length: 10 }, () => store.readPage("example", "index.html"));
    expect((await Promise.all(reads)).every((body) => body.toString() === "old")).toBe(true);
    await published;
    expect((await Promise.all(later)).every((body) => body.toString() === "new")).toBe(true);
    await expect(store.readPage("example", "assets/style.css")).rejects.toMatchObject({
      status: 404,
    });
    expect((await store.readPage("example", "new.js")).toString()).toBe("new script");
    expect((await stat(join(await pageDirectory(), "new.js"))).mode & 0o777).toBe(0o600);
    await store.publish("example", { "index.html": encoded("latest") });
    expect(await readdir(join(root, "example", ".pages"))).toEqual([
      (await pageDirectory()).split("/").at(-1),
    ]);
    expect((await store.readPage("example", "")).toString()).toBe("latest");
  });

  it("rejects traversal, invalid bodies and page publication on URL dashboards", async () => {
    await create();
    for (const path of [
      "../outside",
      "/absolute",
      "assets/../../escape",
      "assets//file",
      "./index.html",
      "a\\b",
      "%2e%2e/file",
      "%252e%252e/file",
      "a/%2f/file",
    ]) {
      await expect(
        store.publish("example", { "index.html": encoded("safe"), [path]: encoded("bad") }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(store.readPage("example", path)).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      store.publish("example", { "other.html": encoded("missing index") }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.publish("example", { "index.html": "invalid base64" }),
    ).rejects.toMatchObject({ status: 400 });
    await create({ id: "linked", kind: "url", url: "http://example.localhost/" });
    await expect(store.publish("linked", { "index.html": encoded("page") })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("refuses page and attachment symlinks, including directory ancestors", async () => {
    await create();
    await store.publish("example", {
      "index.html": encoded("safe"),
      "assets/file.js": encoded("safe"),
    });
    await store.attach("example", "note.txt", encoded("safe"));
    const secret = join(sandbox, "outside.txt");
    await writeFile(secret, "outside");
    const page = await pageDirectory();
    await symlink(secret, join(page, "linked.txt"));
    await expect(store.readPage("example", "linked.txt")).rejects.toMatchObject({ status: 400 });
    await symlink(sandbox, join(page, "linked-directory"));
    await expect(store.readPage("example", "linked-directory/outside.txt")).rejects.toMatchObject({
      status: 400,
    });
    await symlink(secret, join(root, "example", "files", "linked.txt"));
    await expect(store.readAttachment("example", "linked.txt")).rejects.toMatchObject({
      status: 400,
    });
    await expect(store.attach("example", "linked.txt", encoded("overwrite"))).rejects.toMatchObject(
      { status: 400 },
    );
    const moved = join(sandbox, "page-generations");
    await rename(join(root, "example", ".pages"), moved);
    await symlink(moved, join(root, "example", ".pages"));
    await expect(store.readPage("example", "index.html")).rejects.toMatchObject({ status: 400 });
    expect(await readFile(secret, "utf8")).toBe("outside");
    const alias = join(sandbox, "alias");
    await symlink(root, alias);
    await expect(new DashboardStore(alias, "worker").initialize()).rejects.toMatchObject({
      status: 400,
    });
  });

  it("stores attachments privately and prevents path escape", async () => {
    await create();
    await store.attach("example", "note.txt", encoded("first"));
    await store.attach("example", "note.txt", encoded("second"));
    expect((await store.readAttachment("example", "note.txt")).toString()).toBe("second");
    expect((await stat(join(root, "example", "files", "note.txt"))).mode & 0o777).toBe(0o600);
    for (const name of ["../outside", "sub/file", "%2e%2e", "a\\b"]) {
      await expect(store.attach("example", name, encoded("bad"))).rejects.toMatchObject({
        status: 400,
      });
      await expect(store.readAttachment("example", name)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("serializes post/remove/restore races and restores the newest removed copy", async () => {
    await create();
    await Promise.all([
      store.post("example", "queue", "before", { value: "retained" }, writer),
      store.remove("example"),
      store.restore("example"),
      store.post("example", "queue", "after", { value: "retained" }, writer),
    ]);
    expect((await store.get("example")).data.collections.queue!.order).toEqual(["before", "after"]);
    const outcomes = await Promise.allSettled([
      store.remove("example"),
      store.post("example", "queue", "absent", { value: true }, writer),
      store.restore("example"),
    ]);
    expect(outcomes[0]!.status).toBe("fulfilled");
    expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { status: 404 } });
    expect(outcomes[2]!.status).toBe("fulfilled");
    await expect(store.restore("example")).rejects.toMatchObject({ status: 409 });
    await store.remove("example");
    await create({ title: "Newest" });
    await store.remove("example", true);
    const restored = await store.restore("example");
    expect(restored.manifest.title).toBe("Newest");
  });

  it("expires removed copies only during initialization and retains revision history", async () => {
    await create();
    const before = await store.post("example", "queue", "entry", { value: 1 }, writer);
    await store.remove("example");
    const [removed] = await readdir(join(root, ".removed"));
    const old = removed!.replace(/-\d+-/, `-${Date.now() - 8 * 24 * 60 * 60 * 1000}-`);
    await rename(join(root, ".removed", removed!), join(root, ".removed", old));
    expect(await store.list()).toEqual([]);
    await expect(store.get("example")).rejects.toMatchObject({ status: 404 });
    expect(await readdir(join(root, ".removed"))).toEqual([old]);
    await store.initialize();
    expect(await readdir(join(root, ".removed"))).toEqual([]);
    await expect(store.restore("example")).rejects.toMatchObject({ status: 404 });
    const recreated = await create();
    expect(recreated.data.rev).toBeGreaterThan(before.rev);
    await store.remove("example");
    await store.initialize();
    expect(await readdir(join(root, ".removed"))).toHaveLength(1);
  });

  it("reads request-time files, persists views across restore, and keeps GET operations read-only", async () => {
    await create();
    await store.publish("example", { "index.html": encoded("page") });
    await store.attach("example", "note.txt", encoded("note"));
    expect(await store.getView("example")).toEqual({});
    expect(await readdir(join(root, ".view"))).toEqual([]);
    const view: JsonValue = { open: ["question"], scroll: 50 };
    await Promise.all([
      store.putView("example", view),
      store.remove("example"),
      store.restore("example"),
    ]);
    expect(await store.getView("example")).toEqual(view);
    expect((await stat(join(root, ".view", "example.json"))).mode & 0o777).toBe(0o600);
    const manifestPath = join(root, "example", "dashboard.json");
    const changed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    changed.title = "Changed on disk";
    await writeFile(manifestPath, JSON.stringify(changed));
    expect((await store.get("example")).manifest.title).toBe("Changed on disk");
    const paths = (await readdir(root, { recursive: true })).toSorted();
    const before = await Promise.all(
      paths.map(async (path) => (await lstat(join(root, path))).mtimeMs),
    );
    await store.list();
    await store.get("example");
    await store.getView("example");
    await store.readPage("example", "index.html");
    await store.readAttachment("example", "note.txt");
    expect((await readdir(root, { recursive: true })).toSorted()).toEqual(paths);
    expect(
      await Promise.all(paths.map(async (path) => (await lstat(join(root, path))).mtimeMs)),
    ).toEqual(before);
  });
});
