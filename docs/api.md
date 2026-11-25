# Configuration and HTTP API

The hub, CLI and deployer read the same private JSON file. Select it with `DOPAMINE_CONFIG` or `--config`. Do not commit a filled-in configuration, deployment template, secret, dashboard or operational log.

## Configuration

| Field                | Meaning                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `machine`            | Lowercase machine slug, used in dashboard names and keys.                                                                                                                              |
| `hubId`              | Stable random installation identity.                                                                                                                                                   |
| `port`               | Loopback listener port.                                                                                                                                                                |
| `dataRoot`           | Absolute dashboard storage directory.                                                                                                                                                  |
| `tokenFile`          | Absolute path to a token of at least 32 characters, mode 600.                                                                                                                          |
| `viewingOrigin`      | Exact HTTP origin of the control index and shells.                                                                                                                                     |
| `dashboardDomain`    | Domain suffix for per-dashboard origins.                                                                                                                                               |
| `peerCredentialFile` | Optional absolute path to a shared peer secret, mode 600.                                                                                                                              |
| `peer`               | Optional `{machine, hubId, origin, host}`. Its origin must be loopback HTTP; `host` is the owning hub’s literal loopback HTTP authority, which may differ from the transport endpoint. |
| `remotes`            | Optional map from machine to `{host, dash, config?}` for CLI SSH routing.                                                                                                              |
| `adapter`            | Optional `{home, environmentId, threadCommand?, projectIconCommand?}` for harness identity, thread state and project icons.                                                            |
| `threadEnvironments` | Optional map from environment ID to `{threadCommand, host?}`: how this hub reaches that environment's thread CLI to deliver actions, over SSH when `host` is set.                      |
| `serviceHint`        | Optional private diagnostic text for a stopped hub.                                                                                                                                    |
| `sourceCommit`       | Optional source-checkout identity; an installed deployment receipt takes precedence.                                                                                                   |
| `urlOverrides`       | Optional dashboard-key to viewing-side registered-server URL mapping.                                                                                                                  |

Origins are configuration, not a discovery mechanism. Paired hubs use the same `viewingOrigin`, `dashboardDomain`, and `dashboardOrigins` map. The hub checks the peer's machine, hub ID, and a fingerprint of these origin settings before listing or forwarding peer dashboards. The transport to a peer is provisioned outside the hub. The hub never widens its bind address to expose itself to a network.

A dashboard's ID uses lowercase letters, digits and single hyphens. Its key is `<id>--<machine>`. Its shell address is `<viewingOrigin>/d/<key>`; its page origin is derived from that key and `dashboardDomain`. `dash url` computes the address for callers.

The CLI uses `T3CODE_THREAD_ID` only when `T3CODE_HOME` exactly matches `adapter.home`. It records `adapter.environmentId/<threadId>`. `--as <environment>/<thread>` overrides it. This is caller-asserted attribution. Remote commands pass that resolved identity explicitly; their JSON or file archive travels over stdin.

The `threadCommand` is a command and argument array for a LastCode-style thread CLI, such as `lastcode-thread`. The hub appends `read <threadId> --json` to read thread state and `send <threadId> - --json` to deliver an action, with the message on stdin. The adapter's own environment uses `adapter.threadCommand` unless `threadEnvironments` names it. With `host`, the hub runs the command over SSH (`BatchMode=yes`, `ConnectTimeout=5`) on that host, so it needs key-based, non-interactive SSH to it; a leading `~/` in the command is left for the remote shell to expand.

The optional `projectIconCommand` is a command and argument array. The owning hub appends the project ID from its thread adapter and `--json`. The command returns JSON `null` or `{mediaType, base64}` with a browser-compatible image of at most 128 KiB. The index serves the image through the hub and uses initials when it cannot load it.

## Data

A manifest has schema 2, ID, machine, title, kind (`page` or `url`), nullable URL, owner and handler references, `staleAfterMinutes`, `pinned`, collection declarations, action declarations, and a hub-assigned creation time. `dash create` and `dash update-manifest` change it through the write API.

The handler receives the dashboard's actions. It is a thread, `{environmentId, threadId, title?}`, or a pull handler, `{kind: "pull", name}`, for a harness with no inbox. `dash create` uses the owner when no handler is given. On the command line a handler is `<environment>/<thread>` or `pull:<name>`.

An action declaration is `{name, label, collections, scope, confirm, oncePerItem, maxPayloadBytes}`. `scope` is `item` (a button on one item) or `collection`. `confirm` makes the reader confirm in the shell before anything is sent. `oncePerItem` refuses a second request for the same item, unless the click says `confirmDuplicate`, while an earlier one is open or done.

Dashboard data has `{schema: 2, rev, collections}`. Each collection has `{rev, order, items}`. An item has `{rev, by, via: "cli", at, value}`. Values are arbitrary JSON up to 64 KiB. The hub assigns revision, attribution and time. Revisions are never reused after deleting a record, replacing a collection, or removing and recreating a dashboard.

Declare a questions collection with `--collections-json '{"needsYou":{"type":"questions"}}'`. Each value requires a title and a nonempty array of options with unique labels. Optional fields are recommendation, context and status (`open`, `answered`, `withdrawn`). Each option may carry pros and cons as text or an array of text. An omitted status becomes `open`. The control index gathers open declared questions; generic collections have no imposed shape.

## Control routes

| Method and path                | Result                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GET /`                        | Index with dashboards and combined open questions.                                             |
| `GET /d/<key>`                 | Dashboard shell. Query and fragment select its view; `dopamine-path` preserves a nested page.  |
| `GET /healthz`                 | Machine, installation ID, source commit, schema and process identity.                          |
| `GET /api/list`                | This hub's dashboard summaries.                                                                |
| `GET /api/index`               | Combined summaries and explicit peer reachability.                                             |
| `GET /api/project-icon/<key>`  | Project image for a dashboard with a known owner project.                                      |
| `GET /api/dashboard/<id>`      | Local manifest and data.                                                                       |
| `POST /api/remove`             | Owner removal, with JSON `{key}` and the exact control Origin. Refused while actions are open. |
| `GET /api/confirm/<key>/<id>`  | The stored request the shell's confirmation box shows.                                         |
| `POST /api/confirm/<key>/<id>` | `{decision: "confirm" \| "cancel"}`, with the exact control Origin and a JSON content type.    |

The shell refuses framing. Its sandboxed iframe retains a separate dashboard origin and cannot navigate the shell. The shell accepts location and link messages only from its own iframe window and exact origin. External HTTP/HTTPS links open a tab; thread links are relayed at top level with an Open thread fallback button. Intra-dashboard links stay in the frame.

An existing server that was stopped when its frame first opened may need a browser reload after it starts. Reachability probes update its status; they do not automatically reload an unchanged frame.

The shell shows **Open directly** for framing restrictions the hub can determine from the response. The browser enforces broader framing policies and may refuse the frame. **Open directly** remains available in the shell bar.

## Dashboard routes

The validated Host chooses the dashboard. No query parameter selects another dashboard and no dashboard route serves the control API. Read routes set no CORS permissions.

| Method and path           | Result                                                                         |
| ------------------------- | ------------------------------------------------------------------------------ |
| `GET /` and page paths    | Published page files, without symlinks or traversal.                           |
| `GET /dopamine.js`        | Optional browser client.                                                       |
| `GET /dopamine-meta.json` | Manifest, status and shell address.                                            |
| `GET /data.json`          | Current data with revision ETag; matching requests return 304.                 |
| `GET /files/<name>`       | Attachment as sandboxed plain text.                                            |
| `GET /api/view`           | Reader state retained by the owning hub.                                       |
| `PUT /api/view`           | Save a JSON object; requires the exact dashboard Origin and JSON content type. |
| `POST /api/act`           | Record a click (below). 202 with the new request, 200 with an existing one.    |
| `GET /api/actions`        | This dashboard's requests; `?collection=` and `?key=` select one item's.       |
| `POST /api/request`       | The reader's choice on a request: `{requestId, choice}` (below).               |

A document navigation to a page origin redirects into its shell. Iframe loads and requests without navigation metadata are served directly. `?dopamine-direct=1` suppresses that presentation redirect; all origin and page policies still apply. Data, API, files and peer-forwarded requests are never redirected.

## CLI write routes

Only direct literal loopback requests reach these routes. Each requires `Authorization: Bearer <token>`, `Content-Type: application/json`, and `X-Dopamine-Writer`. Browser requests with an Origin, viewing-host requests, dashboard-host requests and forwarded requests are refused. Tokens are never returned to a page.

| POST route                       | Body                                                      |
| -------------------------------- | --------------------------------------------------------- |
| `/api/write/create`              | Manifest creation fields.                                 |
| `/api/write/<id>/manifest`       | Manifest patch.                                           |
| `/api/write/<id>/post`           | `{collection, key, value?, delete?, before?, atEnd?}`.    |
| `/api/write/<id>/set-collection` | `{collection, order, items}`.                             |
| `/api/write/<id>/publish`        | `{files: {relativePath: base64}}`; requires `index.html`. |
| `/api/write/<id>/attach`         | `{name, body: base64}`.                                   |
| `/api/write/<id>/remove`         | `{force?}`.                                               |
| `/api/write/<id>/restore`        | `{}`.                                                     |
| `/api/write/<id>/action/claim`   | `{requestId, handler?}`.                                  |
| `/api/write/<id>/action/ack`     | `{requestId, handler?, status, result?}`.                 |
| `/api/write/<id>/action/next`    | `{handler}`: a pull handler's next request, or null.      |
| `/api/write/<id>/action/show`    | `{requestId?}`.                                           |
| `/api/write/<id>/action/repair`  | `{}`.                                                     |

The hub serializes changes per dashboard, fsyncs temporary files and renames them atomically. Publishing changes a complete page generation with one pointer swap. Retained dashboard data is separate from deployed code. A connection refused before dispatch may be retried for up to 30 seconds; an ambiguous mutation is not resent automatically.

## Deployment configuration

The private `deploy` section supplies absolute `root`, `node`, `dashLink`, `healthUrl`, and service `{template, destination}` entries, plus `stop` and `start` lists of argv arrays. Templates and argv may use `{{node}}`, `{{app}}`, `{{config}}` and `{{root}}`. Service definitions and concrete arguments stay private. Data, secrets, configuration and templates must be outside the managed deployment root.

The deployer snapshots a clean Git commit, records file hashes, generates a pinned CLI launcher and activates the configured services. A health check must report the new source commit within 20 seconds. Failure restores the previous application and service files; retained dashboard data is untouched. Deployment and rollback need no package install or build.

## Actions

A dashboard's own hub keeps its action requests in `actions.jsonl` beside its data, as append-only, fsynced records. Each change is a locked append that checks the request's current state first.

### Clicks

`POST /api/act` takes `{clickId, action, target, payload, confirmDuplicate?}` in at most 32 KiB, from the exact dashboard Origin. The page makes `clickId` (8 to 128 letters, digits, `-` or `_`) once per click and resends the same click after a network failure. `target` is `{collection, key, itemRev}` for an item action or `{collection, collectionRev}` for a collection action. The hub, under the dashboard's lock:

1. Returns the existing request for a known `clickId` whose click is identical, field for field; the same ID with a different click is refused (409).
2. Checks that the action is declared for that collection and scope, and that the target still has the given revision (409 "This changed; look again").
3. Checks the payload against `maxPayloadBytes` (413). On a `questions` collection, a payload `answer` must be one of the item's option labels.
4. Checks that the handler can take work: a thread handler's environment must be configured and the thread must not be archived. A pull handler always can.
5. Applies `oncePerItem` (409 with `duplicateOf`).
6. Records the request with a snapshot of the item (`{rev, value}`) or collection (`{rev, order}`), and the dashboard's handler at that moment.

The handler acts on the snapshot and payload in the log, never on text a page sent elsewhere.

### Request state

A request has independent fields. `transport` is `awaiting-confirmation`, `queued`, `sending`, `delivered`, `failed`, `stalled`, `ambiguous` or `abandoned`. `handling` is `unclaimed`, `claimed`, `done`, `unknown` or `abandoned`. `mayBeDelivered` is set when a send starts or a pull handler takes a lease, and never cleared. Pages read a single `state`: the handling once claimed (`claimed`, `unresolved` after 30 minutes with no ack, `done`, `unknown`, `abandoned`), otherwise the transport.

### Confirmation

A `confirm` action is recorded as `awaiting-confirmation`. `dopamine.act()` asks the shell, and the shell reads `GET /api/confirm/<key>/<requestId>` (through the peer channel for a peer dashboard) and draws a modal from the stored request, every field as text. Confirm stays disabled for half a second. Confirm and Cancel post with the exact control Origin and a JSON content type; forms, a missing, `null` or dashboard Origin, and the dashboard's own host are refused. Confirm moves the request to `queued`; Cancel abandons it. Escape closes the box and leaves the request waiting. Opened directly, without a shell, `act()` navigates to `<shell>?dopamine-confirm=<requestId>`, and the shell draws the box if that request belongs to its dashboard and still awaits confirmation.

A question with a confirmed answer on its way leaves the index's **Needs you**; a cancelled or abandoned one returns.

### Delivery

The hub delivers to thread handlers with `<threadCommand> send <threadId> - --json`, one queue per handler thread, oldest first. The message is one line, `[dashboard action] {dashboard, requestId, target, action, payload}`, followed by how to claim it. A reply with a `messageId` is a receipt (`runId` is recorded when present) and marks the request `delivered`.

A failure is retried automatically only with affirmative evidence that nothing was sent: before each send, a remote handler's host must answer a separate SSH check, and a local command must exist. Such a failure is `failed`, retried after 1, 5 and 15 minutes, then hourly, and `stalled` after five tries. A failed request keeps its place: later requests to the same thread wait behind it. Anything else, such as a non-zero exit, a reply without a receipt, a 30-second timeout, or a `sending` record found at start-up, is `ambiguous` and is never resent automatically.

### Reader choices

`POST /api/request` takes `{requestId, choice}` from the exact dashboard Origin:

| Choice      | Allowed when                                                    | Effect                                                    |
| ----------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| `retry`     | unclaimed and `failed`, `stalled` or `ambiguous`                | Queued again with a fresh budget and the same request ID. |
| `abandon`   | unclaimed and not `sending` or abandoned; or handling `unknown` | Abandoned; a later claim fails.                           |
| `mark-done` | handling `unknown`                                              | Done.                                                     |
| `run-again` | handling `unknown`                                              | A new request with the same snapshot; the old one closes. |

### Claim and ack

`dash action claim <name> <requestId>` succeeds once: when the caller is the handler recorded with the request (the writer identity, or `--handler <name>` for a pull handler), handling is `unclaimed`, transport is not `abandoned`, and `mayBeDelivered` is set. It prints the request with its snapshot and payload. A late delivery of an ambiguous request can still claim; the first claim wins, and Retry is refused once claimed. A message whose request the log does not show, or whose claim is refused, is not an action.

`dash action ack <name> <requestId> --result-json '{"status": "done", "result": {"label": "...", "href": "..."}}'` closes a claimed request, once, from the handler that claimed it. `href` may use `http`, `https` or `t3-thread`. `status: "unknown"` says the handler could not tell whether the work ran; the page then offers Mark done, Run again and Abandon.

Claim, ack and show also find requests in removed dashboards.

### Pull handlers

`dash action next <name> --handler <pull-name> [--wait]` takes the oldest queued request for that pull handler and leases it for five minutes: it is marked `delivered` and offered to no one else until the lease ends unclaimed. `--wait` asks every two seconds until a request arrives. The dashboard's status shows "not polling" when the handler has not asked for 24 hours, by this hub's memory since it started.

### Removal and damaged logs

`dash remove` and the index's Remove refuse while any request is open. `--force` abandons open requests, but still refuses while any request is `sending` or `claimed`. A removed copy is purged after seven days only when its log has no open request.

Before an append, the hub sets aside an incomplete final record as `actions.tail-*` and truncates it. Any other unreadable record marks the log damaged: requests are refused until `dash action repair`, which keeps the records that still apply, sets the rest aside as `actions.damaged-*.jsonl`, and marks every open unclaimed request `ambiguous`, so nothing is resent automatically. Repair cannot recover a lost claim record.
