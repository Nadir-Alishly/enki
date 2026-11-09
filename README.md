# Enki

Enki turns a Claude Code session into a software development orchestrator. The session stops writing code itself. It scopes the work, gets your approval on a plan, and runs a team of five Claude agents in visible [herdr](https://herdr.dev) panes: a scout, a coder, a tester, QA and a reviewer.

The process is enforced by a CLI and hooks, not left to the model's memory. The coder can't start until you approve the plan, each agent can only write what its role allows, and fix rounds stop at a limit.

```
┌──────────┬──────────┬──────────┐
│  scout   │  tester  │          │
├──────────┼──────────┤ reviewer │
│  coder   │    qa    │          │
└──────────┴──────────┴──────────┘
```

## What happens on a task

1. **Intake.** You describe the change. The scout explores the code, and the orchestrator asks you clarifying questions.
2. **Plan.** You approve the goal, sub-goals and acceptance criteria through plan mode. Nothing changes before this.
3. **Baseline.** `enki verify` records the current test results, so existing failures aren't blamed on the change.
4. **Tests and code, in parallel.** The tester writes tests from the requirements while the coder implements.
5. **Verify and manual checks, in parallel.** Enki runs the tests itself, with no agent and no tokens, while QA starts the server and uses the software in a browser.
6. **Review.** The reviewer reads the diff as soon as tests pass. It always runs.
7. **Fix loop.** Problems go back to the coder, up to 3 rounds. After that, enki stops and reports.
8. **Report.** Repo notes are updated, and you get a report with a scored retrospective on how the task was run.

Agents never commit. Each task works in its own git worktree, and when it finishes, enki commits the work to a branch named after the task. You review the branch and merge it yourself.

## Parallel tasks

Every task gets its own git worktree, branch, port and, if the plan says so, database, so several tasks can run in the same repo at once.

- **Starting:** `enki task new dark-mode` creates the branch `dark-mode` from the branch you're on, and a worktree under `.enki/worktrees/`. The main tree must have no uncommitted changes, because the task starts from the last commit.
- **What git doesn't carry:** enki copies the gitignored files in `worktree.copy`, such as `.env*`, and links the folders in `worktree.link`, such as `node_modules`. If the approved plan has `Scope: deps`, the task gets its own install with `worktree.install`.
- **Ports:** each task's server gets a free port from `ports`, through `{port}` in `devServer.start` and the `PORT` variable. A machine-wide registry stops two tasks picking the same one.
- **Per-task settings:** `worktree.env` sets values in the copied env files and the task's processes. It can use `{port}`, `{port:<repo>}` and `{task}`.
- **Databases:** with a `database` section, each plan says `Database: copy`, `shared` or `none`. `copy` runs your `copy` command at team start and `drop` at the end. `none` blanks the database env values, so nothing reaches the real database by accident.
- **Finishing:** enki removes its copies and links, commits everything else to the task's branch under your git identity, with your git hooks, and removes the worktree. The output gives the branch and `git diff <base>...<slug>` to review it. If a hook refuses the commit, the task stays open. An empty task's branch is deleted, and `--abandon` commits the work as WIP.

```json
{
  "repos": [{ "path": "web", "url": "http://localhost:5173", "devServer": { "start": "npm run dev -- --port {port} --strictPort" } }],
  "worktree": { "copy": [".env", ".env.*"], "link": ["node_modules"], "install": "npm ci", "env": {} },
  "ports": { "from": 4400, "to": 4999 },
  "database": { "copy": "createdb -T app app_{task}", "drop": "dropdb --if-exists app_{task}", "env": { "DATABASE_URL": "postgres://localhost/app_{task}" } }
}
```

Set `"worktrees": false` for a project that isn't in git. Tasks then share one tree, and enki allows one open task per repo.

## Browser testing

QA tests in its own headless browser through the [Playwright MCP server](https://github.com/microsoft/playwright-mcp). Each QA run gets a fresh, isolated, logged-out browser, so several tasks can test at once. Screenshots go to `qa-evidence/` in the task folder.

Set it up once per machine:

```
enki playwright status
enki playwright install            # @playwright/mcp, pinned, about 20 MB
enki playwright install --browser  # only if you have no Chrome or Chromium, about 150 MB
```

Everything goes into `~/.enki/playwright`, never into your projects. Enki uses an installed Chrome or Chromium if it finds one, and downloads only when you run the command. `enki team start` stops with these instructions if something is missing.

| Setting | Default | Meaning |
|---|---|---|
| `memory` | `repo` | `repo` or `private`: see Memory |
| `browser.driver` | `playwright` | `playwright`, `chrome` (Claude in Chrome, one task at a time) or `none` |
| `browser.headless` | `true` | `false` opens a visible window |
| `browser.executable` | | Absolute path to a Chrome or Chromium to use |

QA's browser is limited to the project's own local URLs with Playwright's `--allowed-origins`. That keeps it on the project's pages, but Playwright notes it isn't a security boundary. QA also gets only the Playwright MCP server, none of your others.

## Dev servers

The orchestrator learns how the system starts and is tested: the scout reports the commands, and the orchestrator keeps them in `.enki/config.json` and the repo notes. Enki then runs the server in its own herdr tab:

- QA runs `enki server start` when it needs the server, and `enki server restart` to pick up a change.
- `enki team start` refuses if no start command is recorded yet.
- `enki phase done` stops whatever enki started.

`devServer.start` can be any shell command, in any language, such as `python manage.py runserver 8000` or `cargo run`. Enki stops a server by closing its tab, so if the command runs in the background or starts containers, also set `devServer.stop`:

```json
"devServer": { "start": "docker compose up -d", "stop": "docker compose down" }
```

A server needs a `url` for enki to manage it, because that's how enki knows it's up.

Nothing else can start or stop servers: each project's own commands are blocked automatically, along with the common ones for most stacks. If something is already running at the URL, enki uses it and leaves it alone. Set `devServer.managedBy` to `"user"` to run the server yourself.

## Dashboard

Enki has a local, read-only web dashboard covering every enki project on this computer. Open it with:

```
enki dashboard --open
```

It works from any folder. Any enki session or new task also starts it in the background, so it's usually already running at `http://localhost:4747/`.

- **Project view:** a year of finished tasks as a heatmap, tokens spent by agent role over 7, 30 or 90 days, every task with its status, duration and tokens, and the project's settings and models.
- **Task view:** the agent team with each agent's live state, current plan step, tool call count and context in use against its model's window, then context by agent, the plan with each step's status, any alert that needs you, and the activity feed. Hover or click an agent's card or context total to pick it out everywhere on the page; Escape clears it.

Agent states are herdr's own (Running, Idle, Done, Needs you), plus Stopped, and Error for an agent that vanished from an open task. They follow herdr within about 2 seconds. Plan steps come from the approved plan's **Steps** list: each `enki ask --step N` marks a step active, and the agent's report marks it done.

How it works:

- One server per computer, owned by no session. It listens only on `127.0.0.1`, refuses requests for any other host name, sends no CORS headers and accepts no changes. It exits after 30 minutes with no open task and no open page.
- It reads what enki already writes: the project registry in `~/.enki/projects.json`, each task's state, event log and activity log, and herdr's agent list. Tokens come from Claude Code's own session transcripts. A cache in `~/.enki/dashboard.db` saves rereading them, and can be deleted at any time.
- `enki dashboard status` and `enki dashboard stop` check or stop it. After a plugin update, the next start replaces an older server.
- `ENKI_DASHBOARD_PORT` picks another port. `ENKI_DASHBOARD=off` stops enki from starting it.

Tasks started before the dashboard existed show their history, but not their tokens, steps or tool calls.

## Requirements

- Claude Code 2.1.318 or newer
- [herdr](https://herdr.dev), with Claude running inside a herdr pane
- Node 22 or newer
- For browser testing, an installed Chrome or Chromium, or let enki download one (see below)

## Install

Install at user scope, so workers started in repo subfolders load the plugin too. Enki does nothing in projects without `.enki/config.json`.

```
/plugin marketplace add Nadir-Alishly/enki
/plugin install enki@enki-plugins
```

Then, in your project, inside a herdr pane:

```
/enki:init
```

Start a new session afterwards. It runs as the orchestrator: describe a change and the task begins.

## Memory

Enki keeps what it learns about each repo in three files: `notes.md` (architecture, conventions, how to test, gotchas), `repo.json` (its test, lint and dev-server commands) and `playbook.md` (team rules). They change on a task's branch, so they reach your base branch only when you merge the code. A task you never merge never leaves wrong notes behind.

Pick one mode per project. `/enki:init` asks, or run `enki migrate`:

| | `repo` (default) | `private` |
|---|---|---|
| Where | `<repo>/.enki/`, committed with the code | `.enki/memory/<repo>/`, a local git repo, never pushed |
| For | Your own repos, or teams that all use enki | Team repos where others don't use enki |
| Follows merges | Exactly: git does it, including squashes, cherry-picks and reverts | By detection at each `enki task new` or `enki memory sync`: merges, fast-forwards, rebases, and squashes of enki's single commit |
| Misses | Nothing | A squash mixed with other commits, and cherry-picks: run `enki memory merge <slug>`. Reverting code doesn't revert memory |
| Backup | Pushed with the code | Only on this clone, unless you push the memory repo somewhere private |

In private mode, `.enki/` is hidden from the team through your clone's `.git/info/exclude`, never a committed `.gitignore`. Memory branches mirror your code branches, and a memory conflict stops `enki memory sync` with a path to resolve it in.

With several repos, each has its own memory, and each follows its own merges. Knowledge about a contract between repos, such as an API, goes on both sides: the backend's notes say what it provides, and the frontend's notes say how it uses it.

During a task, only the orchestrator writes memory, and only its own task's copy. Workers can't write memory at all. `enki migrate` warns if your old shared notes may contain knowledge from task branches you haven't merged.

## Worker skills

Workers start with no skills, so they aren't distracted by, or paying context for, ones they don't need. Each role gets only what's listed in `.enki/config.json`:

```json
"team": {
  "coder": { "skills": ["frontend-design", "design:ux-copy"] },
  "qa": { "skills": ["accessibility-review"] }
}
```

Ask the orchestrator to change this, or edit the file. `enki skills` shows what each role loads, and `enki skills --available` lists what's installed.

- Use the skill's name, with the plugin prefix for plugin skills. Bundled Claude Code skills have no file to load, so they can't be listed.
- A name enki can't find stops `enki task new`, before any tab opens.
- Each listed skill's full text goes into that worker's instructions, so it costs context on every turn. Keep lists short.
- Skills load when a worker starts. A worker that's already running keeps what it had.
- Inline shell commands in a skill (`` !`command` ``) don't run. `enki skills` warns about them.
- The orchestrator keeps its normal skills, because it runs on them.

## Permission modes

You only talk to the orchestrator. Workers run in `auto` mode by default, so they rarely stop. When one does, the orchestrator handles the prompt:

- It approves one-time requests that are clearly needed for the approved plan, such as tests, builds and local requests.
- It asks you in the chat about anything else, and passes on your decision.
- It always asks you before trusting a folder.

`enki answer` is the only route. It accepts only a plain Yes or a No, so wider grants such as "always allow" are refused, and every answer goes in `events.jsonl` and the report. Workers can't open dialogs, so their questions arrive as replies to the orchestrator.

Enki's policy applies in every mode, and a command the hook denies stays denied whatever the orchestrator answers. If your account doesn't have auto mode, set `permissionMode` to `acceptEdits` or `default`. The orchestrator will then get more prompts. Enki refuses `bypassPermissions`.

## Commands

| Skill | Use |
|---|---|
| `/enki:init` | Set up the current project |
| `/enki:task <request>` | Start a task. In `auto` mode any change request does this |
| `/enki:resume <slug>` | Continue a task after `/clear` or in a new session |
| `/enki:status` | Show task state |

The orchestrator drives the `enki` CLI, which is on the Bash `PATH` while the plugin is enabled. Run `enki help` to see it. You can run `enki dashboard` yourself, from any folder.

## Configuration

`.enki/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `auto`: every session here is the orchestrator. `explicit`: only after `/enki:task` |
| `repos[]` | | `path` (required), `name`, `test`, `lint`, `url`, `testGlobs`, `devServer`, `gate` |
| `team` | Haiku for scout, tester and QA, Sonnet for coder and reviewer, no skills | `model`, `effort` and `skills` per role |
| `permissionMode` | `auto` | Permission mode for workers |
| `timeouts` | 15 to 30 minutes, 2 for server start | Milliseconds per step |
| `maxFixRounds` | `3` | Fix rounds before enki stops |
| `policy` | | `secrets` and `protected` globs, and `bash` rules with `pattern` and `reason`. These can only add restrictions |

Also in `.enki/`:

- `playbook.md`: project rules, by role, passed to the workers
- `notes/<repo>.md`: living knowledge about each repo
- `tasks/<date>-<slug>/`: plan, reports, `state.json` and `events.jsonl`. Gitignored by default

A plan sets options with lines you approve: `Tests: none` or `QA: none` to skip those steps, and `Scope: deps`, `Scope: infra` or `Scope: git-init` to unlock extra permissions.

## What is enforced

| Rule | Enforced by |
|---|---|
| The coder, tester and reviewer can't start before approval | `enki` refuses, and approval is only recorded by a hook on the approved `ExitPlanMode` |
| Agents can't claim approval | `enki phase approved` is refused, and task state files can't be edited with file tools |
| The orchestrator can't edit project files | `PreToolUse` hook |
| Write ownership per role | `PreToolUse` hook, on file tools and on visible Bash writes |
| Secrets can't be read or written | `PreToolUse` hook |
| The tester and QA can't see the coder's work | On each tool call, the hook compares the tree with a snapshot taken before coding, and blocks those files, `git diff`, recursive search, and the plan, coder and reviewer reports |
| Review only runs on a working build | `enki ask reviewer` needs a passing `enki verify` for the current round. New coder or tester work clears the result |
| Review can't be skipped | The reviewer always starts, and a task can't reach notes or report without its report for the current round. `enki phase done --abandon` is the only way out, and it's recorded |
| Test results mean something | `enki verify` refuses while the coder or tester is working |
| No commits, pushes, destructive git, kills, `sudo`, publishing, package installs, server control | `PreToolUse` hook, including through `bash -c`, `eval`, `xargs`, `find -exec`, substitutions and env wrappers |
| Fix rounds stop at the limit | `enki round next` refuses |
| Each task stays in its own worktree | The hook lets workers write only their task's worktree. The main tree, other tasks' worktrees and, for the orchestrator, all worktrees are refused |
| Secrets stay out of commits | Enki removes everything it copied or linked before it commits |
| QA only runs on finished code | `enki ask qa` needs the coder's report for the round |
| Blocked workers are handled at once | `enki ask` returns immediately, and `enki answer` allows only one-time options and logs each one |
| Workers really run the hooks | `enki` waits for each worker to report its hooks live, and fails if it doesn't |
| Only one QA agent uses Claude in Chrome | A machine-wide lock, for the `chrome` driver only. Playwright needs none |
| Agents don't run servers | `PreToolUse` hook, with `enki` as the only route |

If the policy check itself fails inside an enki session, the call is refused.

## What is not enforced

Be clear about the limits. Enki is a set of guardrails for a cooperative agent, not a sandbox.

- **Bash inspection is pattern matching.** A script file, `python -c`, a build tool or an unusual shell form can do what the patterns can't see. Claude Code's permission checks still apply. For a hard boundary, use OS-level sandboxing.
- **Rules that are only instructions:** the fix-brief style, browser etiquette such as reusing the empty tab, data handling in tests, and "local network only".
- **Blindness has the same limit.** A script, or a path built from variables, can still read the coder's files, and it needs a git repo to know what changed. Tests also see behaviour by running the code, which is the point.
- **Paths built from variables aren't judged.** A write to `$DIR/file`, or after `cd "$DIR"`, passes the path rules, so agents can use scratch folders freely. Deletes through variables are still refused.
- **`.enki/config.json` is trusted.** Enki runs `devServer.start` and `devServer.stop` outside the hooks, and the orchestrator can edit that file, because it records what it learns there. Review changes to it the way you'd review a script.
- **Workers can't be stopped from reading non-secret files** outside their task. Reading is unrestricted apart from secrets.

Which prompts the orchestrator approves on its own is its judgement, guided by instructions. The limits on that are the one-time rule, the log and the policy hook. Direct `herdr` input commands are denied, so `enki answer` can't be sidestepped through the Bash patterns enki knows about.

## Development

```
npm test
claude plugin validate .
```

To try a working copy, run Claude with `--plugin-dir` and set `ENKI_DEV_PLUGIN_DIR` to the same path, so workers load it too. Tests run against a fake herdr (`tests/helpers/fake-herdr.mjs`) whose responses were captured from real herdr. `docs/spike-results.md` records what was verified against the real tools.

## License

MIT
