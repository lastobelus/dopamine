---
name: dashboard
description: Dopamine dashboards, live pages a thread publishes once and then updates by posting data. Use to make a dashboard, make a visual durable, remove a dashboard, or show dashboards.
---

# Dopamine dashboards

**Write the page once, then post only data.** After publishing, every update is a `dash post` or `dash set-collection`. Republish only when the page's code itself has to change.

## Choose dopamine or inline

- Use a dopamine dashboard when the content will change, or someone will read it after the next few turns.
- A coordinating thread, one that runs child threads or delegates, always uses a dopamine dashboard.
- For a quiet one-off visual, use inline `html_render` instead.

## Commands

Run `dash --help` for exact arguments.

| Command                                              | Use                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `dash create <id> --title '...' [--from-starter]`    | Create a dashboard. `--from-starter` copies the starter page.                   |
| `dash publish`                                       | Publish the page and its assets.                                                |
| `dash post <name> <collection> <key> --json <value>` | Post one data value. `--file -` reads the value from stdin instead of `--json`. |
| `dash set-collection`                                | Replace an ordered collection the coordinator owns.                             |
| `dash attach`                                        | Upload a file to the dashboard’s attachments.                                   |
| `dash url`                                           | Print the dashboard's shell URL.                                                |
| `dash list`, `dash show`                             | List dashboards; show one.                                                      |
| `dash remove`, `dash restore`                        | Remove a dashboard; bring a removed one back.                                   |
| `dash update-manifest`                               | Change the dashboard's manifest.                                                |

A `<name>` is either a local `<id>` or `<machine>/<id>`, where `<machine>` is a machine name from config.

The CLI takes the caller's identity from validated harness environment variables. Without them, pass `--as <environment>/<thread>`. That identity is asserted by the caller, not verified.

## Build the page

Write ordinary HTML, JavaScript and assets yourself, or start from the starter page. The page must follow these rules:

- **Refresh on data only.** Update the view when the data revision changes. Keep the page itself in place: no reload or full redraw for new data.
- Keep disclosure keys (what is expanded or collapsed) stable across updates, and preserve scroll position.
- On a fetch or render error, keep showing the last good state.
- Save the reader's place through the hub's `/api/view`, not browser storage.
- Vendor any library into the dashboard's assets. The page's CSP blocks runtime CDN loads.
- Render contributed fields as text (`textContent`), never as HTML (`innerHTML`). Other threads write those values.

## Share a dashboard between threads

- Each child thread posts only under its own keys in a shared collection.
- The coordinator owns ordered collections, such as questions and decisions, and writes them with `dash set-collection`.
- Declare a collection holding questions for the reader with the `questions` type, so the hub gathers them into its combined **Needs you** view.

## Post as you work

Run `dash post` after every report or decision, and before every wait, so the dashboard is current whenever the reader looks.

## Check and share it

1. After every publish, load the live shell URL in a background browser tab and confirm the page renders with its data. `html_preview` of the source alone does not prove the published dashboard works.
2. Get the exact shell URL from `dash url`, including `http://`. Use it unchanged.
3. Call `preview_status` first to find a tab already showing the dashboard, so you do not open a duplicate.
4. Then either open the dashboard for the reader or give them the link, not both. When opening, take `browserHost` from the configured viewing mode, normally `desktop`. In symmetric remote mode, fall back to the environment's Default browser, as private config specifies. Read the host and port from `dash url`, not from memory.

## Not available yet

Dashboard actions (phase 1b) are not implemented. Buttons on a dashboard cannot send work to a thread yet, so do not offer that to the reader.
