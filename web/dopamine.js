/* eslint-disable unicorn/consistent-function-scoping -- Keep the public client isolated from page globals. */
(() => {
  const fetchWithDeadline = (path, options) =>
    fetch(path, { ...options, signal: AbortSignal.timeout(15_000) });
  const request = async (path, options) => {
    const response = options ? await fetch(path, options) : await fetchWithDeadline(path);
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
  const dataReaders = new Set();
  const requestReaders = new Set();
  const initialReads = new Map();
  let refreshButton, freshness, staleTimer, checkedAt, refreshPending;
  let freshnessText = "Snapshot pending";
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
  const readAll = (readers) => Promise.all([...readers].map((read) => read()));
  const notify = () => void readAll(requestReaders);
  function showFreshness(text) {
    freshnessText = text;
    if (freshness) freshness.textContent = text;
  }
  function checked() {
    checkedAt = new Date();
    clearTimeout(staleTimer);
    showFreshness(
      `Checked at ${checkedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    );
    if (freshness) staleTimer = setTimeout(() => showFreshness("Stale snapshot"), 60_000);
  }
  function unverified(text) {
    checkedAt = undefined;
    clearTimeout(staleTimer);
    showFreshness(text);
  }
  function reportInitialReads() {
    if (refreshPending || !initialReads.size) return;
    const outcomes = [...initialReads.values()];
    if (outcomes.includes(false)) unverified("Refresh needed");
    else if (outcomes.every(Boolean)) checked();
    else unverified("Snapshot pending");
  }
  function refresh() {
    if (refreshPending) return refreshPending;
    if (refreshButton) refreshButton.disabled = true;
    refreshPending = Promise.resolve()
      .then(async () => {
        window.dispatchEvent(new Event("dopamine:refresh"));
        const results = await Promise.all([readAll(dataReaders), readAll(requestReaders)]);
        if (results.flat().every(Boolean)) checked();
        else unverified("Refresh failed");
      })
      .finally(() => {
        refreshPending = undefined;
        if (refreshButton) refreshButton.disabled = false;
      });
    return refreshPending;
  }
  function addRefreshControl() {
    if (refreshButton) return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", addRefreshControl, { once: true });
      return;
    }
    const control = document.createElement("aside");
    control.setAttribute("aria-label", "Dashboard snapshot");
    control.style.padding = "0.5rem 1rem";
    freshness = document.createElement("span");
    freshness.setAttribute("role", "status");
    freshness.textContent = freshnessText;
    refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.textContent = "Refresh";
    refreshButton.addEventListener("click", () => void refresh());
    control.append(freshness, " ", refreshButton);
    document.body.prepend(control);
    if (checkedAt) checked();
  }
  function observe(readers, load, onError) {
    let stopped = false;
    let pending = Promise.resolve();
    const active = () => !stopped;
    const update = () => {
      const result = pending.then(async () => {
        if (stopped) return true;
        try {
          await load(active);
          if (!stopped) initialReads.set(update, true);
          return true;
        } catch (error) {
          if (!stopped) {
            initialReads.set(update, false);
            onError(error);
          }
          return false;
        }
      });
      pending = result.catch(() => {});
      return result;
    };
    readers.add(update);
    initialReads.set(update, undefined);
    addRefreshControl();
    reportInitialReads();
    void update().then(() => {
      if (!stopped) reportInitialReads();
    });
    return () => {
      stopped = true;
      readers.delete(update);
      initialReads.delete(update);
    };
  }
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
    data: () => request("/data.json"),
    refresh,
    subscribe(callback, onError = () => {}) {
      let etag, rev;
      return observe(
        dataReaders,
        async (active) => {
          const response = await fetchWithDeadline("/data.json", {
            headers: etag ? { "If-None-Match": etag } : {},
          });
          if ((response.ok || response.status === 304) && !facts) void metadata().catch(() => {});
          if (response.status === 304) return;
          if (!response.ok) throw new Error(`Dashboard refresh failed (${response.status}).`);
          const data = await response.json();
          if (!active()) return;
          if (data.rev !== rev) await callback(data);
          if (!active()) return;
          // Clicks carry the revision the page rendered, so remember it only after rendering.
          remember(data);
          rev = data.rev;
          etag = response.headers.get("ETag");
        },
        onError,
      );
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
          // A hub or peer failure may have recorded the click; the same click ID finds it.
          if ((error.status && error.status < 500) || attempt === 2) throw error;
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
    /** Calls back with changed request state on load, Refresh or an action. */
    watchRequests(callback, onError = () => {}) {
      let last;
      return observe(
        requestReaders,
        async (active) => {
          const result = await window.dopamine.requests();
          const text = JSON.stringify(result);
          if (active() && text !== last) {
            await callback(result.requests);
            last = text;
          }
        },
        onError,
      );
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
