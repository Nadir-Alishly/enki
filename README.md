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

Agents never commit. You review the working tree and commit it yourself.

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

## Requirements

- Claude Code 2.1.318 or newer
- [herdr](https://herdr.dev), with Claude running inside a herdr pane
- Node 22 or newer
- Claude in Chrome, for browser testing (optional: set `"driver": "none"` without it)

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

The orchestrator drives the `enki` CLI, which is on the Bash `PATH` while the plugin is enabled. Run `enki help` to see it.

## Configuration

`.enki/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `auto`: every session here is the orchestrator. `explicit`: only after `/enki:task` |
| `repos[]` | | `path` (required), `name`, `test`, `lint`, `url`, `testGlobs`, `devServer`, `gate` |
| `team` | Haiku for scout, tester and QA, Sonnet for coder and reviewer, no skills | `model`, `effort` and `skills` per role |
| `permissionMode` | `auto` | Permission mode for workers |
| `browser.driver` | `chrome` | `chrome` or `none` |
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
| QA only runs on finished code | `enki ask qa` needs the coder's report for the round |
| Blocked workers are handled at once | `enki ask` returns immediately, and `enki answer` allows only one-time options and logs each one |
| Workers really run the hooks | `enki` waits for each worker to report its hooks live, and fails if it doesn't |
| Only one tester uses Chrome | A machine-wide lock |
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
