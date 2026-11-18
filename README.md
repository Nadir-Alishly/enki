# Enki

Enki turns a Claude Code session into a software development orchestrator. The session stops writing code itself. It passes your request to a planner, gets your approval on the plan, and runs a team of Claude agents in visible [herdr](https://herdr.dev) panes. Enki's own team is a scout, a planner, a coder, a tester, QA and a reviewer, and you can build your own: [agents and workflows](#agents-and-workflows) are yours to define, share and edit in the dashboard.

The process is enforced by a CLI and hooks, not left to the model's memory. Nothing that writes starts until you approve the plan, each agent can only write what it is allowed to, every step runs only when its workflow says so, and every loop has a limit.

```
┌──────────┬──────────┬──────────┐
│  scout   │  coder   │    qa    │
├──────────┼──────────┼──────────┤
│ planner  │  tester  │ reviewer │
└──────────┴──────────┴──────────┘
```

## What happens on a task

With enki's **Full** workflow, the default:

1. **Request.** You describe the change. The orchestrator writes down your words and passes them on: it carries messages between you and the team, and never plans or designs itself.
2. **Scout and planner.** The scout explores the code. The planner writes the plan from your request and the scout's findings. Questions only you can answer come to you through the orchestrator, and your answers go back to the planner.
3. **Approval.** The orchestrator shows you the planner's plan, word for word, in plan mode: the goal, sub-goals, acceptance criteria and steps. Approve it, or ask for changes, which go back to the planner. Nothing changes before you approve.
4. **Baseline.** `enki verify` records the current test results, so existing failures aren't blamed on the change.
5. **Tests and code, in parallel.** The tester writes tests from the requirements while the coder implements.
6. **Verify and manual checks, in parallel.** Enki runs the tests itself, with no agent and no tokens, while QA starts the server and uses the software in a browser.
7. **Review.** The reviewer reads the diff once tests pass.
8. **Loops.** Failing tests, QA's bugs and the reviewer's changes go back to the coder, each at most 3 times. Past that, only you decide how to go on.
9. **Report.** Repo notes are updated, and you get a report with a scored retrospective on how the task was run.

A plan can pick another workflow, such as **Quick fix** (no scout: the planner looks at the code itself, then the coder, tests and review) or **Research** (read-only), or one of your own.

Agents never commit. Each task works in its own git worktree, and when it finishes, enki commits the work to a branch named after the task. You review the branch and merge it yourself.

## Parallel tasks

Every task gets its own git worktree, branch, port and, if the plan says so, database, so several tasks can run in the same repo at once.

- **Starting:** `enki task new dark-mode` creates the branch `dark-mode` from the branch you're on, and a worktree under `.enki/worktrees/`. The main tree must have no uncommitted changes, because the task starts from the last commit.
- **What git doesn't carry:** enki copies the gitignored files in `worktree.copy`, such as `.env*`, and links the folders in `worktree.link`, such as `node_modules`. If the approved plan has `Scope: deps`, the task gets its own install with `worktree.install`.
- **Ports:** each task's server gets a free port from `ports`, through `{port}` in `devServer.start` and the `PORT` variable. A machine-wide registry stops two tasks picking the same one.
- **Per-task settings:** `worktree.env` sets values in the copied env files and the task's processes. It can use `{port}`, `{port:<repo>}` and `{task}`.
- **Databases:** with a `database` section, each plan says `Database: copy`, `shared` or `none`. `copy` runs your `copy` command at team start and `drop` at the end. `none` blanks the database env values, so nothing reaches the real database by accident. A plan without the line gets `database.default`, `copy` unless you set it. `"enabled": false` turns copying off but keeps the commands: plans then use the shared database, or none.
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

Enki has a local web dashboard covering every enki project on this computer. Open it with:

```
enki dashboard --open
```

It works from any folder. Any enki session or new task also starts it in the background, so it's usually already running at `http://localhost:4747/`.

While an orchestrator has a task open, a band above its prompt shows the task and its phase, with a **Go to dashboard** button that opens the task's page. Collapse it with its `[-]`. Run from an orchestrator's pane, `enki dashboard --open` also opens that task's page, and `enki dashboard link` prints what the band shows. On KDE Plasma, where Wayland won't let a background process hand the browser the focus, enki asks KWin (through a small script over D-Bus) to bring the dashboard's window forward, switching virtual desktops if needed.

- **Project view:** a year of finished tasks as a heatmap, tokens spent by agent over 7, 30 or 90 days, and every task with its status, duration and tokens.
- **Task view:** the task's workflow by name, drawn as in the studio and fitted to the page, from Start through Approval to End. It is the team view too: each agent step shows its state, model, effort and how full its context is, and the orchestrator sits top left with its own. A step that came back to the orchestrator wears an orange "With you" badge, and ↩ marks the outcomes that go back to it. Then context by agent, the plan with each step's status, any alert that needs you, and the activity feed. Tasks from before workflows show their agent cards instead. Hover or click a step, a context total or a plan step's owner to pick that agent out everywhere on the page; Escape clears it.
- **Workflows:** every workflow available to the project, with duplicate, export and import. Importing shows each new agent's permissions before anything is saved.
- **Agents:** every agent, enki's own and your library's, with what each may do, its outcomes, what it runs on and which workflows use it. Make a new one from a template, duplicate one of enki's, export and import them. The editor sets the name and type; what enki enforces (what it may change, blind, browser, dev server, plans), with a warning for risky combinations; the outcomes, refusing a rename or removal a workflow still wires; the default model, effort, timeout and skills; and the instructions, with a preview. Enki's own agents open read-only, with a button to duplicate them.
- **Studio:** each workflow opens on one screen. Drag around the canvas and zoom; drag agents in from the library on the left; drag steps to place them; drag from an outcome's port to a step to wire it, or onto empty canvas to create the step there. Lines run square: drag any segment to move it, double-click a segment to add a bend and a bend's handle to take it out, drag a line's end onto another block to send the outcome there, and remove a line with the × on it. The library has two tabs: agents, and built-in steps like Tests, which run without an agent. The inspector on the right sets each step's agent, its model, effort and extra skills for this workflow, any extra step it waits for and its hand-off limit, and each loop's limit, and offers everything dragging does from the keyboard. Both side panels open and close. A loop without a limit shows red, every change is checked by the same rules the CLI uses, and Save stays off until the workflow can run. Undo and redo with Ctrl+Z and Ctrl+Shift+Z. Enki's own workflows open read-only, with a button to duplicate them. On a phone the studio is for looking only.
- **Project settings:** it edits the project's `.enki/config.json`: the default workflow, activation, worktrees, timeouts, the browser, the port range and database copying. Memory mode, repos and their test and dev server commands are shown but not editable. Changes apply to the next agent started. If the file changes elsewhere while you have unsaved edits, the page asks you to reload instead of overwriting it.

Agent states are herdr's own (Running, Idle, Done, Needs you), plus Stopped, and Error for an agent that vanished from an open task. They follow herdr within about 2 seconds. Plan steps come from the approved plan's **Steps** list: each `enki ask --step N` (or `--step 2,3,4`: one visit does all of them) marks its steps active. When the agent finishes they're done, or failed if its outcome went to the orchestrator instead (blocked, an error).

How it works:

- One server per computer, owned by no session. It listens only on `127.0.0.1`, refuses requests for any other host name and sends no CORS headers. Its only writes are a settings save and the Workflows page's copy, import and save, which it accepts only from its own page: the request must come from the dashboard's own origin, as JSON, with a token only that page can read. The project comes from enki's registry, never from the request, and only the fields on the page can change. It exits after 30 minutes with no open task and no open page.
- It reads what enki already writes: the project registry in `~/.enki/projects.json`, each task's state, event log and activity log, and herdr's agent list. Tokens come from Claude Code's own session transcripts. A cache in `~/.enki/dashboard.db` saves rereading them, and can be deleted at any time.
- `enki dashboard status` and `enki dashboard stop` check or stop it. After a plugin update, the next start replaces an older server.
- `ENKI_DASHBOARD_PORT` picks another port. `ENKI_DASHBOARD=off` stops enki from starting it.

Tasks started before the dashboard existed show their history, but not their tokens, steps or tool calls.

## Agents and workflows

An **agent** is what a workflow step runs. A **workflow** wires agents together into a team: which steps run, and where each step's outcome sends the work. Enki runs the workflow: the orchestrator briefs whatever is ready, and can't start a step out of turn.

**An agent** is a folder with two files, made on the dashboard's Agents page or by hand:

- `AGENT.md`: its instructions, in skill format.
- `agent.json`: what enki enforces for it, and what it runs on unless a workflow says otherwise.

```json
{
  "id": "docs", "name": "Docs reviewer", "type": "reviewer",
  "capabilities": { "write": "none", "blind": false, "browser": false, "server": false },
  "outcomes": [
    { "id": "clear", "description": "The docs say what the change does" },
    { "id": "unclear", "description": "Something needs explaining: listed in the report" }
  ],
  "model": "claude-sonnet-5-5", "effort": "high", "skills": ["design:ux-copy"]
}
```

- **`write`:** `none` (its reports only), `tests` (test files only), `code` (anything but tests) or `all`.
- **`blind`:** it never sees the work: the change, other steps' reports and the plan are hidden from it, as for enki's tester and QA.
- **`browser` and `server`:** a browser, and `enki server`.
- **`plans`:** it writes the plan (enki's planner), and nothing else.
- **`outcomes`:** its own. The agent reports one with `enki report <outcome>` before it replies. Enki adds `error`, for an agent that finished without reporting, and `timeout`.
- **`type`:** `scout`, `planner`, `coder`, `tester`, `qa` or `reviewer`. It sets the agent's colour and pattern, and the project's token chart counts by it. An agent without one gets a type from what it does; an old `color` or `pattern` is ignored.

Enki warns, without refusing, about risky combinations: a browser without the dev server, a blind agent that writes code.

**Agents live in your library** (`~/.enki/library/agents/`), for every project, next to enki's own, which are read-only. A project never has its own: it gives an agent another model, effort or skills on its workflow's steps. Nothing in the library can take an enki agent's id.

**A workflow** is a JSON file: its steps and the edges from each step's outcomes. Three built-in steps frame every workflow:

- **Start:** the orchestrator passes on your request. Its one output, `request`, goes to the first step.
- **Approval:** you approve the plan. Only a planning step leads into it. Its `approved` starts the work, and `changes` goes back to the planner with your words.
- **End:** the task is done, and the orchestrator writes the notes and the report.

```json
{ "from": "reviewer", "on": "changes", "to": "coder", "max": 3 }
```

- **Before and after the plan:** the steps between Start and Approval are read-only. The ones after it do the work.
- **Targets:** an edge goes to one or more steps (in parallel), or to End.
- **Hand-offs:** an outcome with no edge goes back to the orchestrator, like QA's `blocked`, so you only wire what moves the work on. The step waits while the rest carries on. The orchestrator fixes what it can and resumes the step (`enki resume <step> --note "..."`), or asks you, and passes on your decision with `enki outcome <step> <outcome> --by user`. A step handed off more than twice stops the task.
- **Models and skills:** a step can set its own `model` and `effort`, which win over its agent's, and add `skills` to its agent's own. This is how a project tunes its agents, through its own workflow.
- **Positions:** `layout` keeps where each step sits in the dashboard's studio, and `routes` where each line runs. Enki ignores both when running.
- **Loops:** every loop needs a `max`. Past it, only you decide.
- **Waiting:** a step starts only once every step that sends it work has done so, counting a loop's line (one with a `max`) as enough on its own. It also waits while any step before it is still working, so findings arrive together and nothing runs on code that's about to change. A `waitFor` in an older workflow is ignored.
- **Built-in steps:** `verify` (Tests in the dashboard) runs the project's test, lint and gate commands itself, with no agent and no tokens, and reports `pass` or `fail` from their exit codes.

**What agents know about a workflow** comes from its graph alone. The planner's brief carries a summary enki writes from it: each step, what its agent may do, where each outcome goes, and what no step does (write tests, use a browser, review the work, fix failing tests). A plan that counts on work no step may do goes back to the planner before you see it: with no step that writes tests, it has to say `Tests: none`. The `description` is only for people choosing a workflow: agents never see it, and the task's own copy of the workflow leaves it out. A duplicate starts without one.

Enki refuses a workflow that can't run, whether in the CLI, the dashboard or an import. That covers:
- no Start, Approval or End, or Approval reached by something other than a planning step;
- a step before the plan that can write;
- a test run whose `pass` leads nowhere;
- a step that can't be reached, or can't reach End;
- a loop without a limit;
- more than 8 agent steps;
- code that could reach the end without a check by `verify` or a read-only agent.

It warns, without refusing, about a test run whose `fail` goes nowhere (failing tests then stop the run until you decide), and a description that names agents the workflow doesn't have.

**Where workflows live**, later ones winning:
- **Enki's own:** read-only.
- **Your library:** `~/.enki/library/workflows/`, for every project.
- **The project:** `.enki/workflows/`.

**Choosing:** the project's default is `"workflow"` in its config, `enki task new <slug> --workflow <id>` picks another, and the planner can switch with `Workflow: <id>` in its plan: the work so far stays, and what follows Approval comes from the new workflow. `Skip: <step>` drops steps, as `Tests: none` and `QA: none` do. Each task keeps a copy of its workflow and agents, so editing the library never changes a running task.

```
enki workflow list                      enki workflow show <id>
enki workflow use <id>                  enki workflow copy <id> <new-id> [--to library|project]
enki workflow export <id> --out x.json  enki workflow import x.json --by user
enki agent list                         enki agent show <id>
enki agent copy <id> <new-id>           enki agent export <id> --out x.json
enki agent import x.json --by user
```

**Export and import:**
- **A workflow's export** is one JSON file: the workflow, plus every agent it uses that isn't enki's own, with its instructions.
- **An agent's export** is the agent alone, with its instructions.
- **An import** shows each new agent's permissions and saves only with your approval. Agents always go to your library. It never overwrites anything, and never replaces enki's own agents.

Files from before agents were called agents still load: `role.json` and `SKILL.md`, `~/.enki/library/roles/`, workflow steps that say `"role"`, and exports with `roles`. Saving writes the new names. A project's old `.enki/roles/` folder isn't read anymore, and `enki validate` says so.

The dashboard's **Workflows** page does the same, and opens each workflow in the studio.

Workflows saved before Start and Approval existed are upgraded when enki reads them: Start leads to their old intake steps, a planner writes the plan, and Approval starts their old start steps.

## What enki runs, reads and sends

Enki has no telemetry and no server of its own. Everything below happens on your computer, in projects with `.enki/config.json`.

- **The prompt band.** A hooks module (`hooks/dashboard-band.tsx`) runs `enki dashboard link` when a session starts and after each turn, to learn whether the session orchestrates an open task. Its button runs `enki dashboard --open`, which on KDE also loads a one-off KWin script over D-Bus to raise the dashboard's window, and removes it again.
- **Hooks.** On every tool call in an enki project, the PreToolUse hook checks the call against the task policy and appends the tool's name and target to the task's `activity.jsonl`. The SessionStart hook gives the orchestrator its role and records its session ID on the task. Outside enki projects the hooks do nothing.
- **Agents.** `enki team start` opens herdr panes and starts Claude Code in them with `--permission-mode` set to your `permissionMode` setting, `auto` by default. Enki never changes your Claude settings files and refuses `bypassPermissions`.
- **Git.** Each task gets a worktree and a branch in your repo. Enki copies the gitignored files listed in `worktree.copy`, such as `.env` files, into the worktree, and commits to the task's branch when the task finishes. It never pushes.
- **Your commands.** `enki verify` runs your configured test commands. Team start runs your dev server, install and database copy commands when the config and plan ask for them.
- **Files outside your projects.** Enki writes to `~/.enki/`: the project registry, the port registry, the dashboard's cache and log, and the Playwright install. The dashboard reads Claude Code's transcripts in `~/.claude/projects/` to count tokens, and its model list in `~/.claude/cache/model-catalog/` for the settings page.
- **Network.** `enki playwright install` downloads `@playwright/mcp` 0.0.83 from the npm registry, and Chromium only with `--browser`. The dashboard page loads the Geist font from Google Fonts. Enki checks your dev server on localhost. Nothing else leaves your computer through enki.

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

Workers start with no skills, so they aren't distracted by, or paying context for, ones they don't need. Each loads only the skills its agent lists (on the Agents page, or `skills` in its `agent.json`), plus any its workflow's step adds for this project (in the studio's inspector, or `skills` on the step).

`enki skills` shows what each step of the project's workflow loads, and `enki skills --available` lists what's installed.

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
| `workflow` | `full` | The workflow new tasks run. See [Agents and workflows](#agents-and-workflows) |
| `permissionMode` | `auto` | Permission mode for workers |
| `timeouts` | 15 to 30 minutes, 2 for server start | Milliseconds per step |
| `database` | | `copy`, `drop` and `env` for per-task databases, `default` (`copy`, `shared` or `none`) for plans without a Database line, and `enabled` (`false` stops copying) |
| `policy` | | `secrets` and `protected` globs, and `bash` rules with `pattern` and `reason`. These can only add restrictions |

Also in `.enki/`:

- `playbook.md`: project rules, by role, passed to the workers
- `notes/<repo>.md`: living knowledge about each repo
- `tasks/<date>-<slug>/`: plan, reports, `state.json` and `events.jsonl`. Gitignored by default

A plan sets options with lines you approve: `Workflow: <id>` to run another workflow, `Skip: <step>` (or `Tests: none`, `QA: none`) to drop steps, and `Scope: deps`, `Scope: infra` or `Scope: git-init` to unlock extra permissions.

## What is enforced

| Rule | Enforced by |
|---|---|
| Only read-only steps run before approval, and the plan the user approves is the planner's | `enki` refuses steps out of turn, a workflow with a writing step before Approval is refused, the `PreToolUse` hook refuses an `ExitPlanMode` that isn't the planner's plan word for word, and approval is only recorded by a hook on the approved `ExitPlanMode` |
| Steps run in the workflow's order | `enki ask` and `enki verify` refuse a step the workflow hasn't made ready |
| Agents can't claim approval | `enki phase approved` is refused, and task state files can't be edited with file tools |
| The orchestrator can't edit project files | `PreToolUse` hook |
| Write ownership per agent | `PreToolUse` hook, on file tools and on visible Bash writes, from each step's agent capabilities |
| Secrets can't be read or written | `PreToolUse` hook |
| Blind steps can't see the work | On each tool call, the hook compares the tree with a snapshot taken before coding, and blocks those files, `git diff`, recursive search, the plan, and the reports of steps that see the work |
| Work is checked before the end | A workflow where code could reach the end without `verify` or a read-only check is refused. A task can't reach notes or report until its workflow ends. `enki phase done --abandon` is the only way out, and it's recorded |
| Test results mean something | `enki verify` refuses while any step that writes is working |
| An agent's outcome is its own | Only the worker reports it, from its agent's list. Only the user can choose one for it (`enki outcome --by user`) |
| No commits, pushes, destructive git, kills, `sudo`, publishing, package installs, server control | `PreToolUse` hook, including through `bash -c`, `eval`, `xargs`, `find -exec`, substitutions and env wrappers |
| Loops stop at their limit | Past an edge's `max`, the step goes to the orchestrator, and only the user can take it further. A step handed off too often stops the task |
| Each task stays in its own worktree | The hook lets workers write only their task's worktree. The main tree, other tasks' worktrees and, for the orchestrator, all worktrees are refused |
| Secrets stay out of commits | Enki removes everything it copied or linked before it commits |
| Test accounts stay out of files and logs | `enki secret set <name> <value>` stores one outside the repo, readable only by you. Agents read it with `enki secret get <name>`. Enki replaces its value with `[secret:<name>]` in the events and activity log, and the `PreToolUse` hook refuses a file write that contains it |
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
- **`.enki/config.json` is trusted.** Enki runs `devServer.start` and `devServer.stop` outside the hooks, and the orchestrator can edit that file, because it records what it learns there. So can you, from the dashboard's settings page, including the database commands. Review changes to it the way you'd review a script.
- **Workers can't be stopped from reading non-secret files** outside their task. Reading is unrestricted apart from secrets.
- **A stored secret can still be seen** in Claude Code's own transcripts, in what a page shows, and in files a Bash command writes. Enki keeps it out of its own logs and refuses file-tool writes; a value pasted into chat is in that chat's transcript.

Which prompts the orchestrator approves on its own is its judgement, guided by instructions. The limits on that are the one-time rule, the log and the policy hook. Direct `herdr` input commands are denied, so `enki answer` can't be sidestepped through the Bash patterns enki knows about.

## Development

```
npm test
claude plugin validate .
```

To try a working copy, run Claude with `--plugin-dir` and set `ENKI_DEV_PLUGIN_DIR` to the same path, so workers load it too. Tests run against a fake herdr (`tests/helpers/fake-herdr.mjs`) whose responses were captured from real herdr. `docs/spike-results.md` records what was verified against the real tools.

## License

Apache License 2.0. See [LICENSE](LICENSE).

If you build on enki or redistribute it, keep the [NOTICE](NOTICE) file with your copy and include its attribution in your documentation, as section 4 of the license requires.
