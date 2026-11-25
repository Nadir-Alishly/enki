# Memory

Enki keeps what it learns about each repo in its memory: a codebase map in `map/`, `repo.json` (its test, lint and dev-server commands) and `playbook.md` (team rules). It all changes on a task's branch, so it reaches your base branch only when you merge the code. A task you never merge never leaves wrong knowledge behind.

## The codebase map

The map is a pyramid of short Markdown files, browsable on GitHub as well as by agents:

```
map/
  README.md        the root: what the repo is, stack, how it runs and is tested, conventions, its areas
  shop/
    README.md      an area with children: what it is, and a line for each child
    cart.md
  game.md          an area without children
```

- **Areas follow what the code does**, not how its folders are laid out.
- **Every file** has a `Files:` line, `## How it works` and `## Gotchas`.
- **A parent's `## Areas` list** gives each child a link and one line. That line is the only description of the child, so child files carry no front matter.
- **Sizes:** the root stays under 3 KB, and other files under 4 KB.
- **Contracts between repos**, such as an API, are described once, in the repo that owns them. Other repos link to them as `repo:path`, for example `melda-server:api/livekit.md`.

**What workers see.** Every worker reads each task repo's root in full in `rules.md`, and briefs name the area files to read. Blind steps read the map too: it describes the code as it is, not the change being made.

**Keeping it current.** At the end of each task, the orchestrator updates the areas the task touched. `enki memory check` runs as the task leaves its notes step:
- it stops the task on a link that goes nowhere, a folder without a `README.md`, or a file its parent doesn't list;
- it warns about sizes, `Files:` paths that no longer exist, and `repo:path` links it can't find.

**The first map** comes from a task on the `map` workflow. Ask the orchestrator to create a codebase map, naming the repos or none for all of them, and it starts one, for example `enki task new map-web --workflow map --repo web`:
1. The scout surveys the code and the old notes.
2. You approve a spec of what to map.
3. You approve the planner's outline: every file, its line and its paths.
4. The **mapper** writes it, one top-level area per visit. It writes only the task's `map/` and lists what it dropped from the old notes.

**Several repos** fit in one task: repeat `--repo`, or leave it out to map them all. The planner starts with the repo that owns what the others share, such as an API, so the others can link to its files. The mapper can come back at most 40 times, so check that the outline has no more than 40 mapper steps.

At `enki phase done`, enki removes the old `notes.md`, which reaches your branch with the merge. In private mode, a task branch from before the map may still have changed those notes when its code is merged. Enki then keeps them deleted and puts what the branch changed in `unmapped/<task>.md` in the memory, and the next task on that repo folds it into the map. A repo without a map keeps using `notes.md` until then. `enki migrate` starts a repo without old notes on an empty root, and `enki doctor` and `enki status` point out repos with no map.

## Where memory lives

Pick one mode per project. `/enki:init` asks, or run `enki migrate`:

| | `repo` (default) | `private` |
|---|---|---|
| Where | `<repo>/.enki/`, committed with the code | `.enki/memory/<repo>/`, a local git repo, never pushed |
| For | Your own repos, or teams that all use enki | Team repos where others don't use enki |
| Follows merges | Exactly: git does it, including squashes, cherry-picks and reverts | By detection at each `enki task new` or `enki memory sync`: merges, fast-forwards, rebases, and squashes of enki's single commit |
| Misses | Nothing | A squash mixed with other commits, and cherry-picks: run `enki memory merge <slug>`. Reverting code doesn't revert memory |
| Backup | Pushed with the code | Only on this clone, unless you push the memory repo somewhere private |

In private mode, `.enki/` is hidden from the team through your clone's `.git/info/exclude`, never a committed `.gitignore`. Memory branches mirror your code branches, and a memory conflict stops `enki memory sync` with a path to resolve it in.

With several repos, each has its own memory, and each follows its own merges.

During a task, only the orchestrator writes memory, and only its own task's copy. Workers can't write memory, apart from the mapper, which writes only the task's `map/`. `enki migrate` warns if your old shared notes may contain knowledge from task branches you haven't merged.
