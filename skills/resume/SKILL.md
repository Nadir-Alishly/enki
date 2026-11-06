---
description: Resumes an enki task after /clear, compaction or a new session, from its recorded phase.
argument-hint: "<slug>"
---

# Enki resume

Task: $ARGUMENTS

1. Run `enki resume <slug>`. It binds the task to this session and prints the phase, agents and next step.
2. Read the task's `plan.md`, or `approved-plan.md` if the plan is approved, and the latest report files you need.
3. If an agent shows as not running, tell the user before going on. Its pane may have been closed.
4. If an agent is working, run `enki wait <role>` with `run_in_background: true`.
5. Continue from the recorded phase with the skill `enki resume` names. Don't redo finished phases.
