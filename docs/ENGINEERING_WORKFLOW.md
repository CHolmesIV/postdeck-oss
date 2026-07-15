# PostDeck Engineering Workflow

This is the standing delivery rule for PostDeck work, whether the change is done
by Codex, Claude, or a human.

## Default sequence

Every meaningful change should follow this order:

1. Spec
2. Plan
3. Build
4. Document
5. Commit
6. Deploy
7. Confirm

If there is a conflict between chat context and the repo, GitHub plus the repo's
current spec/docs are the source of truth unless CB explicitly says otherwise.

## What each step means

### 1. Spec

Before building, check the relevant source-of-truth docs first:

- `SPEC.md`
- `BUILD_STATUS.md`
- `README.md`
- `CHANGELOG.md`
- any relevant file under `docs/`

If the requested change materially alters behavior, update the spec before or as
part of the build. Do not treat chat-only intent as sufficient long-term
documentation for product behavior.

### 2. Plan

Write or restate the implementation approach before deep changes when the work
is non-trivial. The plan should answer:

- what user problem is changing
- which files or subsystems are affected
- what should remain unchanged
- how the change will be verified

### 3. Build

Implement the smallest complete slice that satisfies the spec and plan.

- prefer additive, reviewable changes
- preserve existing safety rails
- keep the "human approve before live publish" rule intact unless CB explicitly overrides it
- verify with tests and live checks when appropriate

### 4. Document

After the build:

- update `README.md` for operator-facing behavior or setup changes
- update `SPEC.md` for product/architecture changes
- update `BUILD_STATUS.md` when milestone state changes
- update `CHANGELOG.md` for shipped work

If none of those documents need changes, that should be a conscious decision,
not an omission.

### 5. Commit

Once the work is implemented and documented, capture it intentionally in git.

- review the diff before committing
- keep commits scoped and readable
- do not mix unrelated changes just because they are present in the tree
- if another agent is working in parallel, avoid bundling their work into the same commit unless CB explicitly wants that

### 6. Deploy

If the feature has a runtime, release, background service, site, or app-facing
delivery step, perform the appropriate deployment step instead of stopping at a
local code change.

Examples:

- install or reload `launchd` when service behavior changes
- deploy the site when a Sites-backed deliverable changes
- push the relevant branch when GitHub state is part of the workflow

### 7. Confirm

Do not assume deployment worked.

Confirm the result with the right verification for the surface:

- app/server health checks
- tests
- production URL or localhost checks
- worker/service status
- post submission or publish-state checks when relevant

## GitHub and repo truth

GitHub is usually a source of truth for branch state, recent decisions, and what
is already underway. Before starting meaningful work:

- check current branch and repo status
- check whether there are in-flight local changes
- avoid assuming the working tree is yours alone

If Claude or another agent is actively building in the same repo, inspect the
tree first and work around existing changes rather than overwriting them.

## Parallel worktree rule

Do not have multiple agents making unrelated changes in the same working tree if
it can be avoided.

Preferred order of operations:

1. separate branch or separate git worktree per agent/task
2. if same repo must be shared, claim a scoped area of files
3. inspect `git status` before editing
4. never revert or overwrite another agent's in-flight work without explicit approval

If the tree is already shared and dirty:

- stop and inspect before editing
- avoid broad refactors
- prefer isolated files
- document assumptions in the handoff

## Hard rule for PostDeck AI features

AI can help draft, structure, schedule, request images, and operate the app up
to the final decision point.

AI does not make the final publish decision by default.

Human approval remains the gate before anything goes live, unless CB explicitly
changes that rule.
