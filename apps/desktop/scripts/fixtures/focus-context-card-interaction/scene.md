# Focus card interaction capture

Run `node apps/desktop/scripts/capture-focus-context-card-interaction.mjs`.
Optional `--evidence <directory>` chooses the local evidence directory. The default
is `.bagakit/feature-tracker/focus-identity-consistency-artifacts/cards/scene-*`.

The private Chromium scene consumes the actual GlobalFocusSurface, Store,
FocusContextRow/Menu/Hover, projection, clipboard owner and CSS, with maintained
typed recap preview data. Unrelated PTY and editor paint are isolated. It has no
user Runtime, real Run/PID, OS input, restart or installation qualification.

At 1200, 640 and 360 px it exercises long-name card density, delayed hover,
natural pointer transfer, text selection and internal reading scroll; the second
same-name SID's pointer and Shift+F10 menus; Escape; real Rename Agent draft,
cancel, commit, clearing to derived name and blur to a later input. Opening a
menu does not select. The two actions are Rename Agent and Copy Session Address; the address already
carries message command examples. The Agent name stays a single ellipsized line
with its full title, without repeating status or SID. Ordinary card click and
Enter/Space navigation are exercised last, after measuring presentation-only read costs.

Each full PNG waits for visible text, stable opacity and two animation frames.
The receipt binds nonempty loaded owners, CSS and compiled bytes, records exact
Session/Run/control and draft owner preservation, API read counters and private
process cleanup. Capture success awaits independent full-image review under
[the visual review guide](../../../../../docs/guides/agent-visual-e2e-review.md)
and [Focus presentation](../../../../../docs/design/presentation/focus-context.md).
