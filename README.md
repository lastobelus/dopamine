# dopamine

Dopamine lets agent threads publish small dashboards and keep them current with JSON updates. The pages remain available after the conversation ends, in a browser or beside another thread.

Write an ordinary HTML page, publish it once, then post JSON as work changes. Each dashboard has its own origin. A small hub serves its files, keeps ordered collections and reader state, and puts a common status strip above the page. Several threads can contribute to the same dashboard. A second hub can contribute to the same index through an authenticated loopback connection.

This is an experiment for the author's own workflow. There is no support promise.

## Development

Use Node **26.12.1** and **pnpm 12.15.0**. There are no runtime dependencies and no build step: Node runs the TypeScript directly.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm test
pnpm knip:check
# Or run all checks, sequentially:
pnpm run ci
```

Vite+ supplies linting, formatting and tests; `@effect/tsgo` checks strict TypeScript. Tests run one file and one worker at a time. See [AGENTS.md](AGENTS.md) for the PR gates and merge workflow.

## Run it

Supply a private configuration file through `DOPAMINE_CONFIG` or `--config`. It supplies the machine identity, listening port, origins, storage and secret paths, and any peer or harness adapter. Concrete deployment configuration and service files belong outside this public repository. [Configuration and API](docs/api.md) describes the fields and boundaries.

```sh
node server.ts --config "$DOPAMINE_CONFIG"
node bin/dash.ts --help
```

The hub binds only loopback. It is the only writer of dashboard files. CLI writes require a private token; browser pages never receive it. Browser state changes require their exact dashboard origin. Pages cannot read another dashboard or reach the control API through their own origin. This is an origin boundary, not a sandbox against a page leaking its own data by navigating away.

## Make a dashboard

The following commands assume `dash` is installed and private configuration is selected. Supply an explicit writer identity, or use the validated harness identity from configuration.

```sh
dash --as environment/thread create example --title 'Example' --from-starter
dash --as environment/thread post example streams worker --json '{"title":"Checking the change","status":"Running"}'
dash url example
```

For a custom page, put `index.html` and its assets in a folder, then run `dash publish example ./page`. Vendor libraries with the page; the page policy blocks runtime CDN requests. The supplied client, `/dopamine.js`, exposes `dopamine.data()`, `dopamine.subscribe(callback, onError)`, `dopamine.view.get()` / `dopamine.view.set(value)`, and for actions `dopamine.act()`, `dopamine.watchRequests()` and `dopamine.choose()`. A page may also use plain HTTP.

Pages that subscribe to data or request status get a **Refresh** button from the client. Subscriptions read on load and on Refresh, and request status also updates after a reader action. Pages may call `dopamine.refresh()` from their own Refresh control.

The optional [starter](starter/) shows questions, lists, work streams, metrics and citations. It preserves disclosures and scroll across data changes and saves the reader's place on the hub. Follow the same rules in custom pages. The [dashboard skill](skills/dashboard/SKILL.md) describes when and how agents should use the tool.

Use `dash attach example ./note.txt` for supporting files. Attachments are served as sandboxed text. `dash remove example` retains a recoverable copy for seven days; `dash restore example` restores the newest copy if its ID has not been reused. Dashboards may outlive their owner threads.

Always share the shell address from `dash url`, including its `http://` scheme. **Open directly** temporarily leaves the shell for the element picker or a page that cannot be framed. Pages can register an existing local web server with `dash create ... --url ...`; that server retains its own data and behavior.

## Deploy

`node bin/deploy.ts --config "$DOPAMINE_CONFIG"` installs a clean committed snapshot using private templates and service commands. It records hashes, pins Node, keeps a previous version, and restores that version if the new worker fails its health check. Application versions and dashboard data are stored separately. `--rollback` restores the retained version; `bin/uninstall.ts` keeps data unless `--purge` is given.

Deployment is local to the machine running the command. Multi-machine deployment and tunnel wiring belong in a private driver and configuration. No deployed data or credentials belong in Git.

## Actions

A dashboard can declare buttons that send work to a thread. A click is recorded on the dashboard's hub, delivered to the handler thread with its thread CLI (locally or over SSH), and handled at most once: the handler claims the request before acting and acknowledges it after. Consequential actions wait for the reader to confirm in a box the shell draws, which the page can't reach. Harnesses with no inbox ask for work with `dash action next`. [Configuration and API](docs/api.md#actions) describes the rules.

LastCode's panel conveniences are a later phase.
