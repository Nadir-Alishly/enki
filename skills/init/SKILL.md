---
description: Sets up enki in the current project by creating .enki/ and filling in repos, test commands and dev server facts.
disable-model-invocation: true
---

# Enki init

1. Run `enki init` at the project root. It creates `.enki/` with a config, a playbook and folders.
2. Look at the project: its repos, stack, test and lint commands, dev server and local URL. Read only what you need. A repo can be `.` if the project is one repo.
3. Ask the user, with `AskUserQuestion`, only what you can't determine: which folders are repos, the local URL, whether there's a UI to test in a browser, and what must never be touched in tests.
4. Fill in `.enki/config.json`:

```json
{
  "repos": [
    {
      "path": "web",
      "test": ["npm test"],
      "lint": ["npm run lint"],
      "url": "http://localhost:4321",
      "testGlobs": ["tests/**"],
      "devServer": { "start": "npm run dev", "reload": "hot reload", "restartFor": [".env", "config changes"] }
    }
  ],
  "browser": { "driver": "chrome" },
  "policy": { "secrets": [], "protected": [], "bash": [] }
}
```

   Enki starts the dev server itself with `devServer.start`, so work out the real command from the project's scripts and docs. It can be anything a shell runs, in any language. If it runs in the background or starts containers (`docker compose up -d`), also set `devServer.stop`. Set `testGlobs` to where this project's tests really live and how they're named, because the tester can write only those files. `enki verify` runs `test`, `lint` and gate commands, so they must work with no agent present and exit non-zero on failure. Set `"managedBy": "user"` only if the user wants to run it themselves. QA tests in a headless Playwright browser by default (`"driver": "playwright"`). Use `"driver": "none"` for projects with no UI, and `"chrome"` only if the user wants Claude in Chrome. Run `enki playwright status`: if it isn't installed, ask the user before running `enki playwright install`, which downloads it. Workers start with no skills, so if the user wants a role to have one, add it to `team.<role>.skills`: `enki skills --available` lists what's installed. Models, timeouts and `maxFixRounds` have defaults: leave them out unless the user wants a change. `"mode": "explicit"` keeps normal sessions normal until `/enki:task` is run.

5. Tasks run in their own git worktrees, so check what a fresh checkout lacks: gitignored files the app needs, such as `.env*` (set `worktree.copy`), and dependency folders such as `node_modules` (set `worktree.link`, plus `worktree.install` for tasks that change dependencies). The start command must take a port: use `{port}` in `devServer.start`, such as `npm run dev -- --port {port} --strictPort`, and enki also sets `PORT`. If the app reads other settings that differ per task, map them in `worktree.env`. If it uses a database, add `database` with `copy`, `drop` and `env` commands, using `{task}` for the per-task name. If the project isn't in git, set `"worktrees": false`.
6. Put project-specific test rules in `.enki/playbook.md`, under the matching heading.
7. Ask the user, with `AskUserQuestion`: **"Do others work in any of these repos without enki?"**
   - **No:** run `enki migrate --memory repo`. Each repo gets `.enki/notes.md`, `repo.json` and `playbook.md`, committed with the code, so its memory follows merges exactly. Tell the user to review and commit them.
   - **Yes:** run `enki migrate --memory private`. Memory goes in a local git repo per repo, in `.enki/memory/`, hidden from their team's git. Tell them it's local only, that sync can miss a squash mixed with other commits (`enki memory merge <slug>` fixes that), and that reverting code doesn't revert memory.
8. Run `enki validate`, then `enki doctor`, and fix what they report.
9. Tell the user enki is ready, and that the next session here starts as orchestrator.
