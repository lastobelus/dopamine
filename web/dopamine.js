/* eslint-disable unicorn/consistent-function-scoping -- Keep the public client isolated from page globals. */
(() => {
  const request = async (path, options) => {
    const response = await fetch(path, options);
    if (!response.ok) throw new Error(`Dashboard request failed (${response.status}).`);
    return response.json();
  };
  const metadata = request("/dopamine-meta.json");
  const tellLocation = () => {
    if (parent !== window)
      void metadata.then((meta) =>
        parent.postMessage(
          { type: "dopamine:location", url: location.href },
          new URL(meta.shell).origin,
        ),
      );
  };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      tellLocation();
      return result;
    };
  }
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
      event.preventDefault();
      void metadata.then((meta) =>
        parent.postMessage({ type: "dopamine:open", url: url.href }, new URL(meta.shell).origin),
      );
    }
  });
  if (parent === window && new URLSearchParams(location.search).get("dopamine-direct") === "1") {
    void metadata.then((meta) => {
      const back = document.createElement("a"),
        url = new URL(meta.shell),
        query = new URLSearchParams(location.search);
      query.delete("dopamine-direct");
      if (location.pathname !== "/") query.set("dopamine-path", location.pathname);
      url.search = query.toString();
      url.hash = location.hash;
      back.href = url.href;
      back.textContent = "← Back to dopamine";
      document.body.prepend(back);
    });
  }
  window.dopamine = {
    data: () => request("/data.json"),
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
          if (response.status !== 304) {
            if (!response.ok) throw new Error(`Dashboard refresh failed (${response.status}).`);
            const data = await response.json();
            etag = response.headers.get("ETag");
            if (data.rev !== rev && !stopped) {
              rev = data.rev;
              callback(data);
            }
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
    act: async () => {
      throw new Error("Dashboard actions are not available yet.");
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
    meta: () => metadata,
  };
})();
