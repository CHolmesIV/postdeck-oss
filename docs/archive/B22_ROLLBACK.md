# B22 rollback guide

_Created 2026-08-12. Applies to the publishing workflow redesign._

## Restore point

The pre-redesign application state is Git commit `3da043c` (`B21: draft variations, honest char
counts, Post now`). B22 is implemented as one later local commit so the redesign can be reverted
without touching the SQLite database or social content.

## Preferred rollback

1. Stop the local PostDeck process.
2. From the `postdeck` repository, run `git log -3 --oneline` and identify the B22 commit.
3. Run `git revert <b22-commit>`.
4. Run `npm test`.
5. Start PostDeck normally and verify Calendar and Quick Compose.

`git revert` is preferred because it preserves the history of both the redesign and the rollback.
Do not use `git reset --hard`.

## Files in the B22 change set

- `public/app.js`
- `public/styles.css`
- `src/server.js`
- `src/usage.js`
- `test/manual-reconcile.test.js`
- `BUILD_STATUS.md`
- `CHANGELOG.md`
- `docs/archive/B22_PUBLISHING_FLOW_REDESIGN_SPEC.md`
- `docs/archive/B22_ROLLBACK.md`
- `docs/DESIGN-PASS.md`
- `docs/PRIMEWRIGHT_DESIGN_GUIDELINES.md`

## Data impact

B22 adds no database migration and changes no production records during installation. Rolling it
back does not require a database restore. A post marked as published manually is ordinary post
state and remains valid after rollback.
