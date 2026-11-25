const frame = document.querySelector("#dashboard");
const key = decodeURIComponent(location.pathname.slice(3));
let dashboard, frameOrigin, framing, destination;
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
  if (path !== null || params.size) url.search = params.toString();
  if (location.hash || path !== null) url.hash = location.hash;
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
    const owner = document.querySelector("#owner-thread");
    owner.hidden = !dashboard.ownerThreadUrl;
    if (dashboard.ownerThreadUrl) {
      owner.href = dashboard.ownerThreadUrl;
      owner.title = dashboard.manifest.owner?.title || "Owner thread";
    } else {
      owner.removeAttribute("href");
    }
    document.querySelector("#error").hidden = true;
    const base = dashboard.manifest.kind === "url" ? dashboard.manifest.url : dashboard.origin;
    if (destination !== undefined && destination !== base)
      history.replaceState(null, "", location.pathname);
    if (framing !== dashboard.frameAllowed || destination !== base) {
      const url = frameAddress();
      frameOrigin = url.origin;
      frame.hidden = !dashboard.frameAllowed;
      document.querySelector("#blocked").hidden = dashboard.frameAllowed;
      if (dashboard.frameAllowed) {
        frame.src = url.href;
      }
      framing = dashboard.frameAllowed;
      destination = base;
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
      params.set("dopamine-path", address.pathname);
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
  if (event.data.type === "dopamine:confirm") void showConfirmation(event.data.requestId);
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
const dialog = document.querySelector("#confirm");
const confirmButton = document.querySelector("#confirm-ok");
let confirming;
function field(name, value) {
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = name;
  detail.textContent = value;
  return [term, detail];
}
/** Draws the confirmation from the hub's stored request, never from anything the page sent. */
async function showConfirmation(requestId) {
  if (typeof requestId !== "string" || !/^r-[a-f0-9]{16}$/.test(requestId) || confirming) return;
  confirming = requestId;
  try {
    const response = await fetch(`/api/confirm/${encodeURIComponent(key)}/${requestId}`);
    if (!response.ok) throw new Error();
    const info = await response.json();
    if (info.dashboard.key !== key || info.request.transport !== "awaiting-confirmation")
      throw new Error();
    const { request } = info;
    const when = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Vancouver",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(request.at));
    document.querySelector("#confirm-title").textContent = `Confirm: ${request.label}`;
    document
      .querySelector("#confirm-fields")
      .replaceChildren(
        ...field("Dashboard", `${info.dashboard.title} · ${info.dashboard.machine}`),
        ...field("Item", info.item ?? request.target.collection),
        ...(request.payload === null
          ? []
          : field("Details", JSON.stringify(request.payload, null, 2))),
        ...field("Sent to", info.handler),
        ...field("Requested", `${when} PT`),
      );
    document.querySelector("#confirm-error").hidden = true;
    confirmButton.disabled = true;
    dialog.showModal();
    // A click meant for the page underneath must not land on Confirm.
    setTimeout(() => {
      confirmButton.disabled = false;
    }, 500);
  } catch {
    confirming = undefined;
  }
}
async function decide(decision) {
  const requestId = confirming;
  confirmButton.disabled = true;
  try {
    const response = await fetch(`/api/confirm/${encodeURIComponent(key)}/${requestId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "The hub refused this decision.");
    dialog.close();
    frame.contentWindow?.postMessage(
      { type: "dopamine:confirmed", requestId, state: result.request.state },
      frameOrigin,
    );
  } catch (error) {
    const message = document.querySelector("#confirm-error");
    message.textContent = error.message;
    message.hidden = false;
    confirmButton.disabled = false;
  }
}
confirmButton.addEventListener("click", () => void decide("confirm"));
document.querySelector("#confirm-cancel").addEventListener("click", () => void decide("cancel"));
// Escape closes the box and leaves the request waiting; the page can ask again.
dialog.addEventListener("close", () => {
  confirming = undefined;
});
const pending = new URLSearchParams(location.search).get("dopamine-confirm");
void refresh().then(() => {
  if (!pending) return;
  const params = new URLSearchParams(location.search);
  params.delete("dopamine-confirm");
  history.replaceState(
    null,
    "",
    `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`,
  );
  void showConfirmation(pending);
});
setInterval(() => void refresh(), 15000);
