# Review: move Agent view switch into Message Tool

## Decision

Move the per-Agent Terminal/Activity switch out of the Pane top bar into `AgentComposerTools`. The top bar remains workspace, tab, lifecycle and split chrome; the composer tool row owns Agent-internal interaction modes.

## Acceptance evidence

- Source contract finds no per-Agent view toggle in the pane header.
- Composer tool tests prove terminal/activity buttons retain the same store action and accessible names.
- A mutation removing the view control makes the targeted test fail.
