# Phase 0 spike results

Tested on 2026-11-04 with Claude Code 2.1.318 and herdr 0.9.5, using a throwaway plugin and Haiku workers in a real herdr tab.

| # | Assumption | Result |
|---|---|---|
| 1 | `--env` on `herdr tab create` and `pane split` reaches Claude and hook processes | Confirmed for both |
| 2 | `--append-system-prompt-file` works through `herdr agent start` | Confirmed |
| 3 | Plugin hooks and `bin/` load in workers | Confirmed with `--plugin-dir`. User-scope install is covered by the fresh-install check |
| 4 | `PreToolUse` deny holds in workers, over allow rules | Confirmed: denied `echo SPIKE_DENY` with `Bash(echo *)` allowed |
| 5 | `SessionStart` context returns after `/clear` and `/compact` | Confirmed, with `source` of `clear` and `compact` |
| 6 | `PostToolUse` fires for `ExitPlanMode` | Fires on approval, with the plan text in `tool_response.plan`. Does not fire when the dialog is cancelled with Esc |
| 7 | Blocked permission prompts survive until answered | In `--permission-mode default`, a prompt stayed open for the full 6-minute test with nothing denied |

## Design consequences

- **Permission mode is always explicit.** A worker started without the flag ran in auto mode. Enki passes `--permission-mode` from config, default `default`.
- **Folder trust blocks startup.** `agent start` fails with `agent_not_ready` and the agent shows `blocked`. Enki stops and asks the user to answer in the pane, then `enki start <role>` continues. It never answers this prompt. v1.1 worktrees will hit this for each new path.
- **`agent_prompt_stalled` is a distinct outcome.** It means no turn was observed within 5 seconds. Slash commands always produce it. Enki inspects the pane and never resends blindly.
- **`--timeout` requires `--wait`** on `agent prompt`, or the command exits 2 and sends nothing.
- **`agent read` with `--lines` fails while blocked** (`agent_not_idle`). Enki falls back to `--source visible`.
- **`agent read` returns plain text.** Most other commands return JSON, with errors as JSON on stderr and exit code 1.
- **`pane layout` returns pane rectangles**, so the 2×2 grid can be verified numerically.
- **Approval can be automatic.** The hook sets `approved` only on `PostToolUse`, so a cancelled plan can't pass the gate.

## End-to-end results

Tested on 2026-11-04 with a live orchestrator on a sample web project. Two tasks ran in real herdr tabs. The first finished fully, on a light team in auto mode. The second stopped at the baseline, because it reached prompts a person has to answer.

### Verified live

- Orchestrator role on start, after `/clear`, and mid-task recovery from files alone
- Real 2×2 grid, worker hooks reporting live, light team from the plan's `Team: light` line
- Intake, questions, plan approval, baseline, coding, testing, notes and report, with no commits
- Asking the user for a server restart instead of doing it
- Plan rejection, by Esc and by "Tell Claude what to change": nothing recorded
- A blocked worker: `enki ask` exits 3, and the orchestrator relays the prompt and refuses to approve it
- Policy denials in real agents: `git push`, `git stash`, `cat .env`, `herdr send-keys`, and writes by the orchestrator, tester and scout
- A second orchestrator in the same project sees no task of its own
- Fresh install from the marketplace file in an isolated config: 6 skills, 3 hooks, about 184 tokens always-on

### Not yet verified live

- A full team with a reviewer
- A real fix round. `enki round next` and its limit are covered by tests only
- Chrome testing through the `chrome` driver and the browser lock
- `git commit` and `npm install` denials in a live worker. The coder declined to attempt them, so these rest on the hook tests

### Bugs these runs found

| Bug | Why tests missed it | Fix |
|---|---|---|
| The orchestrator skipped the scout | Only instructions required it | `enki phase planning` needs `scout.md`, and approval only counts in the `planning` phase |
| Any project under the session scratch tree lost all write rules | Test projects sat outside that tree | The scratch exception never applies inside the project |
| `testGlobs` never reached task state, so the tester couldn't write tests and the coder could | The policy table built its state by hand | State carries the globs, with a test through a real created task |
| A blocked worker left the orchestrator idle until told | Tests answered at once | `enki wait` waits through the prompt, so it can start right away |
| In `default` mode, every report write needed a prompt | Fake herdr has no permissions | A narrow allow rule for the task folder |

## Change after user testing

The first version made the user answer worker prompts in each pane. After trying it, the user wanted to talk only to the orchestrator, so this was reversed:

- Workers default to `auto` mode.
- The orchestrator handles worker prompts through `enki answer`, and asks the user in the chat about anything outside the approved plan.
- Workers launch without `AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode`, so their questions arrive as replies.

`enki answer` was tested on real permission dialogs in a live worker. A real dialog showed wording a phrase list would miss ("Yes, allow reading from … during this session", and `don’t` with a curly apostrophe), so only a plain Yes or a No is accepted.

Not yet seen live: an orchestrator making these decisions by itself from the new prompt.

## Second round of user feedback

- **Enki runs the dev server.** The first version made the user start it. Now `enki team start` starts it in its own tab, `enki server restart` picks up changes, and `enki phase done` stops it. Agents still can't touch servers directly. This uses the `devServer.managedBy` seam.
- **The orchestrator learns how the system starts and is tested.** The scout reports the commands, and the orchestrator keeps them in config and the notes. The team won't start until a start command is recorded.
- **No empty Chrome tab.** The tester reuses the empty tab `tabs_context_mcp` creates, and closes it at the end. This is an instruction, and hasn't been seen live.
- **False denials from the first real project.** The policy didn't follow `cd` or variables, so work in scratch folders was refused. It now follows `cd`, and skips paths only the shell can resolve.

`enki server` was verified on real herdr: start, repeat start, restart, status, stop, and a failing command.

## Non-Node projects

`devServer.start` was always per project, but other parts assumed a Node stack. Each project's own start and stop commands are now blocked for agents, the default rules cover common servers on other stacks, `devServer.stop` handles commands that run in the background, and default test globs cover more languages.

Checked on real herdr with a Python server, in the foreground and in the background with a stop command. This found a bug tests couldn't: `herdr pane run` types into the user's login shell, so POSIX syntax failed on fish. Enki now writes the command to a script in the task folder and runs it with `sh`.

## Tester split

After testing, the user asked for two testing agents, with neither seeing the coder's work, and for review to wait for tests. No server had been started in the earlier run because `test-website` still had `managedBy: "user"` from the `/enki:init` example, and no worker was able to start one.

The workflow is now baseline, tests from `requirements.md`, code, `enki verify`, QA, review. `enki verify` runs the tests with no agent, and its result gates QA and the reviewer.

Verified on real herdr with Haiku workers: the three-column layout, gates refusing the reviewer and QA before tests passed, a QA worker starting the server from its own pane, the reviewer gate opening, and the server stopping when the task finished. The folder trust flow through `enki answer` also ran live.

The live tester declined to read the coder's change by following its role, so no live worker reached the blindness rules. They're covered by tests that run the real hook script against a real git repo.

Not yet seen live: a full orchestrated task on this workflow, a tester writing tests before code, and QA in Chrome.

## Parallel team, mandatory reviewer

After another user check, the reviewer turned out to have been skipped because the orchestrator wrote `Team: light` into the plan. That option is gone: the reviewer always starts, and a task can't reach notes or report without its report for the current round. `enki phase done --abandon` is the only way out, and it's recorded.

Agents now run in parallel wherever nothing depends on another's output: tester and coder after the baseline, QA and `enki verify` once the coder reports, and the reviewer as soon as tests pass. Because the tester overlaps the coder, the hook works out the coder's changes on every tool call.

Verified on real herdr with Haiku workers: four agents started in 3.8 seconds, tester and coder overlapped, QA, verify and the reviewer overlapped, a plan saying `Team: light` still got a reviewer, and the finish gate refused until QA and reviewer reports existed.

Not yet seen live: a worker reaching the blindness rules, a real fix round, and QA in Chrome.

## Worker skills

The user wanted workers to start with no skills, and load only those listed for their role. Measured with Haiku and marker skills on Claude Code 2.1.318:

| Setup | Skills listed | Full content loaded |
|---|---|---|
| Normal session | All | No |
| `--disable-slash-commands` | None, and no Skill tool | No |
| `--agent` with a `skills` field | All | No: it doesn't preload for a main session |

So workers start with `--disable-slash-commands`, and enki finds each listed `SKILL.md` and adds it to the role file. With skills off, enki's hooks still fire, and the Chrome tools are still there.

A live scout listed only its two configured skills, a project skill and a 28 KB plugin skill, and could use both. Real data also exposed a stray file in the synced skills folder, which is now skipped.

Not yet seen live: a skill's supporting files in use, and QA using Chrome with skills off. The Chrome tools were confirmed present, not exercised.

## Playwright for QA

The user asked for manual testing through Playwright instead of the Chrome extension, and chose MCP tools, a system browser first with download only as a fallback, headless runs, and no login support for now.

- `@playwright/mcp` 0.0.83 is pinned, the newest release at least two weeks old when chosen. It installs into `~/.enki/playwright` with `--ignore-scripts`: 3 packages, 19 MB.
- QA gets only this MCP server (`--strict-mcp-config`), headless and isolated, with its output folder in the task and `--allowed-origins` set to the project's local URLs.
- Playwright's help says `--allowed-origins` is not a security boundary, and the README says so too.

Verified live with a Haiku QA worker, using the real install and the system Chromium 152: QA started the server, opened the page through Playwright, saved a 1280×720 screenshot to `qa-evidence/`, and `example.com` was refused with `ERR_BLOCKED_BY_CLIENT`. No Playwright or browser processes were left after the task tab closed.

Not yet tested live: `enki playwright install --browser`, which downloads Chromium, a visible window with `headless: false`, and several tasks testing at once.

## Worktrees for parallel tasks

Phase 0, checked with real git, real herdr and test-website's own stack:

| Check | Result |
|---|---|
| Worktree nested under `.enki/worktrees` | Works, and stays out of the main tree's `git status` |
| Folder trust for a worker in the worktree | No prompt: it inherits the project's trust |
| Vite and Vitest with a linked `node_modules` | All 252 of test-website's tests passed, and the dev server served the app and its dependencies |
| `git worktree remove` | Refuses uncommitted changes, but ignored files don't block it once the work is committed |
| Unstaging copies at commit time | Doesn't work: git refuses to name ignored paths. Enki deletes its copies and links before staging instead |
| A `node_modules/` rule with a trailing slash | Doesn't cover a symlink, so git sees it. Deleting links before staging handles this |

Real git also exposed three bugs the first test run caught: git output was trimmed so the first dirty path lost a character, the database URL was written before the plan chose a mode, and a task couldn't be abandoned before approval.

Not yet seen live: two orchestrated tasks running in one repo with real agents, and a real database. The scratch folder used for live tests was removed between sessions.

## Repo memory

A repo's notes, commands (`repo.json`) and playbook now change on the task's branch, and reach the base branch only through a merge. One mode per project:

- `repo`, the default: the files are committed in `<repo>/.enki/`.
- `private`: for team repos where enki files mustn't be committed. A local bare git repo per code repo in `.enki/memory/`, with branches mirroring the code's. It's synced at task start and by `enki memory sync`, by ancestry or by `git cherry`.

Tested with real git (32 tests): migrations in both modes, branch-local settings, policy, commits, abandon, two repos merged separately, and in private mode every merge style (merge, fast-forward, rebase, squash), deleted branches, conflicts with a resumable sync, and manual merges.

`enki migrate` ran in both modes on copies of `test-website`. Files, config and old-file renames were as expected, and private mode left the code repo untouched. No unmerged-knowledge warning appeared, correctly: `cart-page` had already been merged into `dev`.

Not yet seen live: a real orchestrator writing memory during a task, and the init question.

## Dashboard

Checked against real data before building:

| Check | Result |
|---|---|
| Claude session ID of a herdr agent | `herdr agent list` and `agent get` give it as `agent_session.value`, for the unnamed orchestrator pane too |
| Token usage in transcripts | `~/.claude/projects/<folder>/<session>.jsonl`, on assistant lines as `message.usage`. One response repeats on up to 13 lines with the same `message.id` and usage (650 lines, 222 distinct), so the cache counts each ID once |
| Spent and context | Spent is input, cache writes and output. Context is the latest message's input, cache writes and cache reads |

Tested (14 tests): the token reader, starting from a folder outside any project, reuse, restart after a kill, replacing an older build, three simultaneous starts leaving one server, idle exit, a port held by another program, workers refused, the Host check, no CORS, view-only methods, and the task and project views against the fake herdr, with steps, states, tokens and activity.

Screenshotted headlessly with enki's own Playwright install, against `test-website`'s six finished tasks. Those tasks predate the dashboard, so they show their event history but no tokens, steps or tool calls.

