import { describe, expect, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";

class Element {
  tag: string;
  parent: Element | undefined;
  children: Element[] = [];
  dataset: Record<string, string> = {};
  textContent = "";
  className = "";
  hidden = false;
  open = false;
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...nodes: Element[]) {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: Element[]) {
    for (const child of this.children) child.parent = undefined;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = undefined;
  }
  listeners: Record<string, () => void> = {};
  addEventListener(name: string, callback: () => void) {
    this.listeners[name] = callback;
  }
  setAttribute() {}
  prepend(...nodes: (Element | string)[]) {
    const existing = this.children;
    this.children = [];
    this.append(...(nodes as Element[]));
    this.children.push(...existing);
  }
  after(node: Element) {
    this.parent?.append(node);
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  text(): string {
    return this.textContent + this.children.map((child) => child.text()).join(" ");
  }
}
async function page(
  dopamine: Record<string, unknown> = {},
  meta: unknown = { manifest: { title: "Example" } },
  timers: (() => void)[] = [],
) {
  const nodes = Object.fromEntries(
    ["collections", "title", "updated", "error", "empty"].map((id) => [id, new Element("div")]),
  );
  new Element("main").append(nodes.collections!);
  let render: ((data: unknown) => void) | undefined;
  runInNewContext(await readFile(new URL("../starter/app.js", import.meta.url), "utf8"), {
    document: {
      querySelector: (selector: string) => nodes[selector.slice(1)],
      querySelectorAll: () =>
        nodes.collections!.all().filter((node) => node.tag === "details" && node.open),
      createElement: (tag: string) => new Element(tag),
      createDocumentFragment: () => new Element("fragment"),
      createTextNode: (text: string) => Object.assign(new Element("text"), { textContent: text }),
    },
    window: { scrollY: 0, scrollX: 0, scrollTo() {} },
    requestAnimationFrame: (callback: () => void) => callback(),
    addEventListener() {},
    location: { href: "http://example--workstation.hub.localhost/" },
    URL,
    Intl,
    setTimeout: (callback: () => void) => timers.push(callback),
    clearTimeout() {},
    dopamine: {
      view: { get: async () => ({}), set: async () => ({}) },
      meta: async () => meta,
      subscribe: (callback: (data: unknown) => void) => {
        render = callback;
      },
      ...dopamine,
    },
  });
  await setImmediate();
  if (!render) throw new Error("Starter did not subscribe");
  return { render, root: nodes.collections! };
}
const request = (requestId: string, state: string) => ({
  requestId,
  label: "Decide",
  payload: null,
  state,
  target: { collection: "needs", key: "q1" },
});
const item = (rev: number, value: unknown) => ({
  rev,
  by: "environment/thread",
  at: "2026-01-01T00:00:00Z",
  value,
});
describe("starter rendering", () => {
  it("hides empty collection headings and shows them when an item returns", async () => {
    const { render, root } = await page();
    render({ rev: 1, collections: { questions: { rev: 1, order: [], items: {} } } });
    const section = root.children[0]!;
    expect(section.hidden).toBe(true);
    render({
      rev: 2,
      collections: {
        questions: { rev: 2, order: ["one"], items: { one: item(2, { title: "Question" }) } },
      },
    });
    expect(section.hidden).toBe(false);
    expect(section.text()).toContain("Question");
    render({ rev: 3, collections: { questions: { rev: 3, order: [], items: {} } } });
    expect(section.hidden).toBe(true);
    expect(section.all().filter((node) => node.tag === "article")).toHaveLength(0);
  });
  it("keeps distinct slash-containing collection and item pairs in separate cards", async () => {
    const { render, root } = await page();
    render({
      rev: 1,
      collections: {
        "a/b": {
          rev: 1,
          order: ["c"],
          items: { c: item(1, { title: "First", context: "First details" }) },
        },
        a: {
          rev: 1,
          order: ["b/c"],
          items: { "b/c": item(1, { title: "Second", context: "Second details" }) },
        },
      },
    });
    expect(root.all().filter((node) => node.tag === "article")).toHaveLength(2);
    expect(root.text()).toContain("First");
    expect(root.text()).toContain("Second");
    const details = root.all().filter((node) => node.tag === "details");
    expect(details[0]!.dataset.key).not.toBe(details[1]!.dataset.key);
  });
  it("renders arbitrary option shapes without losing previously visible content", async () => {
    const { render, root } = await page();
    render({
      rev: 1,
      collections: {
        rows: { rev: 1, order: ["good"], items: { good: item(1, { title: "Retained" }) } },
      },
    });
    expect(() =>
      render({
        rev: 2,
        collections: {
          rows: {
            rev: 2,
            order: ["good", "null", "object"],
            items: {
              good: item(1, { title: "Retained" }),
              null: item(2, { options: [null] }),
              object: item(2, { context: "Visible context", options: { malformed: true } }),
            },
          },
        },
      }),
    ).not.toThrow();
    expect(root.text()).toContain("Retained");
    expect(root.text()).toContain("Visible context");
    expect(root.all().filter((node) => node.tag === "article")).toHaveLength(3);
  });
  it("offers each answer as a button and shows each request's state with the reader's choices", async () => {
    const acted: unknown[][] = [];
    const chosen: unknown[][] = [];
    let showRequests: ((requests: unknown[]) => void) | undefined;
    const { render, root } = await page(
      {
        act: async (...args: unknown[]) => {
          acted.push(args);
        },
        choose: async (...args: unknown[]) => {
          chosen.push(args);
        },
        watchRequests: (callback: (requests: unknown[]) => void) => {
          showRequests = callback;
        },
      },
      {
        manifest: {
          title: "Example",
          collections: { needs: { type: "questions" } },
          actions: [{ name: "decide", label: "Decide", collections: ["needs"], scope: "item" }],
        },
        handlerState: "available",
      },
    );
    render({
      rev: 4,
      collections: {
        needs: {
          rev: 4,
          order: ["q1"],
          items: {
            q1: item(4, { title: "Ship?", options: [{ label: "Yes" }, { label: "<b>No</b>" }] }),
          },
        },
      },
    });
    const buttons = root
      .all()
      .filter((node) => node.tag === "button" && node.textContent !== "Cite");
    expect(buttons.map((node) => node.textContent)).toEqual(["Yes", "<b>No</b>"]);
    buttons[1]!.listeners.click!();
    await setImmediate();
    expect(acted).toEqual([
      [
        "decide",
        { collection: "needs", key: "q1" },
        { answer: "<b>No</b>" },
        { confirmDuplicate: false },
      ],
    ]);
    showRequests!([
      {
        requestId: "r-1",
        label: "Decide",
        payload: { answer: "<b>No</b>" },
        state: "ambiguous",
        target: { collection: "needs", key: "q1" },
        error: "The send timed out",
      },
    ]);
    const text = root.text();
    expect(text).toContain("Decide: <b>No</b> · May have been delivered");
    expect(text).toContain("The send timed out");
    const retry = root.all().find((node) => node.textContent === "Retry")!;
    retry.listeners.click!();
    expect(chosen).toEqual([["r-1", "retry"]]);
    showRequests!([
      {
        requestId: "r-1",
        label: "Decide",
        payload: { answer: "Yes" },
        state: "done",
        target: { collection: "needs", key: "q1" },
        result: { label: "Shipped", href: "javascript:alert(1)" },
      },
    ]);
    expect(root.text()).toContain("Shipped");
    // An older request that needs the reader stays visible behind newer finished ones.
    showRequests!([
      request("r-0", "ambiguous"),
      request("r-1", "done"),
      request("r-2", "done"),
      request("r-3", "done"),
      request("r-4", "done"),
    ]);
    expect(root.all().filter((node) => node.className.startsWith("request "))).toHaveLength(4);
    expect(root.text()).toContain("May have been delivered");
    // Once the item is deleted, its request that needs the reader is still reachable.
    render({ rev: 5, collections: { needs: { rev: 5, order: [], items: {} } } });
    const other = root.parent!.children.find((node) => node.text().includes("Other requests"))!;
    expect(other.hidden).toBe(false);
    expect(other.text()).toContain("May have been delivered");
    expect(root.all().some((node) => node.tag === "a" && node.textContent === "Shipped")).toBe(
      false,
    );
  });
  it("adds action buttons once metadata loads after a failure", async () => {
    const timers: (() => void)[] = [];
    let fail = true;
    const { render, root } = await page(
      {
        meta: async () => {
          if (fail) throw new Error("Dashboard request failed (503).");
          return {
            manifest: {
              title: "Example",
              collections: {},
              actions: [{ name: "go", label: "Go", collections: ["rows"], scope: "item" }],
            },
          };
        },
        watchRequests() {},
      },
      undefined,
      timers,
    );
    render({
      rev: 1,
      collections: { rows: { rev: 1, order: ["a"], items: { a: item(1, { title: "Row" }) } } },
    });
    const buttons = () =>
      root.all().filter((node) => node.tag === "button" && node.textContent === "Go");
    expect(buttons()).toHaveLength(0);
    fail = false;
    timers.shift()!();
    await setImmediate();
    expect(buttons()).toHaveLength(1);
  });
});
