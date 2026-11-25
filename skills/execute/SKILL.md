---
description: Runs an approved enki task through its workflow, from the baseline to the end, briefing each step the workflow makes ready and handling hand-offs. Use after plan approval.
---

# Enki task execution

The approved plan is in `<task folder>/approved-plan.md`, and the workflow it runs in `<task folder>/workflow.json`. Enki runs the workflow: it decides which steps are ready, routes each step's outcome to the next, and refuses to start a step out of turn. Your job is to brief the ready steps, run the built-in ones, and deal with what's handed to you.

Write each brief to `<task folder>/briefs/`, and run every `enki ask` with `run_in_background: true`. A brief names its plan steps: `enki ask <step> <brief> --step N`, or `--step 2,3,4` for several. **One visit does all of a step's open plan steps:** when the plan gives the coder steps 2–4, brief them together in one ask. The workflow moves on (tests, QA) after each visit, so a visit that does part of the work gets checked as if it were all of it. Enki adds the rules, the report path, what led the step here, and the outcomes it can report.

What goes in a brief:

- **Steps that see the work** (enki's coder and reviewer, and any agent that isn't blind): the plan steps it works on, the approved plan and scout report paths, and the map area files that matter (or the relevant notes). When findings sent a step back, consolidate them: describe each failure scenario and its constraint, and let the coder choose the fix. Prescribe a fix only if a reviewer proposed it, and ask the coder to consider adversarial cases. For visual work, say the coder must read QA's screenshots before each tuning pass.
- **Test accounts and other secrets the user gives:** never write one into a brief or any file (enki refuses). Store each with `enki secret set <name> <value>`, then name it in the brief: the agent reads it with `enki secret get <name>`. Enki keeps stored values out of its logs.
- **The mapper** (the map workflow): one visit per top-level area. Brief one `[Mapper]` plan step at a time, with `--step N`; it reports `more` until the outline is done. This is the one exception to one visit doing all a step's plan steps.
- **Blind steps** (enki's tester and QA): point to `spec.md` and describe behaviour only. They may read the map too. Never paste code, diffs or other steps' reports into them. For QA, give an explicit list of what to check, including what a fix must not disturb.

## 1. Baseline

1. Run `enki team start`. It starts every step of the workflow. If it says Playwright or a browser is missing, ask the user before running the `enki playwright install` command it names, because it downloads software. If it says nobody has recorded the start command, work it out from the scout report, correct `.enki/config.json` and the notes, then run it again. If it says the workflow can't run, the plan needs fixing: tell the user, and with their words send it back to the planner (`enki outcome approval change-plan --by user --note "..."`). If it exits 3, a folder trust prompt is waiting: ask the user whether to trust the folder, and if they agree, run `enki answer <step> trust`, then `enki start <step>`.
2. Run `git status` in the affected repos. Dirty files are the user's own: leave them alone.
3. Run `enki phase baseline`, then `enki verify --baseline`. If it fails, have a step that writes tests sort stable pre-existing failures from flaky ones, once the workflow sends it work, and add them to the map's root (or the notes). A brand-new repo has nothing to run.

## 2. Run the workflow

Run `enki phase coding`. Then repeat until the workflow ends:

1. Run `enki next`. It lists the ready steps, each with what sent it work, plus what's running, what's waiting and what's with you.
2. In one message, start everything ready: write a brief and `enki ask` each agent step in the background, and run `enki verify` for a ready verify step.
3. When a step finishes, its result ends with its outcome and where the work went next. Go back to 1.

What `enki verify` does as a step:

- **Passed:** its `pass` edge runs.
- **Failed:** its `fail` edge runs, usually back to the coder, with the failing output in its report.
- **Failing since the baseline:** have a step that writes tests confirm no failure is new, then run `enki verify --known-failures`. Enki refuses this if the baseline passed.

A step that reports without having been briefed properly, or that finishes without reporting an outcome, counts as `error` and comes to you.

## 3. Hand-offs

An outcome the workflow doesn't wire anywhere comes to you, the orchestrator: QA's `blocked`, the coder's `blocked` and the tester's `unclear` in enki's own workflows, plus a loop that hit its limit, and `error` or `timeout` for any step. The step waits, and the rest of the workflow carries on.

1. Read the step's report.
2. Fix what you can yourself: start the server QA couldn't (`enki server start`), or correct the config. If it's about what the task should do, that's the user's: ask them.
3. Send it back to work: `enki resume <step> --note "<what you did>"`. The note goes into its next brief.
4. If it needs a decision only the user can make, ask them. If they decide the outcome (for example "accept QA as passed"), run `enki outcome <step> <outcome> --by user`. Never pass `--by user` without their words.

A loop that hit its limit can only go on through the user. A step handed to you more than its limit (2 by default) stops the task: tell the user what's open.

If an agent finds the plan is wrong, pause and tell the user. With their words, send it back to the planner: `enki outcome approval change-plan --by user --note "<their words>"`. If what's wrong is what was asked for, not how, it goes to the spec writer instead: `enki outcome approval change-spec --by user --note "<their words>"`. Either stops the work on the old plan once nothing is running, and what comes back needs the user's approval through plan mode, as in **enki:task**.

## 4. Finish

When `enki next` says the workflow has reached its end, load the **enki:report** skill.
