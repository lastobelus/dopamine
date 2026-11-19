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
| `adapter`            | Optional `{home, environmentId, threadCommand?}` for harness identity and thread-state reads.                                                                                          |
| `serviceHint`        | Optional private diagnostic text for a stopped hub.                                                                                                                                    |
| `sourceCommit`       | Optional source-checkout identity; an installed deployment receipt takes precedence.                                                                                                   |
| `urlOverrides`       | Optional dashboard-key to viewing-side registered-server URL mapping.                                                                                                                  |

Origins are configuration, not a discovery mechanism. Paired hubs use the same `viewingOrigin`, `dashboardDomain`, and `dashboardOrigins` map. The hub checks the peer's machine, hub ID, and a fingerprint of these origin settings before listing or forwarding peer dashboards. The transport to a peer is provisioned outside the hub. The hub never widens its bind address to expose itself to a network.

A dashboard's ID uses lowercase letters, digits and single hyphens. Its key is `<id>--<machine>`. Its shell address is `<viewingOrigin>/d/<key>`; its page origin is derived from that key and `dashboardDomain`. `dash url` computes the address for callers.

The CLI uses `T3CODE_THREAD_ID` only when `T3CODE_HOME` exactly matches `adapter.home`. It records `adapter.environmentId/<threadId>`. `--as <environment>/<thread>` overrides it. This is caller-asserted attribution. Remote commands pass that resolved identity explicitly; their JSON or file archive travels over stdin.

## Data

A manifest has schema 2, ID, machine, title, kind (`page` or `url`), nullable URL, owner and handler references, `staleAfterMinutes`, `pinned`, collection declarations, action declarations, and a hub-assigned creation time. `dash create` and `dash update-manifest` change it through the write API.

Dashboard data has `{schema: 2, rev, collections}`. Each collection has `{rev, order, items}`. An item has `{rev, by, via: "cli", at, value}`. Values are arbitrary JSON up to 64 KiB. The hub assigns revision, attribution and time. Revisions are never reused after deleting a record, replacing a collection, or removing and recreating a dashboard.

Declare a questions collection with `--collections-json '{"needsYou":{"type":"questions"}}'`. Each value requires a title and a nonempty array of options with unique labels. Optional fields are recommendation, context and status (`open`, `answered`, `withdrawn`). Each option may carry pros and cons as text or an array of text. An omitted status becomes `open`. The control index gathers open declared questions; generic collections have no imposed shape.

## Control routes

| Method and path           | Result                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /`                   | Index with dashboards and combined open questions.                                            |
| `GET /d/<key>`            | Dashboard shell. Query and fragment select its view; `dopamine-path` preserves a nested page. |
| `GET /healthz`            | Machine, installation ID, source commit, schema and process identity.                         |
| `GET /api/list`           | This hub's dashboard summaries.                                                               |
| `GET /api/index`          | Combined summaries and explicit peer reachability.                                            |
| `GET /api/dashboard/<id>` | Local manifest and data.                                                                      |
| `POST /api/remove`        | Owner removal, with JSON `{key}` and the exact control Origin.                                |

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

The hub serializes changes per dashboard, fsyncs temporary files and renames them atomically. Publishing changes a complete page generation with one pointer swap. Retained dashboard data is separate from deployed code. A connection refused before dispatch may be retried for up to 30 seconds; an ambiguous mutation is not resent automatically.

## Deployment configuration

The private `deploy` section supplies absolute `root`, `node`, `dashLink`, `healthUrl`, and service `{template, destination}` entries, plus `stop` and `start` lists of argv arrays. Templates and argv may use `{{node}}`, `{{app}}`, `{{config}}` and `{{root}}`. Service definitions and concrete arguments stay private. Data, secrets, configuration and templates must be outside the managed deployment root.

The deployer snapshots a clean Git commit, records file hashes, generates a pinned CLI launcher and activates the configured services. A health check must report the new source commit within 20 seconds. Failure restores the previous application and service files; retained dashboard data is untouched. Deployment and rollback need no package install or build.

Actions, confirmations and delivery endpoints are unavailable in phase 1a.
