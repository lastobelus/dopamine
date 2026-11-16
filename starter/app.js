const sections = new Map(),
  cards = new Map();
const root = document.querySelector("#collections");
let saved = {},
  current,
  ready = false,
  debounce;
const display = (value) =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function openKeys() {
  return [...document.querySelectorAll("details[open]")].map((node) => node.dataset.key);
}
function save() {
  if (!ready) return;
  clearTimeout(debounce);
  debounce = setTimeout(
    () => void dopamine.view.set({ open: openKeys(), scrollY: window.scrollY }).catch(showError),
    250,
  );
}
function showError(error) {
  const node = document.querySelector("#error");
  node.hidden = false;
  node.textContent = `${error.message} Showing the last version that loaded.`;
}
function safeLink(href) {
  try {
    const u = new URL(href, location.href);
    return ["https:", "http:", "t3-thread:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
function render(data) {
  if (data.rev === current?.rev) return;
  const scroll = current ? window.scrollY : Number(saved.scrollY) || 0;
  const opened = new Set(current ? openKeys() : Array.isArray(saved.open) ? saved.open : []),
    active = new Set();
  for (const [name, collection] of Object.entries(data.collections)) {
    let section = sections.get(name);
    if (!section) {
      section = el("section");
      section.append(el("h2", name));
      sections.set(name, section);
      root.append(section);
    }
    for (const key of collection.order) {
      const item = collection.items[key];
      if (!item) continue;
      const stable = `${name}/${key}`;
      active.add(stable);
      let card = cards.get(stable);
      if (card?.dataset.rev === String(item.rev)) {
        section.append(card);
        continue;
      }
      if (!card) {
        card = el("article", undefined, "item");
        cards.set(stable, card);
      }
      const content = document.createDocumentFragment();
      const value = item.value,
        record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      const title = typeof record.title === "string" ? record.title : key;
      const cite = el("button", "Cite");
      cite.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(
            `> [${document.querySelector("#title").textContent} · ${key}] ${title}`,
          );
          cite.textContent = "Copied";
        } catch {
          cite.textContent = "Couldn't copy";
        }
      });
      content.append(cite, el("h3", `${key} · ${title}`));
      if (typeof record.recommendation === "string") content.append(el("p", record.recommendation));
      if (record.value !== undefined && ["string", "number"].includes(typeof record.value))
        content.append(el("div", display(record.value), "metric"));
      const options = Array.isArray(record.options)
        ? record.options.filter(
            (option) => option && typeof option === "object" && typeof option.label === "string",
          )
        : [];
      if (options.length || record.context) {
        const details = el("details");
        details.dataset.key = stable;
        details.open = opened.has(stable);
        details.append(el("summary", "Context and options"));
        if (record.context) details.append(el("p", display(record.context)));
        for (const option of options) {
          details.append(el("p", option.label));
          if (option.pros)
            details.append(
              el(
                "p",
                `Pros: ${Array.isArray(option.pros) ? option.pros.map(display).join("; ") : display(option.pros)}`,
              ),
            );
          if (option.cons)
            details.append(
              el(
                "p",
                `Cons: ${Array.isArray(option.cons) ? option.cons.map(display).join("; ") : display(option.cons)}`,
              ),
            );
        }
        details.addEventListener("toggle", save);
        content.append(details);
      } else if (record.description || record.status)
        content.append(el("p", display(record.description ?? record.status)));
      else content.append(el("pre", JSON.stringify(value, null, 2)));
      for (const entry of Array.isArray(record.links) ? record.links : []) {
        if (!entry || typeof entry !== "object") continue;
        const href = typeof entry.href === "string" && safeLink(entry.href);
        if (href) {
          const a = el("a", display(entry.label ?? entry.href));
          a.href = href;
          content.append(a, document.createTextNode(" "));
        }
      }
      const when = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Vancouver",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(item.at));
      content.append(el("small", `${item.by} · ${when} PT`));
      card.replaceChildren(content);
      card.dataset.rev = String(item.rev);
      section.append(card);
    }
  }
  for (const [key, card] of cards)
    if (!active.has(key)) {
      card.remove();
      cards.delete(key);
    }
  for (const [name, section] of sections)
    if (!data.collections[name]) {
      section.remove();
      sections.delete(name);
    }
  current = data;
  document.querySelector("#empty").hidden = active.size > 0;
  document.querySelector("#error").hidden = true;
  const latest = Object.values(data.collections)
    .flatMap((c) => Object.values(c.items))
    .map((i) => i.at)
    .toSorted()
    .at(-1);
  document.querySelector("#updated").textContent = latest
    ? `Updated ${Math.max(0, Math.floor((Date.now() - Date.parse(latest)) / 60000))} min ago`
    : "";
  requestAnimationFrame(() => window.scrollTo(window.scrollX, scroll));
}
(async () => {
  try {
    saved = (await dopamine.view.get()) || {};
  } catch (error) {
    showError(error);
  }
  try {
    const meta = await dopamine.meta();
    document.querySelector("#title").textContent = meta.manifest.title;
    document.title = meta.manifest.title;
  } catch (error) {
    showError(error);
  }
  dopamine.subscribe(render, showError);
  ready = true;
})();
addEventListener("scroll", save, { passive: true });
