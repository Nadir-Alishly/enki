# Parallel tasks

Every task gets its own git worktree, branch, port and, if the plan says so, database, so several tasks can run in the same repo at once.

- **Starting:** you name each task, and the name is its branch: `dark-mode`, or with folders, like `feature/dark-mode`. `enki task new feature/dark-mode` creates the branch `feature/dark-mode` from the project's working branch, `baseBranch` (`dev` unless you change it in Settings), whatever your main tree has checked out, and a worktree under `.enki/worktrees/`. It refuses if the working branch is missing, is behind its upstream as of your last fetch (enki never fetches), or has uncommitted changes while your main tree is on it.
- **Continuing a task:** when reviewers want changes to a task's pull request, `enki task new dark-mode-review --on dark-mode` works on the branch `dark-mode` itself, in a fresh worktree, and commits on top of it. Push it to update the PR. `--on` takes a finished task's name or any local branch. The new task has its own folder, port and report, and its briefs point to the earlier task's spec, plan and report. The branch must not be checked out anywhere else. A continued branch is never deleted, even if nothing changed, and `--abandon` puts the WIP on a branch named after the new task, leaving the PR alone.
- **What git doesn't carry:** enki copies the gitignored files in `worktree.copy`, such as `.env*`, and links the folders in `worktree.link`, such as `node_modules`. If the approved plan has `Scope: deps`, the task gets its own install with `worktree.install`.
- **Ports:** each task's server gets a free port from `ports`, through `{port}` in `devServer.start` and the `PORT` variable. A machine-wide registry stops two tasks picking the same one.
- **Per-task settings:** `worktree.env` sets values in the copied env files and the task's processes. It can use `{port}`, `{port:<repo>}` and `{task}`. A repo the task doesn't include, or whose server enki doesn't manage, gives the port in its own `url`: its main server.
- **Databases:** with a `database` section, each plan says `Database: copy`, `shared` or `none`. `copy` runs your `copy` command at team start and `drop` at the end. `none` blanks the database env values, so nothing reaches the real database by accident. A plan without the line gets `database.default`, `copy` unless you set it. `"enabled": false` turns copying off but keeps the commands: plans then use the shared database, or none.
- **Finishing:** enki removes its copies and links, commits everything else to the task's branch under your git identity, with your git hooks, and removes the worktree. The output gives the branch and `git diff <base>...<branch>` to review it, or for a continued task, the diff of its own commits. If a hook refuses the commit, the task stays open. An empty task's branch is deleted, and `--abandon` commits the work as WIP.

```json
{
  "baseBranch": "dev",
  "repos": [{ "path": "web", "url": "http://localhost:5173", "devServer": { "start": "npm run dev -- --port {port} --strictPort" } }],
  "worktree": { "copy": [".env", ".env.*"], "link": ["node_modules"], "install": "npm ci", "env": {} },
  "ports": { "from": 4400, "to": 4999 },
  "database": { "copy": "createdb -T app app_{task}", "drop": "dropdb --if-exists app_{task}", "env": { "DATABASE_URL": "postgres://localhost/app_{task}" } }
}
```

Set `"worktrees": false` for a project that isn't in git. Tasks then share one tree, and enki allows one open task per repo.
