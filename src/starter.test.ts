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
  addEventListener() {}
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  text(): string {
    return this.textContent + this.children.map((child) => child.text()).join(" ");
  }
}
async function page() {
  const nodes = Object.fromEntries(
    ["collections", "title", "updated", "error", "empty"].map((id) => [id, new Element("div")]),
  );
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
    setTimeout() {},
    clearTimeout() {},
    dopamine: {
      view: { get: async () => ({}), set: async () => ({}) },
      meta: async () => ({ manifest: { title: "Example" } }),
      subscribe: (callback: (data: unknown) => void) => {
        render = callback;
      },
    },
  });
  await setImmediate();
  if (!render) throw new Error("Starter did not subscribe");
  return { render, root: nodes.collections! };
}
const item = (rev: number, value: unknown) => ({
  rev,
  by: "environment/thread",
  at: "2026-01-01T00:00:00Z",
  value,
});
describe("starter rendering", () => {
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
});
