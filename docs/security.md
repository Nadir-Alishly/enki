# Security

What enki does on your computer, what it enforces, and where the limits are.

## What enki runs, reads and sends

Enki has no telemetry and no server of its own. Everything below happens on your computer, in projects with `.enki/config.json`.

- **The prompt band.** A hooks module (`hooks/dashboard-band.tsx`) runs `enki dashboard link` when a session starts and after each turn, to learn whether the session orchestrates an open task. Its button runs `enki dashboard --open`, which on KDE also loads a one-off KWin script over D-Bus to raise the dashboard's window, and removes it again.
- **Hooks.** On every tool call in an enki project, the PreToolUse hook checks the call against the task policy and appends the tool's name and target to the task's `activity.jsonl`. The SessionStart hook gives the orchestrator its role and records its session ID on the task. Outside enki projects the hooks do nothing.
- **Agents.** `enki team start` opens herdr panes and starts Claude Code in them with `--permission-mode` set to your `permissionMode` setting, `auto` by default. Enki never changes your Claude settings files and refuses `bypassPermissions`.
- **Git.** Each task gets a worktree and a branch in your repo. Enki copies the gitignored files listed in `worktree.copy`, such as `.env` files, into the worktree, and commits to the task's branch when the task finishes. It never pushes.
- **Your commands.** `enki verify` runs your configured test commands. Team start runs your dev server, install and database copy commands when the config and plan ask for them.
- **Files outside your projects.** Enki writes to `~/.enki/`: the project registry, the port registry, the dashboard's cache and log, and the Playwright install. The dashboard reads Claude Code's transcripts in `~/.claude/projects/` to count tokens, and its model list in `~/.claude/cache/model-catalog/` for the settings page.
- **Network.** `enki playwright install` downloads `@playwright/mcp` 0.0.83 from the npm registry, and Chromium only with `--browser`. The dashboard page loads the Geist font from Google Fonts. Enki checks your dev server on localhost. Nothing else leaves your computer through enki.

## What is enforced

| Rule | Enforced by |
|---|---|
| Only read-only steps run before approval, and what the user approves is the spec writer's spec and the planner's plan | `enki` refuses steps out of turn, a workflow with a writing step before Approval is refused, the `PreToolUse` hook refuses an `ExitPlanMode` that isn't the waiting spec or plan word for word, and approval is only recorded by a hook on the approved `ExitPlanMode` |
| Steps run in the workflow's order | `enki ask` and `enki verify` refuse a step the workflow hasn't made ready |
| Agents can't claim approval | `enki phase approved` is refused, and task state files can't be edited with file tools |
| The orchestrator can't edit project files | `PreToolUse` hook |
| Write ownership per agent | `PreToolUse` hook, on file tools and on visible Bash writes, from each step's agent capabilities |
| Secrets can't be read or written | `PreToolUse` hook |
| The map holds together, and only its own task's copy changes | The mapper's `map` write level allows only the task's `map/`. `enki memory check` stops a task at its notes step on a broken link or an unlisted file |
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
