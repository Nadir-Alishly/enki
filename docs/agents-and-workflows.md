# Agents and workflows

An **agent** is what a workflow step runs. A **workflow** wires agents together into a team: which steps run, and where each step's outcome sends the work. Enki runs the workflow: the orchestrator briefs whatever is ready, and can't start a step out of turn.

## Agents

**An agent** is a folder with two files, made on the dashboard's Agents page or by hand:

- `AGENT.md`: its instructions, in skill format.
- `agent.json`: what enki enforces for it, and what it runs on unless a workflow says otherwise.

```json
{
  "id": "docs", "name": "Docs reviewer", "type": "reviewer",
  "capabilities": { "write": "none", "blind": false, "browser": false, "server": false },
  "outcomes": [
    { "id": "clear", "description": "The docs say what the change does" },
    { "id": "unclear", "description": "Something needs explaining: listed in the report" }
  ],
  "model": "claude-sonnet-5-5", "effort": "high", "skills": ["design:ux-copy"]
}
```

- **`write`:** `none` (its reports only), `tests` (test files only), `code` (anything but tests), `all`, or `map` (only the task's codebase map).
- **`blind`:** it never sees the work: the change, other steps' reports and the plan are hidden from it, as for enki's tester and QA.
- **`browser` and `server`:** a browser, and `enki server`.
- **`specs`:** it writes the spec (enki's spec writer), and nothing else.
- **`plans`:** it writes the plan (enki's planner), and nothing else.
- **`outcomes`:** its own. The agent reports one with `enki report <outcome>` before it replies. Enki adds `error`, for an agent that finished without reporting, and `timeout`.
- **`type`:** `scout`, `spec`, `planner`, `coder`, `tester`, `qa` or `reviewer`. It sets the agent's colour and pattern, such as the spec writer's cross-stripes, and the project's token chart counts by it. An agent without one gets a type from what it does.

Enki warns, without refusing, about risky combinations: a browser without the dev server, a blind agent that writes code.

**Agents live in your library** (`~/.enki/library/agents/`), for every project, next to enki's own, which are read-only. A project never has its own: it gives an agent another model, effort or skills on its workflow's steps. Nothing in the library can take an enki agent's id.

## Workflows

**A workflow** is a JSON file: its steps and the edges from each step's outcomes. Four built-in steps frame every workflow:

- **Start:** the orchestrator passes on your request. Its one output, `request`, goes to the first step.
- **Spec approval:** you approve the spec. Only a spec step leads into it. Its `approved` goes to the planning step, and `changes` goes back to the spec writer with your words.
- **Approval:** you approve the plan. Only a planning step leads into it. Its `approved` starts the work, `change-plan` goes back to the planner, and `change-spec` to the spec writer, after which you approve the spec, then the plan, again.
- **End:** the task is done, and the orchestrator updates each repo's map (or notes) and writes the report.

```json
{ "from": "reviewer", "on": "changes", "to": "coder", "max": 3 }
```

- **Before and after the plan:** the steps before Approval are read-only, a spec step before Spec approval and a planning step after it. A planning step may send the work back to a spec step, and nowhere else before Spec approval. The steps after Approval do the work.
- **Workflows from before specs:** enki adds the spec writer and Spec approval before the planning step when it loads one, and says so. Save it in the studio to keep them. A task keeps the workflow it started with.
- **Targets:** an edge goes to one or more steps (in parallel), or to End.
- **Hand-offs:** an outcome with no edge goes back to the orchestrator, like QA's `blocked`, so you only wire what moves the work on. The step waits while the rest carries on. The orchestrator fixes what it can and resumes the step (`enki resume <step> --note "..."`), or asks you, and passes on your decision with `enki outcome <step> <outcome> --by user`. A step handed off more than twice stops the task.
- **Models and skills:** a step can set its own `model` and `effort`, which win over its agent's, and add `skills` to its agent's own. This is how a project tunes its agents, through its own workflow.
- **Positions:** `layout` keeps where each step sits in the dashboard's studio, and `routes` where each line runs. Enki ignores both when running.
- **Loops:** every loop needs a `max`. Past it, only you decide.
- **Waiting:** a step starts only once every step that sends it work has done so, counting a loop's line (one with a `max`) as enough on its own. It also waits while any step before it is still working, so findings arrive together and nothing runs on code that's about to change.
- **Built-in steps:** `verify` (Tests in the dashboard) runs the project's test, lint and gate commands itself, with no agent and no tokens, and reports `pass` or `fail` from their exit codes.

**What agents know about a workflow** comes from its graph alone. The planner's brief carries a summary enki writes from it: each step, what its agent may do, where each outcome goes, and what no step does (write tests, use a browser, review the work, fix failing tests). A plan that counts on work no step may do goes back to the planner before you see it: with no step that writes tests, it has to say `Tests: none`. The `description` is only for people choosing a workflow: agents never see it, and the task's own copy of the workflow leaves it out. A duplicate starts without one.

### What enki refuses

Enki refuses a workflow that can't run, whether in the CLI, the dashboard or an import. That covers:
- no Start, Spec approval, Approval or End, Spec approval reached by something other than a spec step, Approval by something other than a planning step, or Approval before Spec approval;
- a step before the plan that can write;
- a test run whose `pass` leads nowhere;
- a step that can't be reached, or can't reach End;
- a loop without a limit;
- more than 8 agent steps;
- code that could reach the end without a check by `verify` or a read-only agent.

It warns, without refusing, about a test run whose `fail` goes nowhere (failing tests then stop the run until you decide), and a description that names agents the workflow doesn't have.

### Where workflows live, and choosing one

Workflows come from three places, later ones winning:
- **Enki's own:** read-only.
- **Your library:** `~/.enki/library/workflows/`, for every project.
- **The project:** `.enki/workflows/`.

**Choosing:** the project's default is `"workflow"` in its config, `enki task new <name> --workflow <id>` picks another, and the planner can switch with `Workflow: <id>` in its plan: the work so far stays, and what follows Approval comes from the new workflow. `Skip: <step>` drops steps, as `Tests: none` and `QA: none` do. Each task keeps a copy of its workflow and agents, so editing the library never changes a running task.

```
enki workflow list                      enki workflow show <id>
enki workflow use <id>                  enki workflow copy <id> <new-id> [--to library|project]
enki workflow export <id> --out x.json  enki workflow import x.json --by user
enki agent list                         enki agent show <id>
enki agent copy <id> <new-id>           enki agent export <id> --out x.json
enki agent import x.json --by user
```

### Export and import

- **A workflow's export** is one JSON file: the workflow, plus every agent it uses that isn't enki's own, with its instructions.
- **An agent's export** is the agent alone, with its instructions.
- **An import** shows each new agent's permissions and saves only with your approval. Agents always go to your library. It never overwrites anything, and never replaces enki's own agents.

The dashboard's **Workflows** page does the same, and opens each workflow in the studio.

## Worker skills

Workers start with no skills, so they aren't distracted by, or paying context for, ones they don't need. Each loads only the skills its agent lists (on the Agents page, or `skills` in its `agent.json`), plus any its workflow's step adds for this project (in the studio's inspector, or `skills` on the step).

`enki skills` shows what each step of the project's workflow loads, and `enki skills --available` lists what's installed.

- Use the skill's name, with the plugin prefix for plugin skills. Bundled Claude Code skills have no file to load, so they can't be listed.
- A name enki can't find stops `enki task new`, before any tab opens.
- Each listed skill's full text goes into that worker's instructions, so it costs context on every turn. Keep lists short.
- Skills load when a worker starts. A worker that's already running keeps what it had.
- Inline shell commands in a skill (`` !`command` ``) don't run. `enki skills` warns about them.
- The orchestrator keeps its normal skills, because it runs on them.
