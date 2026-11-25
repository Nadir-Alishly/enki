# Dev servers and browser testing

How enki runs your servers, and how QA uses what they serve.

## Dev servers

The orchestrator learns how the system starts and is tested: the scout reports the commands, and the orchestrator keeps them in the repo's `repo.json` and its map (see [Memory](memory.md)). Enki then runs the server in its own herdr tab:

- QA runs `enki server start` when it needs the server, and `enki server restart` to pick up a change.
- `enki team start` refuses if no start command is recorded yet.
- `enki phase done` stops whatever enki started.

`devServer.start` can be any shell command, in any language, such as `python manage.py runserver 8000` or `cargo run`. Enki stops a server by closing its tab, so if the command runs in the background or starts containers, also set `devServer.stop`:

```json
"devServer": { "start": "docker compose up -d", "stop": "docker compose down" }
```

A server needs a `url` for enki to manage it, because that's how enki knows it's up.

Nothing else can start or stop servers: each project's own commands are blocked automatically, along with the common ones for most stacks. If something is already running at the URL, enki uses it and leaves it alone. Set `devServer.managedBy` to `"user"` to run the server yourself.

## Browser testing

QA tests in its own headless browser through the [Playwright MCP server](https://github.com/microsoft/playwright-mcp). Each QA run gets a fresh, isolated, logged-out browser, so several tasks can test at once. Screenshots go to `qa-evidence/` in the task folder.

Set it up once per machine, from the Claude Code prompt (the `enki` command [isn't in your own terminal](configuration.md#the-enki-cli)):

```
! enki playwright status
! enki playwright install            # @playwright/mcp, pinned, about 20 MB
! enki playwright install --browser  # only if you have no Chrome or Chromium, about 150 MB
```

Everything goes into `~/.enki/playwright`, never into your projects. Enki uses an installed Chrome or Chromium if it finds one, and downloads only when you run the command. `enki team start` stops with these instructions if something is missing.

| Setting | Default | Meaning |
|---|---|---|
| `browser.driver` | `playwright` | `playwright`, `chrome` (Claude in Chrome, one task at a time) or `none` |
| `browser.headless` | `true` | `false` opens a visible window |
| `browser.executable` | | Absolute path to a Chrome or Chromium to use |

QA's browser is limited to the project's own local URLs with Playwright's `--allowed-origins`. That keeps it on the project's pages, but Playwright notes it isn't a security boundary. QA also gets only the Playwright MCP server, none of your others.
