# AgentMux Workspace navigation and path recovery polish

Status: approved for implementation.

This small feature closes three related Project Rail gaps without creating a second
workspace registry:

1. A Project row can be removed from the left rail. Removing a view unregisters
   its Workspace records from the navigation/configuration, but never deletes the
   project directory, files, layout data, Session, or Agent process. Scratch (the
   always-present workspace) cannot be removed.
2. When a local folder was moved and Explorer cannot read the saved path, the
   error surface offers a native folder picker. Rebinding updates the existing
   Workspace record in place, preserving its id and all Session/workbench
   identity; cancel and picker failure leave the old record untouched.
3. A grouped Project Rail gives every member one light indentation level. True
   nested Projects add their path-derived depth on top. The group header remains a
   low-emphasis label and no hierarchy is persisted.

## Proof boundary

- The sidebar test proves the context-menu removal action, Scratch protection,
  config persistence, and fallback selection.
- The File Explorer test proves the recovery action calls the rebind API, updates
  the same Workspace id, and refreshes the root.
- The Project Rail test proves grouped top-level and nested rows receive the
  additional visual depth while ungrouped rows remain at depth zero.
- A wiring test proves the rebind verb exists across contracts, preload, main IPC,
  and the browser preview API. CSS assertions prove the indentation remains a
  token-backed padding rule rather than a border/height change.

The implementation is renderer-owned for presentation and main-owned for the
native folder picker/config transaction. No Runtime, ctxmux, Session, or Agent
lifecycle is duplicated.
