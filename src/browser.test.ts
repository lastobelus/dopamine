import { describe, expect, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";

describe("shell framing changes", () => {
  it("applies a prohibition discovered after an outage without reloading an unchanged frame", async () => {
    const nodes: Record<string, Record<string, unknown>> = {};
    const navigations: string[] = [];
    const frame: Record<string, unknown> = { hidden: true };
    Object.defineProperty(frame, "src", {
      set: (value: string) => {
        navigations.push(value);
      },
    });
    nodes["#dashboard"] = frame;
    const timers: (() => void)[] = [];
    const location = { pathname: "/d/example--worker", search: "", hash: "" };
    let allowed = true,
      address = "http://example.localhost/";
    runInNewContext(await readFile(new URL("../web/shell.js", import.meta.url), "utf8"), {
      document: { querySelector: (selector: string) => (nodes[selector] ??= { hidden: true }) },
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
      addEventListener() {},
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
