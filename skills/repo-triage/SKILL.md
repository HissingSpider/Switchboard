---
name: repo-triage
description: Work out what state a repository is actually in before changing it — build status, failing tests, uncommitted work, stale branches left by earlier runs. Use before any task in a repo you have not touched this session, and whenever a run failed for reasons that look environmental rather than logical.
triggers: [triage, what state is, before i start, why is the build broken, stale branches]
---

# repo-triage

## When to use this

Before the first write in an unfamiliar repo, and after any failure that smells
like the environment rather than the change. Five minutes here beats an hour of
debugging a problem that was already there when you arrived.

## Steps

1. `git status --porcelain` and `git branch --list 'switchboard/*'` — is the
   tree dirty, and did an earlier run leave a branch parked?
2. Read the package manifest and find the real test and build commands. Do not
   guess `npm test` if the repo uses something else.
3. Run the build. Run the tests. Record whether they were *already* failing —
   this is the single most useful fact for everything that follows.
4. Check DeerDawn for known landmines in this repo before reading source.

## Output

Four lines, no more:

```
clean tree, on main.
build: ok. tests: 3 failing before I touched anything (auth.test.ts).
2 stale switchboard/* branches from 6 Aug.
Safe to start; the auth failures are pre-existing and out of scope.
```

## Rules

- Never fix a pre-existing failure as a side effect of another task. Report it.
- A dirty tree you did not create is a stop-and-ask, not a `git stash`.
- Stale `switchboard/*` branches are evidence, not garbage — do not delete them.
