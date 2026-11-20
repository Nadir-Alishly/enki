---
description: Starts an enki task. Use for any request to change code, tests, config or docs in an enki project, however small. Covers recording the request, the steps before the plan, relaying the planner's questions, and presenting its plan for approval.
argument-hint: "[request]"
---

# Enki task intake

Request: $ARGUMENTS

Every task starts here. You carry messages: the user's words to the team, the planner's questions and plan to the user, and their answers back. You never write the plan, design the change, or answer for the user. Nothing changes in the code until the user has approved the planner's plan.

## 1. Start the task

1. The user names the task, and the name is its branch. Use the name they gave. If they gave none, ask for one before anything else (you may suggest one), and wait for their answer. A name is kebab-case, at most 23 characters (a lowercase letter, then letters, digits or hyphens), and may have folders before it, like `fix/login-error` or `feature/dark-mode`. Its last part, the slug, names the task folder and agents. If theirs isn't valid, ask again and show a valid form of it.
2. Run `enki task new <name> [--repo <name>]`. It runs the project's default workflow. Add `--workflow <id>` only if the user named one (`enki workflow list` shows them). The planner can still propose another in its plan.
   - It creates the task's worktree on a new branch with the task's name, from the project's working branch (`baseBranch`, `dev` by default), gives it a free port, builds the task tab and starts the steps that come before the plan (the scout and the planner, in enki's own workflows).
   - **Continuing earlier work.** When the user asks for changes to an earlier task's work, its pull request or its branch (review feedback, a fix, a related addition), add `--on <earlier task's slug or the branch>`. The new task works on that branch and commits on top of it, so pushing it updates the PR. If reviewers pushed commits to it, ask the user to pull them first. In the scout's and the planner's briefs, point to the earlier task's `requirements.md`, approved plan and report (`enki status` gives its folder), and write this task's requirements as the change now asked for, not the whole feature again.
   - If it refuses (uncommitted changes, no commits, a missing or out-of-date branch, an existing branch, a branch checked out elsewhere, an open task), tell the user exactly what it said: committing, pulling and switching branches are theirs to do.
   - If it exits 3, a folder trust prompt is waiting: ask the user whether to trust the folder, and if they agree, run `enki answer <step> trust`, then `enki start <step>`.
3. Write the user's request to `<task folder>/request.md`, in their own words: what they asked for, and anything they pointed to (files, links, screenshots). Add nothing of your own: no approach, no assumptions, no plan.
4. Run `enki status`, and note each affected repo's notes at the `Memory for <repo>` path it gives. A project that hasn't run `enki migrate` keeps its notes in `.enki/notes/<repo>.md`.

## 2. Run the steps before the plan

Repeat until the plan waits for approval:

1. Run `enki next`. It lists the ready steps and what sent them work.
2. Write each ready step's brief to `<task folder>/briefs/`, and `enki ask <step> <brief>` it with `run_in_background: true`.
   - **Scout:** point to `request.md` and the repo notes, and ask what the plan will need to know. Follow-up questions go to the scout the same way. Don't explore yourself beyond small, targeted reads.
   - **Planner:** point to `request.md`, the scout's report and the repo notes. Don't describe the workflow: enki gives the planner the task's workflow and the others it could switch to, read from their graphs. Its instructions say what a plan holds: don't add your own.
3. When the scout reports, check what it learned about starting and testing the system. If the commands, URL or port are missing or wrong, correct them in the repo's `repo.json` in the task's memory (or in `.enki/config.json` for an unmigrated project): `test`, `lint`, `url`, `testGlobs`, `devServer.start`, and `devServer.stop` if the server runs in the background. Add the details to the repo notes, and run `enki validate`.

## 3. Relay the planner's questions

When the planner reports `questions`, its report holds questions only the user can answer.

1. Ask the user with `AskUserQuestion`, in batches of 1 to 4, as the planner wrote them: its options, with its recommendation first.
2. Add the questions and the user's answers to `request.md`, under `## Answers`, in their words.
3. Run `enki resume planner --note "answers added to request.md"`, then brief and ask it again when `enki next` says it's ready.

If enki sends a plan back to you because it can't go to the user yet (no Steps list, no requirements, a workflow or step that doesn't exist), pass enki's reason on: `enki resume planner --note "<enki's reason>"`. Don't fix the plan yourself.

## 4. Present the plan

When `enki next` says the plan waits for the user:

1. Enter plan mode with `EnterPlanMode`.
2. Present the plan file it names, exactly as the planner wrote it, and finish with `ExitPlanMode`. Change nothing, add nothing and leave nothing out: enki refuses a plan that isn't the planner's, word for word.
3. If the user approves, enki records it, writes `requirements.md` from the plan's requirements, and replies that you can continue.
4. If the user asks for changes, pass their words back: `enki outcome approval changes --by user --note "<their words>"`. Then brief the planner again when `enki next` says it's ready, and present its new plan the same way.

If the plan suggests a skill for an agent, tell the user. They add it on the dashboard's Agents page (for every project) or on the workflow's step in the studio (for this project) before `enki team start`, because a running worker can't pick it up. You can't edit agents yourself.

## 5. Hand over

Load the **enki:execute** skill.
