const sections = new Map(),
  cards = new Map();
const root = document.querySelector("#collections");
let saved = {},
  current,
  manifest,
  latestRequests = [],
  ready = false,
  debounce;
const requestBoxes = new Map(),
  requestsByItem = new Map(),
  notices = new Map();
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
const when = (at) =>
  `${new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at))} PT`;
const STATES = {
  "awaiting-confirmation": "Waiting for you to confirm",
  queued: "Queued",
  sending: "Sending…",
  delivered: "Delivered; waiting for the handler",
  failed: "Delivery failed; trying again",
  stalled: "Delivery stopped after five tries",
  ambiguous: "May have been delivered; check before retrying",
  abandoned: "Abandoned",
  claimed: "The handler is working on it",
  unresolved: "Unresolved: claimed over 30 minutes ago with no result",
  done: "Done",
  unknown: "The handler couldn't tell whether it ran",
};
const CHOICES = {
  "awaiting-confirmation": [["confirm", "Confirm…"]],
  failed: [["abandon", "Abandon"]],
  stalled: [
    ["retry", "Retry"],
    ["abandon", "Abandon"],
  ],
  ambiguous: [
    ["retry", "Retry"],
    ["abandon", "Abandon"],
  ],
  unknown: [
    ["mark-done", "Mark done"],
    ["run-again", "Run again"],
    ["abandon", "Abandon"],
  ],
};
function choose(request, choice) {
  const run =
    choice === "confirm"
      ? dopamine.confirm(request.requestId)
      : dopamine.choose(request.requestId, choice);
  void run.catch(showError);
}
function requestRow(request) {
  const row = el("div", undefined, `request ${request.state}`);
  const answer =
    request.payload && typeof request.payload.answer === "string"
      ? `: ${request.payload.answer}`
      : "";
  let text = `${request.label}${answer} · ${STATES[request.state] ?? request.state}`;
  if (request.state === "failed" && request.nextAttemptAt)
    text += ` at ${when(request.nextAttemptAt)}`;
  row.append(el("span", text));
  if (request.result) {
    const href = request.result.href && safeLink(request.result.href);
    if (href) {
      const a = el("a", request.result.label);
      a.href = href;
      row.append(" · ", a);
    } else row.append(el("span", ` · ${request.result.label}`));
  }
  for (const [choice, label] of CHOICES[request.state] ?? []) {
    const button = el("button", label);
    button.type = "button";
    button.addEventListener("click", () => choose(request, choice));
    row.append(button);
  }
  if (request.error) row.append(el("small", request.error));
  return row;
}
function drawRequests(stable) {
  const box = requestBoxes.get(stable);
  if (!box) return;
  // Keep every request that needs the reader; show only the latest few of the rest.
  const requests = requestsByItem.get(stable) ?? [];
  const latest = new Set(requests.slice(-3));
  const rows = requests
    .filter((request) => CHOICES[request.state] || latest.has(request))
    .toReversed()
    .map(requestRow);
  const notice = notices.get(stable);
  box.replaceChildren(...(notice ? [notice] : []), ...rows);
}
let otherRequests;
/** Requests that need the reader but have no item card, such as one for a deleted item. */
function drawOtherRequests() {
  const rows = latestRequests
    .filter(
      (request) =>
        CHOICES[request.state] &&
        !requestBoxes.has(JSON.stringify([request.target.collection, request.target.key])),
    )
    .map((request) => {
      const row = requestRow(request);
      row.prepend(el("strong", `${request.target.key ?? request.target.collection} · `));
      return row;
    });
  if (!otherRequests) {
    if (!rows.length) return;
    otherRequests = el("section");
    otherRequests.append(el("h2", "Other requests"), el("div"));
    root.after(otherRequests);
  }
  otherRequests.hidden = rows.length === 0;
  otherRequests.children[1].replaceChildren(...rows);
}
async function act(action, collection, key, itemRev, payload, confirmDuplicate = false) {
  const stable = JSON.stringify([collection, key]);
  notices.delete(stable);
  try {
    // The revision this card drew, so a click on a changed item is refused.
    await dopamine.act(action.name, { collection, key, itemRev }, payload, { confirmDuplicate });
  } catch (error) {
    const notice = el("div", error.message, "request notice");
    if (error.duplicateOf) {
      const again = el("button", "Send again");
      again.type = "button";
      again.addEventListener(
        "click",
        () => void act(action, collection, key, itemRev, payload, true),
      );
      notice.append(again);
    }
    notices.set(stable, notice);
  }
  drawRequests(stable);
}
function actionControls(name, key, itemRev, record) {
  const declared = (manifest?.actions ?? []).filter(
    (action) => action.scope === "item" && action.collections.includes(name),
  );
  if (!declared.length) return [];
  const buttons = el("div", undefined, "actions");
  const questions = manifest.collections?.[name]?.type === "questions";
  for (const action of declared) {
    const answers =
      questions && Array.isArray(record.options)
        ? record.options.map((option) => option?.label).filter((label) => typeof label === "string")
        : [];
    for (const answer of answers.length ? answers : [null]) {
      const button = el("button", answer ?? action.label);
      button.type = "button";
      button.addEventListener(
        "click",
        () => void act(action, name, key, itemRev, answer === null ? null : { answer }),
      );
      buttons.append(button);
    }
  }
  const stable = JSON.stringify([name, key]);
  const box = el("div", undefined, "requests");
  box.setAttribute("aria-live", "polite");
  requestBoxes.set(stable, box);
  return [buttons, box];
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
    section.hidden = collection.order.length === 0;
    for (const key of collection.order) {
      const item = collection.items[key];
      if (!item) continue;
      const stable = JSON.stringify([name, key]);
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
      content.append(el("small", `${item.by} · ${when(item.at)}`));
      content.append(...actionControls(name, key, item.rev, record));
      card.replaceChildren(content);
      drawRequests(stable);
      card.dataset.rev = String(item.rev);
      section.append(card);
    }
  }
  for (const [key, card] of cards)
    if (!active.has(key)) {
      card.remove();
      cards.delete(key);
      requestBoxes.delete(key);
    }
  drawOtherRequests();
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
  await loadMeta();
  dopamine.subscribe(render, showError);
  ready = true;
})();
addEventListener("dopamine:refresh", () => {
  if (!manifest) void loadMeta();
});
/** Reads the manifest, then turns on action buttons and requests. */
async function loadMeta() {
  try {
    const meta = await dopamine.meta();
    if (manifest) return;
    document.querySelector("#title").textContent = meta.manifest.title;
    document.title = meta.manifest.title;
    manifest = meta.manifest;
  } catch (error) {
    showError(error);
    return;
  }
  if (!manifest.actions?.length) return;
  if (current) {
    // Cards drawn before the manifest arrived have no buttons; draw them again.
    const data = current;
    current = { ...data, rev: Number.NaN };
    for (const card of cards.values()) card.dataset.rev = "";
    render(data);
  }
  dopamine.watchRequests((requests) => {
    latestRequests = requests;
    requestsByItem.clear();
    for (const request of requests) {
      const stable = JSON.stringify([request.target.collection, request.target.key]);
      requestsByItem.set(stable, [...(requestsByItem.get(stable) ?? []), request]);
    }
    for (const stable of requestBoxes.keys()) drawRequests(stable);
    drawOtherRequests();
  }, showError);
}
addEventListener("scroll", save, { passive: true });
