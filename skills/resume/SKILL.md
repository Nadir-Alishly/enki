---
description: Resumes an enki task after /clear, compaction or a new session, from its recorded phase.
argument-hint: "<slug>"
---

# Enki resume

Task: $ARGUMENTS

1. Run `enki resume <slug>`. It binds the task to this session and prints the phase, agents and next step.
2. Read the task's `request.md`, and `approved-plan.md` if the plan is approved, then the latest report files you need. Before approval, `enki next` says whether a step is ready or the plan waits for the user.
3. If an agent shows as not running, tell the user before going on. Its pane may have been closed.
4. If an agent is working, run `enki wait <step>` with `run_in_background: true`.
5. Continue from the recorded phase with the skill `enki resume` names. Don't redo finished phases.
