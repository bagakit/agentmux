# Scratch Topic workbench visibility review

- **Status:** approved
- **Scope:** Scratch Topic click → active workspace → window-owned Workbench registry.
- **Observed failure:** `openScratchTopic` creates or focuses the Topic Tab and sets `activeWorkspaceId` to `__scratch__`, but `App.tsx` filters `__scratch__` out of `mountedWorkspaces`. The right side therefore has no `WorkspaceWorkbench` slot and remains an empty surface.
- **Required behavior:** Scratch must stay in the same registry as ordinary workspaces when it is active or has persisted tabs. Its Files + Topics dock remains separate from the right Workbench; both surfaces must render from the same workspace identity.
- **Boundaries:** Do not alter Session lifecycle, Topic metadata, PMO Teams floating behavior, or ordinary workspace parking semantics.
- **Verification plan:** focused App registry contract test, focused Topic navigation tests, desktop typecheck, `git diff --check`, and mutation proof by restoring the `candidate.id !== '__scratch__'` filter and confirming the focused test fails.
