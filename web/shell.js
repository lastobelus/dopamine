const frame = document.querySelector("#dashboard");
const key = decodeURIComponent(location.pathname.slice(3));
let dashboard, frameOrigin, framing;
function frameAddress() {
  const base = dashboard.manifest.kind === "url" ? dashboard.manifest.url : dashboard.origin;
  const url = new URL(base);
  const params = new URLSearchParams(location.search);
  const path = params.get("dopamine-path");
  params.delete("dopamine-path");
  params.delete("dopamine-direct");
  params.delete("dopamine-confirm");
  if (path && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\"))
    url.pathname = path;
  if (params.size) url.search = params.toString();
  url.hash = location.hash;
  return url;
}
function updateDirect() {
  const direct = frameAddress();
  if (dashboard.manifest.kind === "page") direct.searchParams.set("dopamine-direct", "1");
  document.querySelector("#direct").href = direct.href;
  document.querySelector("#outside").href = direct.href;
}
async function refresh() {
  try {
    const response = await fetch(`/api/shell/${encodeURIComponent(key)}`);
    if (!response.ok)
      throw new Error(
        "Can't reach this dashboard right now. Anything shown below may be out of date.",
      );
    dashboard = await response.json();
    document.title = `${dashboard.manifest.title} · dopamine`;
    document.querySelector("#title").textContent =
      `${dashboard.manifest.title} · ${dashboard.manifest.machine}`;
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(dashboard.updatedAt)) / 60000));
    document.querySelector("#status").textContent =
      `updated ${minutes} min ago · ${dashboard.status}${dashboard.handlerState === "archived" ? " · handler thread archived" : ""}${dashboard.ownerState === "archived" ? " · thread archived" : ""}`;
    document.querySelector("#error").hidden = true;
    if (framing !== dashboard.frameAllowed) {
      const url = frameAddress();
      frameOrigin = url.origin;
      frame.hidden = !dashboard.frameAllowed;
      document.querySelector("#blocked").hidden = dashboard.frameAllowed;
      if (dashboard.frameAllowed) {
        frame.src = url.href;
      }
      framing = dashboard.frameAllowed;
    }
    updateDirect();
  } catch (error) {
    document.querySelector("#error").hidden = false;
    document.querySelector("#error").textContent = error.message;
  }
}
addEventListener("message", (event) => {
  if (
    !dashboard ||
    event.source !== frame.contentWindow ||
    event.origin !== frameOrigin ||
    !event.data ||
    typeof event.data !== "object"
  )
    return;
  if (event.data.type === "dopamine:location") {
    try {
      const address = new URL(event.data.url);
      if (address.origin !== frameOrigin) return;
      const params = new URLSearchParams(address.search);
      params.delete("dopamine-direct");
      params.delete("dopamine-confirm");
      if (address.pathname !== "/") params.set("dopamine-path", address.pathname);
      history.replaceState(
        null,
        "",
        `${location.pathname}${params.size ? `?${params}` : ""}${address.hash}`,
      );
      updateDirect();
    } catch {
      /* Ignore malformed page messages. */
    }
  }
  if (event.data.type === "dopamine:open") {
    try {
      const url = new URL(event.data.url);
      if (!["http:", "https:", "t3-thread:"].includes(url.protocol)) return;
      if (url.protocol === "t3-thread:") {
        const fallback = document.querySelector("#open-thread");
        fallback.href = url.href;
        fallback.hidden = false;
        setTimeout(() => {
          fallback.hidden = true;
        }, 10000);
        location.href = url.href;
      } else window.open(url.href, "_blank", "noopener");
    } catch {
      /* Ignore malformed links. */
    }
  }
});
void refresh();
setInterval(() => void refresh(), 15000);
