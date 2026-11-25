# Dopamine

**Status:** In Progress. Phase 1a is built and deployed; its acceptance checks are partly observed (see "Phase 1a is done when"). Phase 1b (actions) is built and tested; its acceptance checks wait for a deployed installation (see "Phase 1b is done when"). Phase 2 is a LastCode change and the owner's call. Phase 3 is decided after a week of real use.

This plan describes dopamine itself, for anyone running it with LastCode or T3 Code across more than one environment. It never names a particular installation. A specific installation keeps its own private plan: which machines, ports, service files and tunnels it uses, and which of the acceptance checks below it has observed.

**Dopamine is a tiny tool that makes it convenient for agents to stand up ad hoc dashboards they can update, and which can outlive the thread that made them.** The reader looks at them beside any thread, and the reader's clicks on them can reach threads. It is a transport and a thin GUI, not a framework: agents decide what to show and how to use it.

## Goal

People who run many agent threads keep thread dashboards: pages showing open questions, decisions, live status and follow-ups. Without dopamine, each one is reachable only from the thread that made it, copies pile up, and the page dies when its thread's preview server sleeps. Dopamine gives:

1. **Any dashboard beside the thread you are talking to**, in the right panel, whichever environment that thread runs in. This is the hard requirement. Anything not beside the current thread is context switching: floating windows and pages that replace the chat are rejected.
2. **No hunting**: reach any dashboard without finding the thread that made it.
3. **One copy**: no pile of identical tabs.
4. **Every environment**: dashboards from every environment in one list.
5. **Standalone too**: the same pages open in an ordinary browser or as an installed web app on the desktop machine.
6. **Removal**: the reader can remove a dashboard, and the hub itself can be uninstalled.
7. **Actions and contributors**: buttons that send work to a thread, and several threads, in any environment, updating one dashboard.

## Design in one paragraph

The LastCode or T3 Code desktop app runs on one machine, the **desktop machine**, and its browser panel runs there for every thread, local or remote. So **the hub on the desktop machine is the viewing hub**, and every thread's panel opens it. LastCode rewrites only `localhost`, `127.0.0.1`, `0.0.0.0` and `::1` to a remote environment's address (`packages/shared/src/preview.ts`, `apps/web/src/browser/browserTargetResolver.ts`); names under `.localhost` are not rewritten, and Chromium resolves every `*.localhost` name to the desktop's own loopback. So a viewing origin such as `http://dopamine.localhost:<port>/` opens the desktop machine's hub as a desktop tab beside a remote thread too, with the element picker. **Each dashboard gets its own origin**, `http://<id>--<machine>.<dashboard domain>:<port>/`, so a page written by an agent can read and act only on its own dashboard. **The reader sees every dashboard inside a thin hub shell** at `<viewing origin>/d/<key>`: the dashboard runs in a full-size frame, and the shell, which the page cannot reach, draws the status strip and, in phase 1b, the confirmation modal. **Agent-written pages are the main path:** a thread writes ordinary HTML, CSS and JavaScript once, publishes it with `dash publish`, and afterwards posts only small data updates; a starter page is there to copy. A small always-on hub runs on each machine that hosts environments: a Node server in TypeScript, run directly by Node's type stripping, with no runtime dependencies, kept alive by the machine's service manager. Each hub serves its own machine's dashboards; the viewing hub also lists and proxies its peer's through a transport the user provides. **The hub is the only process that writes dashboard files**; `dash` is a thin client of its write API.

## Where dopamine lives

- **This public repository** holds the harness-neutral core: the hub, `dash`, `dopamine.js`, the starter page, the `dashboard` skill, and a generic deploy script that reads a private config. Paths written `dopamine/…` mean this repository.
- **Every installation detail is private**: machine names, ports, paths, service definitions, SSH and tunnel settings, the deploy configuration, and where the token and peer credential live. They belong in the installer's own private configuration and plans, never here. See AGENTS.md for the privacy check before every push.
- **Harness-neutral core:** Claude Code, Codex CLI or stock T3 Code can use the hub through `dash` or plain HTTP.
- **Harness-specific parts are adapters:** the default writer identity (`T3CODE_THREAD_ID` in LastCode and T3 Code shells), thread state and project icons for the index, and, in phase 1b, delivering a click to a thread (`lastcode-thread send` for LastCode and T3 Code; a pull form, `dash action next --wait`, for harnesses with no inbox).
- **LastCode gets no dopamine code.** Phase 2's panel conveniences are LastCode's own.

## Where each goal is met

| Goal                     | Phase 1a                                                            | Phase 1b   | Phase 2 (LastCode PR)                          | Phase 3 (decision)  |
| ------------------------ | ------------------------------------------------------------------- | ---------- | ---------------------------------------------- | ------------------- |
| 1. Beside any thread     | A "Dashboards" project Action opens the hub in that thread's panel  |            | [+] → Dashboards                               | The tab follows you |
| 2. No hunting            | Hub index                                                           |            | [+] → Dashboards                               |                     |
| 3. One copy              | One copy per thread you open it in; repeated link clicks still copy |            | Link clicks and agent opens reuse the open tab | One copy in total   |
| 4. Every environment     | The viewing hub lists and proxies its peer's dashboards             |            |                                                |                     |
| 5. Standalone            | Browser or installed web app on the desktop machine                 |            |                                                |                     |
| 6. Removal               | Remove, restore, uninstall                                          |            |                                                |                     |
| 7. Actions, contributors | `dash` from any environment; agent-written pages                    | Actions ✅ |                                                |                     |

## Setting up environments for dopamine

Dopamine assumes a LastCode or T3 Code desktop app on one machine, with threads running in local and remote environments. An installation needs the following. The concrete values go in private configuration (`docs/api.md` lists the fields).

1. **Choose the desktop machine.** Its hub is the viewing hub. Every other machine that hosts environments runs its own hub and is the viewing hub's peer.
2. **Run one hub per machine**, bound to loopback only, under the machine's service manager with a pinned Node version, so it survives restarts and reboots. `bin/deploy.ts` installs a clean committed snapshot from private templates and rolls back if the new hub fails its health check. The hub's bind address is never widened to make anything work.
3. **Pick the viewing origin and dashboard domain.** Use a `.localhost` name (for example `http://dopamine.localhost:<port>`) so LastCode does not rewrite it for remote threads. Every hub in the installation shares the same `viewingOrigin` and `dashboardDomain`. If `*.localhost` does not reach the desktop machine's loopback from the panel, use fallback A or B (below).
4. **Connect the peer.** Provide an authenticated loopback-to-loopback transport from the desktop machine to the peer hub, for example an SSH local forward kept alive by the service manager. Configure the viewing hub's `peer` (`{machine, hubId, origin, host}`) and give both hubs the same peer credential file. The viewing hub trusts the transport only when the peer's `/healthz` names the expected machine and hub ID and its origin settings match, so a stray service on that port shows as unreachable. The current implementation supports one peer.
5. **Route writes between machines.** A thread on one machine writes to a dashboard on another by running `dash` there over SSH. Configure `remotes` with the host and remote `dash` path, and make key-based, non-interactive SSH work in each direction that threads write.
6. **Configure identity.** Set the `adapter` so `dash` trusts `T3CODE_THREAD_ID` only inside the expected LastCode home and records the environment ID with it. Other harnesses pass `--as <environment>/<thread>`.
7. **Put `dash` on agents' `PATH`**, ahead of the system shell also named `dash`, or tell agents the full path. The skill explains how to tell them apart.
8. **Add the panel entry.** In each project's local settings (never a committed `t3.json`, because the port is private), add a project script named "Dashboards" with a harmless `command` such as `echo <viewing origin>/`, an icon, `previewUrl: <viewing origin>/` and `autoOpenPreview: true`. Running it from the Actions menu opens the hub in that thread's panel.
9. **Install the skill.** Make `skills/dashboard/SKILL.md` available to every agent harness the installation uses.
10. **Register existing dashboard servers** as `url` dashboards under a `.localhost` name, and add that name to the server's allowed hosts. A `url` server on a peer machine needs its port forwarded to the desktop machine; `urlOverrides` maps it to the forwarded address.

### Fallbacks for the viewing address

- **Fallback A, an alias.** If `*.localhost` does not reach the desktop machine from the panel, add hosts-file aliases on the desktop machine (one for the hub, one per `url` dashboard), which LastCode also leaves alone. A hosts file has no wildcards, so each dashboard then gets its own origin by port instead of by name.
- **Fallback B, symmetric hubs**, only if no name works: see the appendix. It needs the phase 2 [+] entry for remote threads.

## Phase 1a: hubs, `dash`, pages, panel entry ✅ built

`docs/api.md` is the reference for what is built. This section records the design and why.

### Naming

A dashboard lives on one machine, in the hub's data root. Its ID is a lowercase slug of letters, digits and single hyphens, unique on its machine. On the command line it is `<id>` on its own machine or `<machine>/<id>`. Its **key**, `<id>--<machine>`, names its origin. Dashboard content never enters Git.

### The contract

The hub owns persistence, revisions and attribution, and in phase 1b the action log. It does not know what a page shows.

- The manifest (`dashboard.json`) is written only through `dash create` and `dash update-manifest`. `kind` is `page` (the hub serves the dashboard's own files from its origin) or `url` (a dashboard with its own server, framed by the shell).
- Data (`data.json`) is written only by the hub. Every write is stamped with `rev`, `by`, `via` and `at`; `value` is any JSON up to 64 KB. `rev` comes from one counter per dashboard and is never reused, even after a delete and re-create.
- Rows the reader can act on separately should be separate items, so a change to one does not invalidate buttons on the others.
- **Generic by default, with declared types.** A collection may declare a type, which the hub then checks. The only declared type is `questions`: `{title, recommendation?, context?, options: [{label, pros?, cons?}], status?}`. The index gathers every open question into one **Needs you** list. New types are added only when the same shape keeps recurring.

### `dash` and the single writer

Only the hub writes dashboard files, one in-process lock per dashboard, with temp-file, `fsync` and rename. `dash` retries a stopped hub for 30 seconds, then fails with a clear message. Writes need a private token; reads do not. The writer identity is caller-asserted and recorded as `by`. Every command prints one line on success, so updates cost little chat history. Writer convention: the coordinator owns ordered collections (`dash set-collection`); each child posts only under its own keys.

### The hub, the shell and origins

- **Control origin** (the viewing origin): the index, the shell at `/d/<key>`, `/healthz`, and the write API (direct loopback only, with the token).
- **The shell** frames the dashboard's origin full-size under a sandbox that lets the page run and open popups but not navigate the shell. It draws the status strip: back to the index, title, machine, last update, stale badge, owner thread, **Open directly**. It accepts `postMessage` only from its own frame and exact origin: `dopamine:location` (mirror the page's address) and `dopamine:open` (open a link at top level).
- **Links through the shell.** A page's untargeted links that leave the dashboard (`t3-thread:`, or `http(s)` on another origin) go to the shell as `dopamine:open`. Web links open in a new tab. A thread link is set at top level and the strip also shows an **Open thread** link for a few seconds. LastCode opens a thread link only right after a trusted click in the panel tab's top-level page (`packages/shared/src/server/threadLinkGesture.ts`), and a click inside a cross-site frame does not count, so the relayed jump is usually declined and the reader clicks **Open thread**. A `target="_blank"` thread link inside the frame is not handled by LastCode either. `url` dashboards that want working thread links should send them through `dopamine:open` too.
- **Open directly** reloads the dashboard outside the shell (`?dopamine-direct=1` for a page dashboard), for the element picker or anything the frame blocks. The picker cannot reach into a cross-origin frame, so it selects the whole frame inside the shell.
- **Dashboard origins** serve only their own files, `data.json` (with `ETag`), `/dopamine.js`, attachments and `/api/view`. No path reaches another dashboard or the control routes. State changes need the exact dashboard `Origin`. Page responses carry a strict content security policy: no runtime CDN loads, `frame-ancestors` limited to the viewing origin. A top-level load of a dashboard origin redirects into its shell.
- **The peer proxy.** The viewing hub reverse-proxies peer dashboards' origins, discards incoming forwarding headers, derives the key from the validated `Host`, adds the peer credential, and never forwards the write API.
- **Freshness.** A page dashboard is stale after `staleAfterMinutes` without a write; a `url` dashboard shows reachable or unreachable from a short probe; an archived owner thread shows "thread archived".

### Pages

- Agent-written pages are the main path. `dopamine.js` offers `data()`, `subscribe()`, and `view.get()`/`view.set()`, over a plain HTTP API a page may use directly.
- **Refresh rules for every page:** redraw only when `rev` changes; keep open disclosures by stable key; keep scroll position; keep the last good copy on a failed read; save the reader's place through `/api/view`, never browser storage (LastCode partitions browser storage per environment, so a tab beside a remote thread would not see it).
- After publishing, the agent checks the page at its shell address (`dash url`) in a background tab.

### Removal and uninstall

`dash remove` or the index's Remove keeps a recoverable copy for seven days; `dash restore` brings back the newest one unless the ID is in use again. `bin/uninstall.ts` removes the services and app and keeps data unless `--purge` is given.

### Phase 1a is done when

Observed on an installation with a desktop machine and one peer machine, not inferred:

1. Both hubs and the peer transport run under the service manager and come back after a reboot of each machine.
2. In threads on both machines, the "Dashboards" Action opens the viewing hub beside the thread, as a desktop tab with the picker.
3. Beside a thread on each machine, the index lists page and `url` dashboards from both machines, and each opens inside the shell with its strip. A PR link and a thread link clicked inside the shell, on a page dashboard and on a `url` dashboard, open (a thread link through the **Open thread** fallback), and the same links work through Open directly. Opening a page dashboard's own origin directly lands in its shell.
4. On the desktop machine, the hub opens in an ordinary browser and as an installed web app; Copy link works there, and opening a dashboard from the index stays inside the app.
5. Threads on both machines post to one dashboard at the same moment, and both entries appear.
6. A dashboard on the peer machine is removed from the index and restored.
7. An agent-written page with a chart library and tabs, published with `dash publish`, opens beside threads on both machines and updates from `dash post` without being republished.
8. A disclosure stays open and the page does not scroll across an update; opening the dashboard beside a thread on the other machine restores the open disclosure.
9. All tests pass.

**Observed so far on the reference installation (Nov 23):** 5 (posted from both machines within 139 ms, by `dash` from one thread), 6 (removed from the index, restored with its data), 9 (94 tests). The rest need a person at the desktop or a reboot. Each installation records its own observations in its private plan.

## Phase 1b: actions ✅ built

`docs/api.md` ("Actions") is the reference for what is built. This section records the design and why; "Built differently" at its end lists where the build departs from it.

### Accepting a click

A click posts `{clickId, action, target, payload, confirmDuplicate?}`, where `target` is `{collection, key, itemRev}` or, for a `collection`-scoped action, `{collection, collectionRev}`; the page makes `clickId` once per click. The dashboard's own hub, under the lock:

1. Checks `Origin`, `Content-Type`, body under 32 KB and valid JSON. A known `clickId` whose canonical click (all fields, serialised with sorted keys) matches the stored one returns its existing request; the same `clickId` with different contents is refused. Otherwise it checks that `action` is declared for the collection and scope; that the target exists and its `rev` matches (else 409 "this changed; look again"); that the payload is within `maxPayloadBytes` and, on a `questions` collection, that an answer is one of the item's option labels; that the handler is available (a thread handler's thread exists and is not archived; a pull handler is always available, with "not polling" shown after 24 idle hours); and, for `oncePerItem`, that no earlier request for that item is open or done unless `confirmDuplicate` is set.
2. Appends `{requestId, clickId, click, status: "queued", dashboard, target, snapshot, action, payload, handler, at}` to `actions.jsonl`, `fsync`s, and replies 202 with the request ID. The message to the handler is built from this snapshot, never from page text.
3. **Actions declared `confirm`** are recorded as `awaiting-confirmation`. `act()` in `dopamine.js` asks the shell to confirm, and the shell draws a modal from the stored request (`GET /api/confirm/<key>/<requestId>`, through the peer channel for a peer dashboard), every field as text. The page sits underneath in another origin and cannot see, click or cover it. Confirm stays disabled for half a second. Confirm and Cancel post with `fetch` and the exact control `Origin`; forms, missing, `null` or dashboard origins are refused. Under the lock, Confirm allows only `awaiting-confirmation → queued` and Cancel only `awaiting-confirmation → abandoned`. In direct mode there is no shell, so `act()` navigates back to `/d/<key>?dopamine-confirm=<requestId>&dopamine-path=<path>…`, and the shell draws the modal if that request belongs to this dashboard and still awaits confirmation. A confirmation drawn by the page itself proves nothing.

### Request state

Each request has independent fields, reduced from `actions.jsonl` in order:

- **`transport`**: (`awaiting-confirmation` →) `queued` → `sending` → `delivered`, or `failed` (retryable), `stalled`, `ambiguous`, `abandoned`. Written only by the worker and by Retry or Abandon.
- **`mayBeDelivered`**: set the first time any attempt reaches `sending`, or a pull lease is issued; never cleared.
- **`handling`**: `unclaimed` → `claimed` → `done`, or `unknown`, or `abandoned`. Written only by `dash action claim`, `ack` and the reader's choices.

A transport record never changes `handling`, and once `handling` leaves `unclaimed` it never returns. Every transition is a locked append that checks the current reduced state first.

### Delivering

One queue per handler thread. Delivery uses `lastcode-thread send <threadId> - --json` with the message on stdin, the form that returns the message and run IDs; a test pins its response shape. Each queue, in order:

1. Under the lock: skip the request if `handling` is not `unclaimed` or the dashboard is gone; otherwise append `transport: sending` and `fsync`. Release the lock and send.
2. Send `[dashboard action] {dashboard, requestId, target, action, payload}` to the handler's machine, locally or over SSH. Record `transport: delivered` with the receipt.
3. **Retry automatically only with affirmative evidence nothing was sent**: for another machine, a separate SSH reachability check before the send fails. No CLI outcome counts as evidence. Then `failed`, retried after 1, 5 and 15 minutes, then hourly, `stalled` after five attempts until Retry or Abandon.
4. **Anything else is ambiguous** (a failure during the send, a timeout, an unparseable reply, a `sending` record with no outcome at start-up): never resent automatically. The page shows Retry and Abandon while `handling` is `unclaimed`; Retry sends again with the same request ID.

### Handling (the at-most-once rule)

- `dash action claim <name> <requestId> --as <handler>` succeeds exactly once, under the lock, when `--as` equals the handler recorded when the request was accepted, `handling` is `unclaimed`, `transport` is not `abandoned`, and `mayBeDelivered` is set. It returns the logged action, snapshot and payload, which the handler acts on, never the message text. A late delivery after `ambiguous` can still claim; the first claim wins. Retry is refused once claimed.
- A message whose request the log does not show is ignored: any local process can send a thread a lookalike message; only a successful claim makes it an action.
- `dash action ack … --result-json '{"status": "done", "result": {"label", "href"}}'` sets `handling: done`; a second ack is refused. The page shows the result on the item.
- **Crash between claim and ack.** A claim with no ack after 30 minutes shows **unresolved**. The handler reconciles by looking for evidence, such as a launched thread whose brief carries the request ID; if found it acks, otherwise it acks `unknown` and the page offers Mark done, Run again and Abandon.
- `GET /api/actions?key=<key>` returns that item's requests for the page.
- **Harnesses with no inbox** name a pull handler, `{"kind": "pull", "name": "<name>"}`. `dash action next <dashboard> --handler <name> --wait` blocks until a request is queued, then under the lock gives it a 5-minute lease, sets `mayBeDelivered` and `delivered`, and prints it. An unclaimed request whose lease expired is offered again; the claim still keeps the work at most once.

### Removal, handlers and damaged logs

- `dash remove` refuses while any request is open. `--force` abandons requests that are unclaimed and not `sending`, and still refuses while any request is `sending` or `claimed`.
- `dash action show`, `claim` and `ack` also find requests in removed dashboards. A removed folder is purged only when its log has no open request.
- An archived or deleted handler thread shows "handler unavailable"; `dash update-manifest --handler` reassigns it for later requests.
- At start, and before any append, the hub checks that the log ends with a complete record; an incomplete tail is set aside and truncated. Any other unreadable line marks the dashboard "action log damaged" until `dash action repair` runs.

### Tests

Fake `lastcode-thread` and fake SSH: delivered; failed only after a failed reachability check, with retry timing; ambiguous then retried then the first message arriving gives one claim and one launch; a lost 202 followed by an item change and the same click resubmitted returns the original request; a failure after dispatch is ambiguous and not resent; stall after five; ambiguous on timeout; a paused sender while the handler claims and acks, then a duplicate delivery, gives one launch; crash after claim shows unresolved and is not rerun blindly; a recovered `sending` record becomes ambiguous; double-submitted clicks; stale `itemRev` and `collectionRev`; oversized payloads; `confirm` actions queue only after confirmation in the shell and cannot be confirmed by page script, including from direct mode; pull handlers through claim and ack, with two consumers, an early exit and a wrong name; a handler reassigned between claim and ack; an unconfirmed answer does not mark its question answered and a cancelled one reopens it; hostile strings render as text in the modal; cross-origin and form confirmations refused; confirmation of a peer dashboard through the peer channel; forged keys without the peer credential refused; remote `dash post` records the originating thread; forced removal during a paused send refused; forced removal after delivery makes the claim fail; truncated tails and corrupt middle lines; identical, changed, bad-origin and oversized click retries; queued actions survive a rolled-back deploy.

### Built differently

An earlier dashboard, outside this repository, already delivered button clicks to a thread, and its route worked in daily use. Where it and this plan disagreed, the build follows what worked, except where noted.

- **The receipt.** The plan expected the send to return message and run IDs. The thread CLIs in use differ: `lastcode-thread send` returns `{kind: "accepted", environmentId, threadId, messageId}`, and another thread CLI also returns `runId`. A reply with a `messageId` is the receipt; `runId` is recorded when present.
- **Reaching a thread.** Like the earlier dashboard, the hub runs a configured thread command, over SSH with `BatchMode=yes`, `ConnectTimeout=5` and a 30-second limit when the handler is on another machine. The configuration is `threadEnvironments`, a map from environment ID to `{threadCommand, host?}`; the adapter's own environment needs no entry.
- **Queue order.** As in the earlier dashboard, a failed request keeps its place, and later requests to the same thread wait behind it until it is delivered, stalls or is abandoned.
- **Evidence nothing was sent.** For a handler on this machine, the evidence is that the thread command does not exist; for another machine, the separate SSH check, as planned.
- **Kept from the plan: ambiguous sends are not resent automatically.** The earlier dashboard resends them and relies on its handler to drop duplicates by request ID. Here the hub's claim makes a duplicate harmless too, but a reader who sees "may have been delivered" and chooses Retry knows what they asked for, so the plan's rule stands.
- **Ack.** Only the handler that claimed a request can acknowledge it, so reassigning the dashboard's handler between claim and ack does not let the new handler close the old one's work.
- **Run again** records a new request with the same snapshot and closes the old one as abandoned, pointing to the new one, so handling still never returns to `unclaimed`.
- **Reader choices** (Retry, Abandon, Mark done, Run again) are posted from the dashboard page, to `/api/request`. They need no shell confirmation; a rerun of a `confirm` action waits for confirmation again.
- **Escape** closes the shell's confirmation box and leaves the request waiting, so the page can ask again; only Cancel abandons it.
- **Handler availability.** The thread CLI reports an archived thread as `not-found`, so a click is refused when the handler reads as missing or archived, or cannot be read on this machine. When SSH cannot reach the handler's machine, the click is accepted and delivery's reachability check retries it.
- **"Not polling"** for a pull handler is measured from this hub's memory, so it also shows for 24 hours after the hub restarts.
- **Repair** keeps the records that still apply and marks every open unclaimed request ambiguous, so nothing is resent automatically. It cannot recover a lost claim record.

### Phase 1b is done when

1. A test action from a dashboard on each machine reaches a scratch handler thread, is claimed and acked once, and its result appears on the item.
2. A forced timeout shows ambiguous. If the first delivery already claimed it, Retry is refused; if not, Retry delivers again and only one claim succeeds. Either way the work runs once.
3. A double-submitted click makes one request; a decision on a changed item is refused; beside a thread on each machine, a `confirm` action opens the shell's modal and runs only after Confirm.
4. Killing the handler after its claim shows unresolved; reconciliation finds the launched thread by request ID and acks it.
5. All tests pass.

**Observed so far:** 5 (119 tests, in CI). The rest need a deployed installation and a person at the desktop.

## Phase 2: [+] → Dashboards and reusing an open tab (a LastCode PR, the owner's call)

Made from a thread in the LastCode project and merged only through its own merge command.

- **[+] → Dashboards** reveals the most recently used reader-controlled tab on the viewing origin, without navigating it; otherwise it opens the index. The address is the `previewUrl` of the project's "Dashboards" script, so there is no new setting, and the entry appears only in projects that have the script. Touches `apps/web/src/components/RightPanelTabs.tsx` and `apps/web/src/components/chat/useRightPanelActions.ts`, with the logic in a new fork-owned file.
- **Link clicks reuse the open tab** (`apps/web/src/browser/openFileInPreview.ts`): a tab with the exact address is revealed; for loopback and `*.localhost` addresses, a tab with the same origin and path, ignoring the query. Browser host and profile must match; agent-owned tabs never match; Cmd-click still makes a new tab.
- **Agent opens reuse the open tab.** `preview_open({purpose: "user"})` reveals a matching tab instead of always creating one. "Always a new tab" is enforced in the server browser, the preview MCP handler, the tool description and the contract, so this half may be dropped if the skill's `preview_status` check proves enough.
- Revealing never navigates a tab and never takes automation control of it.
- **Acceptance:** a second click on a hub link reveals the open tab, including with a different query; [+] → Dashboards reveals a tab that moved from the index to a shell; tabs with a different profile or host, and agent-owned tabs, are not reused; Cmd-click makes a new tab.

## Phase 3: a tab that follows the reader (decided after a week of phase 1)

A pinned dashboard tab stays in the panel as the reader switches threads: closed in the thread being left and opened at the same address in the thread being entered, in a fork-owned module calling existing panel-store functions. It starts as a design investigation with its own plan. Decide with a week's evidence: how often the hub is reopened per thread, and what per-thread copies cost in renderer processes.

## Later

- **Promoting an inline page, on request only:** `dash promote <file>` turns a page an agent already rendered inline into a dopamine page. Never automatic.
- **An MCP App face:** an optional dopamine MCP server could offer a dashboard, one question or the Needs you list as an inline app, using `dopamine.js`'s transport and the same action log. That is the viewing route where `*.localhost` cannot reach, such as a phone.
- **A shared kit** of styles, components and layouts collected from pages that worked well.

## Decisions taken

- **The desktop machine's hub is the viewing hub**, on a `.localhost` origin, from every thread; other hubs serve their dashboards to it.
- **TypeScript on Node, no runtime dependencies, no build step.**
- **The hub is the only writer**; `dash` is its client. No dopamine code in LastCode; an MCP server, if wanted, ships with dopamine.
- **A public repository with every installation detail kept private.**
- **Agent-written pages on per-dashboard origins are the main path**; the starter is optional.
- **Generic records plus declared types**, starting with `questions` only.
- **Inline or dopamine is decided by lifetime**; write a page once, then post only data.
- **Dashboards outlive their threads**, shown as "thread archived" and stale until removed.
- **No floating views.**
- **Ambiguous deliveries are never resent automatically**; a claim makes handling at most once. Clicks are never described as running exactly once.

## Risks

- **Trust boundary.** Anything that can run commands as the reader on any of the machines can post an action, or claim and ack one, and so can any agent with desktop browser automation. A claim proves a request was recorded, not that the reader clicked. The write token keeps other local users and web pages out of the write API, not processes running as the same user; the action and confirmation endpoints rely on origin checks, which a local process can forge.
- **`*.localhost` resolution** may not hold in every browser setup; fallbacks A and B cover it.
- **Peer transport down.** The peer shows as unreachable; each hub keeps serving its own machine.
- **Agent pages run the thread's code** on their own origin. Per-dashboard origins limit a page to its own dashboard and the page policy limits its network reach; neither stops it leaking its own data by navigating away. Consequential actions are confirmed in the shell.
- **Writer convention not enforced.** `by` makes overwrites visible.
- **Writes need the hub.** The service manager restarts it; writes fail clearly after 30 seconds.
- **Per-thread copies cost memory**: each thread the hub is opened in keeps a desktop renderer until it sleeps.

## Out of scope

Native Cite on page content, the hub running agent server code (an agent that needs a server registers it as `url`), authentication beyond loopback, and viewing from a device other than the desktop machine.

## Appendix: fallback B, symmetric hubs

Used only if no name reaches the desktop machine from the panel beside a remote thread.

- Each hub names the other as its peer, with transports both ways and the same identity check. Dashboards get their own origin by port.
- Each index shows both machines' dashboards. `url` dashboards are forwarded to the other machine's loopback and mapped in each hub's config.
- Beside a remote thread, LastCode rewrites loopback to the remote environment's address, which a loopback-bound hub refuses, so the project Action does not work there. Agents open the remote machine's hub with `preview_open({browserHost: "environment", profileName: "Default", url: "http://127.0.0.1:<port>/d/<key>"})`, and the phase 2 [+] entry becomes required in phase 1a.
- The saved place is stored by each dashboard's own hub, so it carries across.
