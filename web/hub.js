const $ = (selector) => document.querySelector(selector);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const link = (text, href, className) => {
  const a = el("a", text, className);
  a.href = href;
  return a;
};
const SVG = "http://www.w3.org/2000/svg";
const ICONS = {
  link: [
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  ],
  check: ["M20 6 9 17l-5-5"],
  trash: [
    "M3 6h18",
    "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
    "M10 11v6M14 11v6",
    "M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
  ],
};
const icon = (name) => {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
};
const age = (at) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
};
const ageLabel = (node) => {
  const when = age(node.dataset.at);
  node.textContent = node.dataset.state ? `${node.dataset.state} · ${when}` : when;
};
const health = (status) =>
  status === "unreachable" ? "down" : status === "stale" ? "stale" : "ok";

// Use the project title for a fallback while its icon loads.
const PALETTE = [
  "#3b82f6",
  "#a855f7",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#0ea5e9",
  "#ec4899",
  "#84cc16",
];
const colour = (text) => {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
};
const initials = (text) => {
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
};
const tile = (project, fallback, size, status) => {
  const node = el("span", undefined, `tile ${size}`);
  const label = el("span", initials(project?.title ?? fallback));
  node.append(label);
  node.setAttribute("aria-hidden", "true");
  if (project) node.style.setProperty("--tile", colour(project.title));
  else node.classList.add("unknown");
  if (project?.iconUrl) {
    const image = el("img", undefined, "tile-image");
    image.alt = "";
    image.hidden = true;
    image.addEventListener(
      "load",
      () => {
        label.hidden = true;
        image.hidden = false;
      },
      { once: true },
    );
    image.src = project.iconUrl;
    node.append(image);
  }
  if (status) node.append(el("span", undefined, `tile-status ${status}`));
  return node;
};
// The hub supplies ownerThreadUrl, a scoped LastCode link for the owner thread.
const ownerLink = (d) => {
  const label = d.manifest.owner?.title || "Owner thread";
  const a = link(`${label} ↗`, d.ownerThreadUrl, "owner-link");
  a.title = label;
  return a;
};
const iconButton = (name, label, className) => {
  const button = el("button", undefined, `icon-button ${className}`);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  return button;
};
const showError = (message) => {
  $("#error").hidden = false;
  $("#error").textContent = message;
};

const FILTERS = [
  ["all", "All"],
  ["needs", "Needs you"],
  ["pinned", "Pinned"],
  ["problems", "Problems"],
];
const query = new URLSearchParams(location.search);
const view = {
  show: FILTERS.some(([key]) => key === query.get("show")) ? query.get("show") : "all",
  project: query.get("project"),
};
const matchesShow = (item, show) =>
  show === "all" ||
  (show === "needs" && item.questions.length > 0) ||
  (show === "pinned" && item.d.manifest.pinned) ||
  (show === "problems" && item.health !== "ok");
const matchesProject = (item) => !view.project || item.project?.id === view.project;
function remember() {
  const params = new URLSearchParams();
  if (view.show !== "all") params.set("show", view.show);
  if (view.project) params.set("project", view.project);
  const search = params.toString();
  history.replaceState(null, "", search ? `?${search}` : location.pathname);
}

function openQuestions(d) {
  const open = [];
  for (const [name, declaration] of Object.entries(d.manifest.collections)) {
    if (declaration.type !== "questions") continue;
    const collection = d.data.collections[name];
    for (const key of collection?.order ?? []) {
      const item = collection.items[key];
      if (item && (!item.value.status || item.value.status === "open")) open.push({ key, item });
    }
  }
  return open;
}

function chip(label, count, pressed, onClick, project) {
  const button = el("button", undefined, project ? "chip project-chip" : "chip");
  button.type = "button";
  button.setAttribute("aria-pressed", String(pressed));
  if (project) button.append(tile(project, project.title, "tiny"));
  button.append(el("span", label), el("span", String(count), "chip-count"));
  button.addEventListener("click", onClick);
  return button;
}

function renderFilters(items) {
  const nav = $("#filters");
  nav.replaceChildren();
  nav.hidden = items.length === 0;
  const scoped = items.filter(matchesProject);
  for (const [key, label] of FILTERS) {
    const count = scoped.filter((item) => matchesShow(item, key)).length;
    nav.append(
      chip(label, count, view.show === key, () => {
        view.show = key;
        update();
      }),
    );
  }
  const projects = new Map();
  for (const item of items)
    if (item.project) {
      const entry = projects.get(item.project.id) ?? { project: item.project, count: 0 };
      entry.count += 1;
      projects.set(item.project.id, entry);
    }
  if (projects.size < 2 && !view.project) return;
  nav.append(el("span", undefined, "filter-divider"));
  for (const { project, count } of projects.values())
    nav.append(
      chip(
        project.title,
        count,
        view.project === project.id,
        () => {
          view.project = view.project === project.id ? null : project.id;
          update();
        },
        project,
      ),
    );
}

function renderQuestion({ d, project, key, item }) {
  const row = el("article", undefined, "question");
  const source = el("div", undefined, "question-source");
  const when = el("span", undefined, "age");
  when.dataset.at = item.at;
  ageLabel(when);
  source.append(tile(project, d.manifest.title, "small"), link(d.manifest.title, d.url));
  source.append(el("span", key), when);
  if (d.ownerThreadUrl) source.append(ownerLink(d));
  const body = el("div", undefined, "question-body");
  body.append(source, el("p", item.value.title, "question-title"));
  if (item.value.recommendation)
    body.append(el("p", item.value.recommendation, "question-recommendation"));
  row.append(body, link("Answer →", d.url, "answer"));
  return row;
}

function renderRow({ d, project, questions, health: state }) {
  const row = el("article", undefined, `row ${state}`);
  const main = el("div", undefined, "row-main");
  const title = el("div", undefined, "row-title");
  title.append(link(d.manifest.title, d.url));
  if (d.manifest.pinned) title.append(el("span", "Pinned", "tag"));
  if (questions.length) {
    const count = el("span", String(questions.length), "tag needs");
    count.title = `${questions.length} open question${questions.length === 1 ? "" : "s"}`;
    title.append(count);
  }
  const meta = el("div", undefined, "meta");
  if (project) meta.append(el("span", project.title));
  meta.append(el("span", d.manifest.machine));
  if (d.ownerThreadUrl) meta.append(ownerLink(d));
  if (d.ownerState === "archived") meta.append(el("span", "thread archived"));
  main.append(title, meta);

  const when = el("span", undefined, `age ${state}`);
  when.dataset.at = d.updatedAt;
  if (state === "stale") when.dataset.state = "stale";
  if (state === "down") when.dataset.state = "unreachable";
  ageLabel(when);

  const actions = el("div", undefined, "actions");
  const copy = iconButton("link", "Copy link", "copy");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(d.url);
      copy.replaceChildren(icon("check"));
      copy.title = "Copied";
    } catch {
      copy.title = "Couldn't copy";
    }
    copy.setAttribute("aria-label", copy.title);
    setTimeout(() => {
      copy.replaceChildren(icon("link"));
      copy.title = "Copy link";
      copy.setAttribute("aria-label", copy.title);
    }, 2000);
  });
  const remove = iconButton("trash", "Remove", "remove");
  let armed = false;
  remove.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      remove.classList.add("armed");
      remove.replaceChildren("Confirm remove");
      setTimeout(() => {
        armed = false;
        remove.classList.remove("armed");
        remove.replaceChildren(icon("trash"));
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
      showError(error.message);
    }
  });
  actions.append(copy, remove);
  row.append(tile(project, d.manifest.title, "large", state), main, when, actions);
  return row;
}

let signature;
let result;
function update() {
  remember();
  if (result) render();
}
function render() {
  const scroll = window.scrollY;
  const items = result.dashboards.map((d) => {
    const questions = openQuestions(d);
    return { d, questions, project: d.project ?? null, health: health(d.status) };
  });
  if (view.project && !items.some((item) => item.project?.id === view.project)) {
    view.project = null;
    remember();
  }
  renderFilters(items);

  const count = result.dashboards.length;
  $("#count").textContent = `${count} dashboard${count === 1 ? "" : "s"}`;
  $("#empty").hidden = count > 0;
  const peer = $("#peer");
  peer.hidden = result.peer?.reachable === true;
  peer.textContent = result.peer
    ? `Can't reach ${result.peer.machine}. Its dashboards will reappear when it's back.`
    : `Showing dashboards on ${result.machine} only.`;

  const scoped = items.filter(matchesProject);
  const needs = scoped
    .flatMap((entry) => entry.questions.map((question) => ({ ...entry, ...question })))
    .toSorted((a, b) => b.item.at.localeCompare(a.item.at));
  $("#questions").replaceChildren(...needs.map(renderQuestion));
  $("#needs-count").textContent = String(needs.length);
  $("#needs").hidden = needs.length === 0 || !["all", "needs"].includes(view.show);

  const shown = scoped.filter((item) => matchesShow(item, view.show));
  $("#dashboards").replaceChildren(...shown.map(renderRow));
  $("#dashboards").hidden = shown.length === 0;
  $("#unmatched").hidden = count === 0 || shown.length > 0;
  window.scrollTo(window.scrollX, scroll);
}

async function refresh() {
  try {
    const response = await fetch("/api/index");
    if (!response.ok)
      throw new Error("Couldn't refresh the dashboard list. Showing the last list that loaded.");
    const next = await response.json();
    const text = JSON.stringify(next);
    $("#error").hidden = true;
    if (signature === text) {
      for (const node of document.querySelectorAll("[data-at]")) ageLabel(node);
      return;
    }
    signature = text;
    result = next;
    render();
  } catch (error) {
    showError(error.message);
  }
}
// The logo shares the favicon; keep the heading clean if it isn't served yet.
$("#logo").addEventListener("error", () => $("#logo").remove());
if ($("#logo").complete && !$("#logo").naturalWidth) $("#logo").remove();
$("#clear").addEventListener("click", () => {
  view.show = "all";
  view.project = null;
  update();
});
void refresh();
setInterval(refresh, 15000);
