/* eslint-disable unicorn/consistent-function-scoping -- Keep the public client isolated from page globals. */
(() => {
  const request = async (path, options) => {
    const response = await fetch(path, options);
    if (!response.ok) throw new Error(`Dashboard request failed (${response.status}).`);
    return response.json();
  };
  let facts, metadataRequest, back;
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
            const data = await response.json();
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
    meta: metadata,
  };
})();
