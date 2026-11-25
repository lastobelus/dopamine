import { describe, expect, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";

describe("shell framing changes", () => {
  it("applies a prohibition discovered after an outage without reloading an unchanged frame", async () => {
    const nodes: Record<string, Record<string, unknown>> = {};
    const navigations: string[] = [];
    const contentWindow = {};
    const frame: Record<string, unknown> = { hidden: true, contentWindow };
    Object.defineProperty(frame, "src", {
      set: (value: string) => {
        navigations.push(value);
      },
    });
    nodes["#dashboard"] = frame;
    const timers: (() => void)[] = [];
    const events: Record<string, (event: unknown) => void> = {};
    const location = { pathname: "/d/example--worker", search: "", hash: "" };
    let allowed = true,
      address = "http://example.localhost/#/reports";
    runInNewContext(await readFile(new URL("../web/shell.js", import.meta.url), "utf8"), {
      document: {
        querySelector: (selector: string) =>
          (nodes[selector] ??= {
            hidden: true,
            removeAttribute(name: string) {
              delete nodes[selector]![name];
            },
            addEventListener() {},
          }),
      },
      location,
      history: {
        replaceState(_state: unknown, _unused: string, target: string) {
          const url = new URL(target, "http://hub.localhost");
          location.search = url.search;
          location.hash = url.hash;
        },
      },
      URL,
      URLSearchParams,
      addEventListener: (name: string, callback: (event: unknown) => void) => {
        events[name] = callback;
      },
      setInterval: (callback: () => void) => timers.push(callback),
      async fetch() {
        return {
          ok: true,
          json: async () => ({
            manifest: { kind: "url", url: address, title: "Example" },
            updatedAt: new Date().toISOString(),
            status: allowed ? "unreachable" : "reachable",
            frameAllowed: allowed,
          }),
        };
      },
    });
    await setImmediate();
    expect(navigations).toHaveLength(1);
    expect(navigations[0]).toBe(address);
    expect(nodes["#direct"]!.href).toBe(address);
    events.message!({
      source: contentWindow,
      origin: "http://example.localhost",
      data: { type: "dopamine:location", url: "http://example.localhost/" },
    });
    expect(nodes["#direct"]!.href).toBe("http://example.localhost/");
    timers[0]!();
    await setImmediate();
    expect(navigations).toHaveLength(1);
    allowed = false;
    timers[0]!();
    await setImmediate();
    expect(frame.hidden).toBe(true);
    expect(nodes["#blocked"]!.hidden).toBe(false);
    expect(nodes["#outside"]!.href).toBe("http://example.localhost/");
    allowed = true;
    timers[0]!();
    await setImmediate();
    expect(frame.hidden).toBe(false);
    expect(nodes["#blocked"]!.hidden).toBe(true);
    expect(navigations).toHaveLength(2);
    location.search = "?dopamine-path=%2Fold&tab=previous";
    location.hash = "#old";
    address = "http://new-site.localhost/new?tab=current";
    timers[0]!();
    await setImmediate();
    expect(navigations.at(-1)).toBe(address);
    expect(navigations).toHaveLength(3);
    timers[0]!();
    await setImmediate();
    expect(navigations).toHaveLength(3);
    address = "http://new-site.localhost/reports?tab=reports";
    timers[0]!();
    await setImmediate();
    expect(navigations.at(-1)).toBe(address);
    events.message!({
      source: contentWindow,
      origin: "http://new-site.localhost",
      data: { type: "dopamine:location", url: "http://new-site.localhost/" },
    });
    expect(new URLSearchParams(location.search).get("dopamine-path")).toBe("/");
    expect(nodes["#direct"]!.href).toBe("http://new-site.localhost/");
    allowed = false;
    timers[0]!();
    await setImmediate();
    allowed = true;
    timers[0]!();
    await setImmediate();
    expect(navigations.at(-1)).toBe("http://new-site.localhost/");
  });
});

describe("page subscription", () => {
  it("retries a revision after a failed render instead of accepting its ETag", async () => {
    const timers: (() => Promise<void>)[] = [];
    const headers: unknown[] = [];
    const view: {
      dopamine?: { subscribe: (callback: () => void, error: () => void) => () => void };
    } = {};
    const location = { href: "http://example--workstation.hub.localhost/", search: "" };
    await runInNewContext(await readFile(new URL("../web/dopamine.js", import.meta.url), "utf8"), {
      window: view,
      parent: view,
      location,
      URL,
      URLSearchParams,
      history: { pushState() {}, replaceState() {} },
      addEventListener() {},
      document: { addEventListener() {} },
      setTimeout(callback: () => Promise<void>) {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout() {},
      async fetch(path: string, options?: { headers?: unknown }) {
        if (path === "/dopamine-meta.json")
          return {
            ok: true,
            json: async () => ({ shell: "http://hub.localhost/d/example--workstation" }),
          };
        headers.push(options?.headers);
        return {
          ok: true,
          status: 200,
          headers: { get: () => '"2"' },
          json: async () => ({ rev: 2, collections: {} }),
        };
      },
    });
    let calls = 0,
      errors = 0;
    const unsubscribe = view.dopamine!.subscribe(
      () => {
        calls++;
        if (calls === 1) throw new Error("Temporary render failure");
      },
      () => {
        errors++;
      },
    );
    await setImmediate();
    expect(errors).toBe(1);
    expect(calls).toBe(1);
    await timers.shift()!();
    expect(calls).toBe(2);
    expect(headers[1]).toEqual({});
    await timers.shift()!();
    expect(headers[2]).toEqual({ "If-None-Match": '"2"' });
    expect(calls).toBe(2);
    unsubscribe();
  });
});

describe("page metadata recovery", () => {
  it("recovers from an initial metadata outage and preserves external-link navigation", async () => {
    const events: Record<string, (event: unknown) => void> = {};
    const timers: (() => void)[] = [];
    const messages: { message: { type: string; url: string }; origin: string }[] = [];
    const view: Record<string, unknown> = {};
    const parent = {
      postMessage: (message: { type: string; url: string }, origin: string) =>
        messages.push({ message, origin }),
    };
    const location = {
      href: "http://example--workstation.hub.localhost/",
      search: "",
      pathname: "/",
      hash: "",
    };
    let requests = 0;
    runInNewContext(await readFile(new URL("../web/dopamine.js", import.meta.url), "utf8"), {
      window: view,
      parent,
      location,
      URL,
      URLSearchParams,
      history: { pushState() {}, replaceState() {} },
      addEventListener() {},
      document: {
        addEventListener: (name: string, callback: (event: unknown) => void) => {
          events[name] = callback;
        },
      },
      setTimeout(callback: () => void) {
        timers.push(callback);
      },
      clearTimeout() {},
      async fetch() {
        requests++;
        return requests === 1
          ? { ok: false, status: 503 }
          : {
              ok: true,
              json: async () => ({ shell: "http://hub.localhost/d/example--workstation" }),
            };
      },
    });
    await setImmediate();
    location.href = "http://example--workstation.hub.localhost/details.html?tab=two#details";
    const anchor = {
      href: "t3-thread://v1/environment/thread",
      target: "",
      hasAttribute: () => false,
    };
    let prevented = false;
    const click = {
      button: 0,
      target: { closest: () => anchor },
      preventDefault: () => {
        prevented = true;
      },
    };
    events.click!(click);
    expect(prevented).toBe(false);
    expect(anchor.target).toBe("_blank");
    await setImmediate();
    timers.shift()!();
    expect(requests).toBe(2);
    expect(messages).toContainEqual({
      message: { type: "dopamine:location", url: location.href },
      origin: "http://hub.localhost",
    });
    events.click!(click);
    expect(prevented).toBe(true);
    expect(messages.at(-1)).toEqual({
      message: { type: "dopamine:open", url: anchor.href },
      origin: "http://hub.localhost",
    });
  });
});

async function shell(search = "") {
  type Node = Record<string, any>;
  const nodes: Record<string, Node> = {};
  const listeners: Record<string, Record<string, () => void>> = {};
  const node = (selector: string): Node =>
    (nodes[selector] ??= {
      hidden: true,
      disabled: false,
      open: false,
      textContent: "",
      children: [] as Node[],
      removeAttribute() {},
      replaceChildren(...children: Node[]) {
        this.children = children;
      },
      addEventListener(name: string, callback: () => void) {
        (listeners[selector] ??= {})[name] = callback;
      },
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
        listeners[selector]?.close?.();
      },
    });
  const posted: { message: unknown; origin: string }[] = [];
  const contentWindow = {
    postMessage: (message: unknown, origin: string) => posted.push({ message, origin }),
  };
  nodes["#dashboard"] = { hidden: true, contentWindow };
  const events: Record<string, (event: unknown) => void> = {};
  const delayed: (() => void)[] = [];
  const requests: { path: string; init?: { method?: string; body?: string } }[] = [];
  const location = { pathname: "/d/example--workstation", search, hash: "" };
  const hostile = '<img src=x onerror="alert(1)">';
  const stored = {
    request: {
      requestId: "r-0123456789abcdef",
      label: "Ship",
      target: { collection: "needs", key: "q1" },
      payload: { answer: hostile },
      at: "2026-11-20T20:00:00.000Z",
      state: "awaiting-confirmation",
      transport: "awaiting-confirmation",
    },
    dashboard: { key: "example--workstation", title: hostile, machine: "workstation" },
    item: hostile,
    handler: "thread handler",
  };
  runInNewContext(await readFile(new URL("../web/shell.js", import.meta.url), "utf8"), {
    document: {
      querySelector: node,
      createElement: (tag: string) => ({ tag, textContent: "" }),
    },
    location,
    history: {
      replaceState(_state: unknown, _unused: string, target: string) {
        location.search = new URL(target, "http://hub.localhost").search;
      },
    },
    URL,
    URLSearchParams,
    Intl,
    addEventListener: (name: string, callback: (event: unknown) => void) => {
      events[name] = callback;
    },
    setInterval() {},
    setTimeout(callback: () => void) {
      delayed.push(callback);
    },
    async fetch(path: string, init?: { method?: string; body?: string }) {
      requests.push({ path, ...(init ? { init } : {}) });
      if (path.startsWith("/api/shell/"))
        return {
          ok: true,
          json: async () => ({
            manifest: { kind: "page", title: "Example", machine: "workstation" },
            origin: "http://example--workstation.hub.localhost",
            updatedAt: new Date().toISOString(),
            status: "fresh",
            frameAllowed: true,
          }),
        };
      if (init?.method === "POST")
        return {
          ok: true,
          json: async () => ({ request: { ...stored.request, state: "queued" } }),
        };
      return { ok: true, json: async () => stored };
    },
  });
  await setImmediate();
  return {
    nodes,
    listeners,
    events,
    delayed,
    requests,
    posted,
    contentWindow,
    location,
    hostile,
  };
}

describe("shell confirmation", () => {
  it("draws the stored request as text and enables Confirm only after a pause", async () => {
    const view = await shell();
    view.events.message!({
      source: view.contentWindow,
      origin: "http://example--workstation.hub.localhost",
      data: { type: "dopamine:confirm", requestId: "r-0123456789abcdef" },
    });
    await setImmediate();
    const dialog = view.nodes["#confirm"]!;
    expect(dialog.open).toBe(true);
    const fields = view.nodes["#confirm-fields"]!.children as {
      tag: string;
      textContent: string;
    }[];
    expect(
      fields.filter((field) => field.tag === "dd").map((field) => field.textContent),
    ).toContain(`${view.hostile} · workstation`);
    expect(fields.every((field) => !("innerHTML" in field))).toBe(true);
    expect(view.nodes["#confirm-ok"]!.disabled).toBe(true);
    view.delayed.shift()!();
    expect(view.nodes["#confirm-ok"]!.disabled).toBe(false);
    view.listeners["#confirm-ok"]!.click!();
    await setImmediate();
    const post = view.requests.at(-1)!;
    expect(post.path).toBe("/api/confirm/example--workstation/r-0123456789abcdef");
    expect(JSON.parse(post.init!.body!)).toEqual({ decision: "confirm" });
    expect(dialog.open).toBe(false);
    expect(view.posted).toEqual([
      {
        message: { type: "dopamine:confirmed", requestId: "r-0123456789abcdef", state: "queued" },
        origin: "http://example--workstation.hub.localhost",
      },
    ]);
  });

  it("ignores confirmation messages from anything but its own frame", async () => {
    const view = await shell();
    view.events.message!({
      source: {},
      origin: "http://example--workstation.hub.localhost",
      data: { type: "dopamine:confirm", requestId: "r-0123456789abcdef" },
    });
    view.events.message!({
      source: view.contentWindow,
      origin: "http://other.hub.localhost",
      data: { type: "dopamine:confirm", requestId: "r-0123456789abcdef" },
    });
    await setImmediate();
    expect(view.nodes["#confirm"]?.open ?? false).toBe(false);
  });

  it("opens the box for a direct-mode confirmation and drops the parameter", async () => {
    const view = await shell("?dopamine-confirm=r-0123456789abcdef&dopamine-path=%2Fdetails");
    await setImmediate();
    expect(view.nodes["#confirm"]!.open).toBe(true);
    expect(new URLSearchParams(view.location.search).get("dopamine-confirm")).toBeNull();
    expect(new URLSearchParams(view.location.search).get("dopamine-path")).toBe("/details");
  });
});
