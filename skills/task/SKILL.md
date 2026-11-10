---
description: Starts an enki task. Use for any request to change code, tests, config or docs in an enki project, however small. Covers intake, clarifying questions, the plan and approval.
argument-hint: "[request]"
---

# Enki task intake

Request: $ARGUMENTS

Every task starts here. Only the scout runs during intake. Coder, tester and reviewer don't start, and no file changes, until the user has approved the plan.

## 1. Understand

1. Pick a short kebab-case slug and run `enki task new <slug> [--repo <name>]`. It creates the task's worktree on a new branch named after the slug, from the branch the repo is on, gives it a free port, builds the task tab and starts the scout. If it refuses because of uncommitted changes, no commits, or an existing branch, tell the user exactly what it said: committing is theirs to do. If it exits 3, a folder trust prompt is waiting: ask the user whether to trust the folder, and if they agree, run `enki answer scout trust`, then `enki start scout`.
2. Run `enki status`, and read each affected repo's notes at the `Memory for <repo>` path it gives: that's the task's own copy, on the task's branch. A project that hasn't run `enki migrate` keeps its notes in `.enki/notes/<repo>.md`.
3. Write the raw request to `<task folder>/plan.md`. Write a scout brief to `<task folder>/briefs/scout-1.md`, with the request and relevant notes.
4. Run `enki ask scout <brief>` with `run_in_background: true`. Send follow-up questions the same way. Delegate real exploration: do only small, targeted reads yourself.

5. Check what the scout learned about starting and testing the system. If the commands, URL or port are missing or wrong, correct them now in the repo's `repo.json` in the task's memory (or in `.enki/config.json` for an unmigrated project) (`test`, `lint`, `url`, `testGlobs`, `devServer.start`, and `devServer.stop` if the server runs in the background), add the details to the repo notes, and run `enki validate`.

## 2. Clarify

Always ask, with `AskUserQuestion`, in batches of 1 to 4, with a recommended option first where there is one. Cover whatever is unclear among:

- Scope: what's in, and what's explicitly out
- Expected behaviour, UX details, edge cases, error states
- Affected repos, user roles and pages
- For features reading user-editable files: what happens when the file is missing, invalid or a symlink
- For new repos: stack, structure, test tooling, how it runs locally
- How the user will judge it done

Don't ask what the code or notes already answer: state those as assumptions. Repeat until nothing important is ambiguous.

## 3. Goal and sub-goals

- **Goal:** one or two sentences on the outcome, not the implementation.
- **Sub-goals:** numbered, small and independently verifiable, each with observable **acceptance criteria**, such as "user sees X when Y" or "API returns 400 for Z". Include invalid-input cases.
- **Out of scope:** what you're deliberately not doing.

## 4. Plan

Run `enki phase planning`. For each sub-goal give the approach, the files expected to change, the test plan (code tests, plus browser scenarios for a UI), risks, and anything that needs a server restart.

For visual work, state the expected look of each affected surface after the change, and label numbers as starting values to calibrate.

The plan must also carry these lines, at the start of a line, because enki reads them from the approved text:

- `Scope: deps` if the task changes dependencies. List the exact packages.
- `Scope: infra` if the task changes CI, Docker or server config.
- `Scope: git-init` if the task creates a new repo.

Only include a `Scope:` line the user actually wants.

If the project config has a `database` section, also add one of these lines, with a one-line reason. Start from the project's `database.default` (`copy` if unset), and change it only when the task calls for another:

- `Database: copy`: the task gets its own copy. Use it whenever tests or QA might write data. Not available while `database.enabled` is `false`: enki uses the shared database instead.
- `Database: shared`: the task uses the real one. Only when nothing can write to it.
- `Database: none`: the task needs no database, and enki cuts it off so nothing reaches the real one by accident.

If the line is missing, enki uses the project's default.

Every plan has a **Steps** list, one line per step, each with exactly one owner. Enki reads it from the approved plan, agents work it step by step, and the dashboard shows it:

```
1. [Scout] Map the refund code paths
2. [Tester] Write tests for duplicate refunds
3. [Coder] Add the idempotency middleware and migration
4. [QA] Try a double refund on the running app
5. [Reviewer] Review the diff
6. [Orchestrator] Update notes and write the report
```

Owners are Orchestrator, Scout, Coder, Tester, QA or Reviewer. Split work so each step is one agent's. `enki team start` refuses a plan without steps.

Also add a **public interface** section to the plan: the routes, commands, exported names and element IDs tests can rely on. The tester and coder work from it at the same time, so it has to be specific.

Add `Tests: none` only for a change with no testable behaviour, such as a copy edit. Add `QA: none` only if nothing about the change can be checked by hand.

If a role would clearly benefit from a skill it doesn't have, suggest it to the user. With their agreement, add it to `team.<role>.skills` before `enki team start`, because a running worker can't pick it up. `enki skills --available` lists what's installed.

## 5. Approve

Enter plan mode with `EnterPlanMode`, present the goal, sub-goals and plan, and finish with `ExitPlanMode`. Iterate until the user approves. Their approval is recorded automatically: you can't record it yourself, and `enki team start` refuses until it has happened.

## 6. Hand over

Write `<task folder>/requirements.md` with the goal, sub-goals, acceptance criteria, public interface and out of scope. Leave out the approach, file names and anything else about how it will be built. It's all the tester and QA get, so it has to stand on its own.

Then load the **enki:execute** skill.
