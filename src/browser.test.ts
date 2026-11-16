import { describe, expect, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";

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
