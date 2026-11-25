/* eslint-disable unicorn/consistent-function-scoping -- Keep the public client isolated from page globals. */
(() => {
  const request = async (path, options) => {
    const response = await fetch(path, options);
    if (!response.ok) {
      let details = {};
      try {
        details = await response.json();
      } catch {
        /* Keep the status alone. */
      }
      const error = new Error(details.error ?? `Dashboard request failed (${response.status}).`);
      error.status = response.status;
      if (details.duplicateOf) error.duplicateOf = details.duplicateOf;
      throw error;
    }
    return response.json();
  };
  const post = (path, value) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  let facts, metadataRequest, back, latest;
  const watchers = new Set();
  const remember = (data) => {
    latest = data;
    return data;
  };
  function updateBack(meta) {
    if (parent !== window || new URLSearchParams(location.search).get("dopamine-direct") !== "1")
      return;
    if (!back) {
      back = document.createElement("a");
      back.textContent = "← Back to dopamine";
      document.body.prepend(back);
    }
    const url = new URL(meta.shell),
      query = new URLSearchParams(location.search);
    query.delete("dopamine-direct");
    if (location.pathname !== "/") query.set("dopamine-path", location.pathname);
    url.search = query.toString();
    url.hash = location.hash;
    back.href = url.href;
  }
  function reportLocation(meta) {
    if (parent !== window)
      parent.postMessage(
        { type: "dopamine:location", url: location.href },
        new URL(meta.shell).origin,
      );
    else updateBack(meta);
  }
  function metadata() {
    if (!metadataRequest)
      metadataRequest = request("/dopamine-meta.json")
        .then((meta) => {
          facts = meta;
          reportLocation(meta);
          return meta;
        })
        .catch((error) => {
          metadataRequest = undefined;
          throw error;
        });
    return metadataRequest;
  }
  const tellLocation = () => {
    if (facts) reportLocation(facts);
    else void metadata().catch(() => {});
  };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      tellLocation();
      return result;
    };
  }
  const notify = () => {
    for (const poll of watchers) void poll();
  };
  addEventListener("message", (event) => {
    if (
      facts &&
      parent !== window &&
      event.source === parent &&
      event.origin === new URL(facts.shell).origin &&
      event.data?.type === "dopamine:confirmed"
    )
      notify();
  });
  addEventListener("hashchange", tellLocation);
  addEventListener("popstate", tellLocation);
  tellLocation();
  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor = event.target.closest?.("a[href]");
    if (!anchor || anchor.target || anchor.hasAttribute("download") || parent === window) return;
    const url = new URL(anchor.href, location.href);
    if (
      url.protocol === "t3-thread:" ||
      (["http:", "https:"].includes(url.protocol) && url.origin !== location.origin)
    ) {
      if (!facts) {
        anchor.target = "_blank";
        setTimeout(() => {
          anchor.target = "";
        }, 0);
        void metadata().catch(() => {});
        return;
      }
      event.preventDefault();
      parent.postMessage({ type: "dopamine:open", url: url.href }, new URL(facts.shell).origin);
    }
  });
  window.dopamine = {
    data: () => request("/data.json").then(remember),
    subscribe(callback, onError = () => {}) {
      let etag,
        rev,
        stopped = false,
        timer;
      const poll = async () => {
        try {
          const response = await fetch("/data.json", {
            headers: etag ? { "If-None-Match": etag } : {},
          });
          if (response.ok || response.status === 304) {
            if (!facts) void metadata().catch(() => {});
          }
          if (response.status !== 304) {
            if (!response.ok) throw new Error(`Dashboard refresh failed (${response.status}).`);
            const data = remember(await response.json());
            if (stopped) return;
            if (data.rev !== rev) await callback(data);
            rev = data.rev;
            etag = response.headers.get("ETag");
          }
        } catch (error) {
          if (!stopped) onError(error);
        } finally {
          if (!stopped) timer = setTimeout(poll, 15000);
        }
      };
      void poll();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
    /**
     * Records a click on an action. The hub checks it against the data this page last loaded, so a
     * changed item is refused. A `confirm` action then opens the shell's confirmation box.
     */
    async act(action, target, payload = null, options = {}) {
      const resolved = { ...target };
      const collection = latest?.collections?.[resolved.collection];
      if (resolved.key !== undefined) resolved.itemRev ??= collection?.items?.[resolved.key]?.rev;
      else resolved.collectionRev ??= collection?.rev;
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const click = {
        clickId: [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        action,
        target: resolved,
        payload,
        ...(options.confirmDuplicate ? { confirmDuplicate: true } : {}),
      };
      // Resend the same click after a network failure; the hub returns the original request.
      const send = async (attempt) => {
        try {
          return await post("/api/act", click);
        } catch (error) {
          if (error.status || attempt === 2) throw error;
          await new Promise((done) => setTimeout(done, 500 * (attempt + 1)));
          return send(attempt + 1);
        }
      };
      const result = await send(0);
      if (result.request.state === "awaiting-confirmation")
        await window.dopamine.confirm(result.request.requestId);
      notify();
      return result.request;
    },
    /** Asks the shell to show its confirmation box for a request awaiting confirmation. */
    async confirm(requestId) {
      const meta = await metadata();
      if (parent !== window) {
        parent.postMessage({ type: "dopamine:confirm", requestId }, new URL(meta.shell).origin);
        return;
      }
      // Opened directly, there is no shell around the page: go to it, and it draws the box.
      const url = new URL(meta.shell),
        query = new URLSearchParams(location.search);
      query.delete("dopamine-direct");
      query.set("dopamine-confirm", requestId);
      if (location.pathname !== "/") query.set("dopamine-path", location.pathname);
      url.search = query.toString();
      url.hash = location.hash;
      location.href = url.href;
    },
    requests: (filter = {}) =>
      request(`/api/actions${Object.keys(filter).length ? `?${new URLSearchParams(filter)}` : ""}`),
    /** The reader's choice on a request: retry, abandon, mark-done or run-again. */
    async choose(requestId, choice) {
      const result = await post("/api/request", { requestId, choice });
      if (result.request.state === "awaiting-confirmation")
        await window.dopamine.confirm(result.request.requestId);
      notify();
      return result.request;
    },
    /** Calls back with this dashboard's requests whenever they change. */
    watchRequests(callback, onError = () => {}) {
      let last,
        timer,
        stopped = false;
      const poll = async () => {
        clearTimeout(timer);
        let busy = false;
        try {
          const result = await window.dopamine.requests();
          const text = JSON.stringify(result);
          busy = result.requests.some((entry) =>
            [
              "awaiting-confirmation",
              "queued",
              "sending",
              "delivered",
              "failed",
              "claimed",
              "unresolved",
            ].includes(entry.state),
          );
          if (!stopped && text !== last) {
            last = text;
            await callback(result.requests);
          }
        } catch (error) {
          if (!stopped) onError(error);
        } finally {
          if (!stopped) timer = setTimeout(poll, busy ? 3000 : 15000);
        }
      };
      watchers.add(poll);
      void poll();
      return () => {
        stopped = true;
        watchers.delete(poll);
        clearTimeout(timer);
      };
    },
    view: {
      get: () => request("/api/view"),
      set: (value) =>
        request("/api/view", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        }),
    },
    meta: metadata,
  };
})();
