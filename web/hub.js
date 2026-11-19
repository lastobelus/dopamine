const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const ago = (at) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000));
  return minutes < 1 ? "updated just now" : `updated ${minutes} min ago`;
};
const link = (text, href) => {
  const a = el("a", text);
  a.href = href;
  return a;
};
const ownerLink = (dashboard, label = "Owner thread") => {
  const a = link(label, dashboard.ownerThreadUrl);
  a.title = dashboard.manifest.owner?.title || label;
  return a;
};
let signature;
async function refresh() {
  try {
    const response = await fetch("/api/index");
    if (!response.ok)
      throw new Error("Couldn't refresh the dashboard list. Showing the last list that loaded.");
    const result = await response.json();
    const next = JSON.stringify(result);
    document.querySelector("#error").hidden = true;
    if (signature === next) return;
    signature = next;
    const scroll = window.scrollY;
    const rows = document.querySelector("#dashboards");
    const questions = document.querySelector("#questions");
    rows.replaceChildren();
    questions.replaceChildren();
    document.querySelector("#count").textContent =
      `${result.dashboards.length} dashboard${result.dashboards.length === 1 ? "" : "s"}`;
    document.querySelector("#empty").hidden = result.dashboards.length > 0;
    const peer = document.querySelector("#peer");
    peer.hidden = result.peer?.reachable === true;
    peer.textContent = result.peer
      ? `Can't reach ${result.peer.machine}. Its dashboards will reappear when it's back.`
      : `Showing dashboards on ${result.machine} only.`;
    const needs = [];
    for (const d of result.dashboards) {
      const row = el("article", undefined, "row"),
        top = el("div", undefined, "row-top");
      const title = el("div", undefined, "row-title");
      title.append(link(d.manifest.title, d.url));
      const actions = el("div", undefined, "actions");
      const copy = el("button", "Copy link");
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(d.url);
          copy.textContent = "Copied";
        } catch {
          copy.textContent = "Couldn't copy";
        }
      });
      const remove = el("button", "Remove");
      let armed = false;
      remove.addEventListener("click", async () => {
        if (!armed) {
          armed = true;
          remove.textContent = "Confirm remove";
          setTimeout(() => {
            armed = false;
            remove.textContent = "Remove";
          }, 5000);
          return;
        }
        try {
          const removed = await fetch("/api/remove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: d.key }),
          });
          if (!removed.ok) throw new Error("Couldn't remove that dashboard. Try again.");
          signature = undefined;
          await refresh();
        } catch (error) {
          document.querySelector("#error").hidden = false;
          document.querySelector("#error").textContent = error.message;
        }
      });
      actions.append(copy, remove);
      top.append(title, actions);
      const meta = el("div", undefined, "meta"),
        dot = el("span", undefined, `dot ${d.status}`);
      meta.append(dot, el("span", `${d.manifest.machine} · ${ago(d.updatedAt)} · ${d.status}`));
      if (d.manifest.pinned) meta.append(el("span", "Pinned"));
      if (d.ownerState === "archived") meta.append(el("span", "Thread archived"));
      if (d.ownerThreadUrl) meta.append(ownerLink(d, d.manifest.owner?.title));
      row.append(top, meta);
      rows.append(row);
      for (const [name, declaration] of Object.entries(d.manifest.collections)) {
        if (declaration.type !== "questions") continue;
        const collection = d.data.collections[name];
        for (const key of collection?.order ?? []) {
          const item = collection.items[key];
          if (item && (!item.value.status || item.value.status === "open"))
            needs.push({ d, key, item });
        }
      }
    }
    needs.sort((a, b) => b.item.at.localeCompare(a.item.at));
    for (const { d, key, item } of needs) {
      const row = el("article", undefined, "row question");
      row.append(link(`${d.manifest.title} · ${key}`, d.url), el("p", item.value.title));
      if (item.value.recommendation) row.append(el("p", item.value.recommendation, "muted"));
      if (d.ownerThreadUrl) {
        const meta = el("div", undefined, "meta");
        meta.append(ownerLink(d));
        row.append(meta);
      }
      questions.append(row);
    }
    document.querySelector("#needs").hidden = needs.length === 0;
    window.scrollTo(window.scrollX, scroll);
  } catch (error) {
    document.querySelector("#error").hidden = false;
    document.querySelector("#error").textContent = error.message;
  }
}
void refresh();
setInterval(refresh, 15000);
