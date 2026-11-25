# Commands and configuration

Everything you can run and set.

## Commands

| Skill | Use |
|---|---|
| `/enki:init` | Set up the current project |
| `/enki:task <request>` | Start a task. In `auto` mode any change request does this |
| `/enki:resume <name>` | Continue a task after `/clear` or in a new session |
| `/enki:status` | Show task state |

### The enki CLI

The orchestrator drives the `enki` CLI. It comes with the plugin, so it's on the `PATH` inside Claude Code sessions, in any folder, and not in your own terminal. To run a command yourself, type it at the Claude Code prompt with `!` in front:

```
! enki help
! enki dashboard --open
```

## Configuration

`.enki/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `auto`: every session here is the orchestrator. `explicit`: only after `/enki:task` |
| `repos[]` | | `path` (required), `name`, `test`, `lint`, `url`, `testGlobs`, `devServer`, `gate` |
| `baseBranch` | `dev` | The branch new tasks fork from |
| `worktrees` | `true` | `false` for a project that isn't in git: tasks share one tree |
| `memory` | `repo` | `repo` or `private`: see [Memory](memory.md) |
| `workflow` | `full` | The workflow new tasks run. See [Agents and workflows](agents-and-workflows.md) |
| `permissionMode` | `auto` | Permission mode for workers |
| `timeouts` | 15 to 30 minutes, 2 for server start | Milliseconds per step |
| `database` | | `copy`, `drop` and `env` for per-task databases, `default` (`copy`, `shared` or `none`) for plans without a Database line, and `enabled` (`false` stops copying) |
| `policy` | | `secrets` and `protected` globs, and `bash` rules with `pattern` and `reason`. These can only add restrictions |

Also in `.enki/`:

- `playbook.md`: project rules, by role, passed to the workers
- `memory/<repo>/`: each repo's memory, in private memory mode
- `tasks/<date>-<slug>/`: plan, reports, `state.json` and `events.jsonl`. Gitignored by default

A plan sets options with lines you approve: `Workflow: <id>` to run another workflow, `Skip: <step>` (or `Tests: none`, `QA: none`) to drop steps, and `Scope: deps`, `Scope: infra` or `Scope: git-init` to unlock extra permissions.

## Permission modes

You only talk to the orchestrator. Workers run in `auto` mode by default, so they rarely stop. When one does, the orchestrator handles the prompt:

- It approves one-time requests that are clearly needed for the approved plan, such as tests, builds and local requests.
- It asks you in the chat about anything else, and passes on your decision.
- It always asks you before trusting a folder.

`enki answer` is the only route. It accepts only a plain Yes or a No, so wider grants such as "always allow" are refused, and every answer goes in `events.jsonl` and the report. Workers can't open dialogs, so their questions arrive as replies to the orchestrator.

Enki's policy applies in every mode, and a command the hook denies stays denied whatever the orchestrator answers. If your account doesn't have auto mode, set `permissionMode` to `acceptEdits` or `default`. The orchestrator will then get more prompts. Enki refuses `bypassPermissions`.
