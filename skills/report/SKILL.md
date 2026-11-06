---
description: Finishes an enki task by updating repo notes, writing the end-of-task report and rating the orchestration.
---

# Enki end-of-task report

## 1. Update notes

Run `enki phase notes`. Update `.enki/notes/<repo>.md` with what was learned from the scout's map and the agents' findings: architecture, key files, conventions, how to test the area, pitfalls, flaky tests, known failures.

Record how the system starts and is tested if this task taught you anything new, and correct `.enki/config.json` to match.

Keep entries short and factual. Fix or delete entries that turned out wrong. Don't log task history: git has that. Update `.enki/config.json` if anything about a repo changed.

## 2. Write the report

Run `enki phase reporting`. Fill in `${CLAUDE_PLUGIN_ROOT}/templates/report.md` and save it as `<task folder>/report.md`.

## 3. Rate the orchestration

Rate how you ran the task, not how good the code is. Back every score with concrete evidence, and don't inflate. A task that went smoothly but needed 3 fix rounds because of a vague brief is not a 9.

| Area | What it measures |
|---|---|
| Planning | Were the questions right? Did the plan hold? Did the user have to correct scope? |
| Delegation | Were briefs complete? Did any agent do rework, go off-scope or ask for what the brief should have had? |
| Coordination | Timeouts, blocked states, idle waiting, missed parallelism, browser or server hold-ups |
| Quality gate | Did testing and review catch the real problems before the user saw them? |
| Safety | Rule near-misses, policy denials and `agent.answered` entries in `events.jsonl`, needless prompts |
| Efficiency | Agent time and cost against the size of the task. Was the full team justified? |

In the report's Safety evidence, list every worker prompt you approved yourself, from the `agent.answered` events with `by: orchestrator`.

Under **Proposed workflow updates**, list concrete changes to `.enki/playbook.md`, `.enki/config.json` or how briefs are written, with the reason, or say "none needed". **Never apply them yourself.** The user approves which to make. Routine notes updates from step 1 aren't affected.

## 4. Close

Run `enki phase done`. It stops any server still running for this task. Give the user a condensed report in the terminal and end with: "Task saved to `<task folder>`. Run `/clear` before the next task."

Keep the task's herdr tab and agents open: the user closes them.
