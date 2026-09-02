# Home attention dismiss rollback

The Home attention dismiss change is isolated in the local commit named
`B22.1: make Home attention dismissible`.

## What the change touches

- `public/app.js`
- `public/styles.css`
- `BUILD_STATUS.md`
- `CHANGELOG.md`
- `docs/DESIGN-PASS.md`
- `docs/FIX_WAVE_NOTIF_IMAGES_SPEC.md`
- `docs/archive/ATTENTION_DISMISS_ROLLBACK.md`

It adds no database migration and changes no production post records. Dismissal state lives only
in browser `localStorage` under `pd_attention_dismissed`.

## Revert procedure

1. Stop PostDeck if it is running.
2. In the `postdeck` repository, identify the commit with `git log -3 --oneline`.
3. Create a normal revert commit with `git revert <commit-hash>`.
4. Restart PostDeck and confirm the Home attention rows render as links without close controls.

Previously stored browser dismissal keys are harmless after rollback because the old code does not
read them. They can be left in place so a later reinstallation preserves the operator's choices.
