---
description: Runs an approved enki task through baseline, coding, testing, review and the fix loop. Use after plan approval.
---

# Enki task execution

The approved plan is in `<task folder>/approved-plan.md`. Write each brief to `<task folder>/briefs/`, and run every `enki ask` with `run_in_background: true`.

Coder and reviewer briefs give the goal, acceptance criteria, affected repos and files, relevant notes, and the plan and scout report paths. Tester and QA briefs point to `requirements.md` and describe behaviour only: never paste code, diffs or coder reports into them. Enki adds the rules, the report path and the reply format.

## 1. Baseline

1. Run `enki team start`. If it says Playwright or a browser is missing, ask the user before running the `enki playwright install` command it names, because it downloads software. If it says nobody has recorded the start command, work it out from the scout report, correct `.enki/config.json` and the notes, then run it again. If it exits 3, a folder trust prompt is waiting: ask the user whether to trust the folder, and if they agree, run `enki answer <role> trust`, then `enki start <role>`.
2. Run `git status` in the affected repos. Dirty files are the user's own: leave them alone.
3. Run `enki phase baseline`, then `enki verify --baseline`. If it fails, have the tester sort stable pre-existing failures from flaky ones, and add them to the repo notes. A brand-new repo has nothing to run.

## 2. Tests and code, in parallel

Run `enki phase coding`. Then, in the same message, start both:

- `enki ask tester <brief> --report tests.md --step tests`, unless the plan says `Tests: none`
- `enki ask coder <brief>`, with the scout report path. For visual work, say the coder must read QA's screenshots before each tuning round

If the tester says the requirements don't say enough, fix `requirements.md`, tell the coder if the interface changed, and tell the user if it changes what was approved.

## 3. QA and verify, in parallel

As soon as the coder reports, run `enki phase testing`. Then, in the same message:

- `enki ask qa <brief>`, unless the plan says `QA: none`. Give an explicit list of what to check, including what a fix must not disturb. QA starts the server itself with `enki server`. If it can't, the output is in its reply: correct `.enki/config.json` and the notes, then ask again. A server marked `managedBy: "user"` needs the user.
- `enki verify`, once the tester has reported too. It refuses while the coder or tester is working.

Results of `enki verify`:

- **Passed:** start the reviewer right away, while QA carries on.
- **Failed:** go to the fix loop with the failing output. If the coder says a test is wrong, send the failure to the tester, who decides from the requirements.
- **Failing since the baseline:** have the tester confirm no failure is new, then run `enki verify --known-failures`. Enki refuses this if the baseline passed.

## 4. Review

Run `enki phase review`, then `enki ask reviewer <brief>`, with the plan, coder report and gate output paths. The reviewer always runs, however small the change. Enki refuses it until tests pass for this round, and refuses to finish the task without its report.

## 5. Fix loop

Wait for everything running to report, then combine the findings from verify, QA and the reviewer:

1. Run `enki round next`, then `enki phase fixing`. If `round next` refuses, stop: report the open issues to the user.
2. In the same message, start both: the coder, with consolidated findings, and for a bug tests missed, the tester, to add a regression test from a description of the behaviour.
3. Describe each failure scenario and its constraint, and let the coder choose the fix. Prescribe a fix only if the reviewer proposed it, and ask the coder to consider adversarial cases.
4. Go back to step 3.

If an agent finds the plan is wrong, pause, tell the user, and run `enki phase planning`. That withdraws the approval, so present the new plan through plan mode.

## 6. Finish

When tests, QA and the reviewer all pass for the same round, load the **enki:report** skill.
