# Review: compact Agent input identity and non-empty Scratch workbench

## Decision

Keep Terminal/Activity in the Agent composer tool row as one compact toggle. Put the user-facing Agent name and compact Session/Executor metadata in the `AGENT INPUT` rail. Make every Scratch Topic navigation path reveal a real visible work surface, with a loading or failure surface and retry when Terminal preparation cannot complete.

## Acceptance evidence

- The composer source and CSS contain one view toggle with target-oriented accessible copy; the segmented two-button control is gone.
- SessionPane renders the user-assigned Agent name plus compact Session and Executor metadata in the input rail, with a full accessible label/title.
- Scratch Topic navigation has a production caller, preserves the selected Topic and layout on launch failure, and renders a visible loading/error surface instead of an empty right side.
- Focused tests prove the source contracts and a mutation removing the fallback/loading branch makes the tests fail; zero-caller scans find the new helpers in production callers.
