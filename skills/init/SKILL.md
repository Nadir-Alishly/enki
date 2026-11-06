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

   Enki starts the dev server itself with `devServer.start`, so work out the real command from the project's scripts and docs. It can be anything a shell runs, in any language. If it runs in the background or starts containers (`docker compose up -d`), also set `devServer.stop`. Set `testGlobs` to where this project's tests really live and how they're named, because the tester can write only those files. `enki verify` runs `test`, `lint` and gate commands, so they must work with no agent present and exit non-zero on failure. Set `"managedBy": "user"` only if the user wants to run it themselves. Use `"driver": "none"` for projects with no UI. Workers start with no skills, so if the user wants a role to have one, add it to `team.<role>.skills`: `enki skills --available` lists what's installed. Models, timeouts and `maxFixRounds` have defaults: leave them out unless the user wants a change. `"mode": "explicit"` keeps normal sessions normal until `/enki:task` is run.

5. Put project-specific test rules in `.enki/playbook.md`, under the matching heading.
6. Create `.enki/notes/<repo>.md` for each repo from `${CLAUDE_PLUGIN_ROOT}/templates/notes.md`.
7. Run `enki validate`, then `enki doctor`, and fix what they report.
8. Tell the user enki is ready, and that the next session here starts as orchestrator.
