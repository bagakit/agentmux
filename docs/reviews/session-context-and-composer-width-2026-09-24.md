# Session context continuity and composer width review

Status: approved from the user's cross-view navigation and Agent Input feedback on 2026-09-24.

Decision: the selected Session is a durable navigation context shared by Agents, Workspaces, and Board. Selecting or opening a Session records its identity; switching to Workspaces reveals that Session's existing Region/Tab without creating a duplicate, switching to Agents keeps its observation workspace selected, and switching to Board keeps the corresponding execution row/card selected and visible. A missing or retired Session must leave the current surface intact and report the existing recoverable state.

The Agent Input composer must give the editable message the largest available width in its one-line posture. Left tool controls and right session controls keep stable hit targets but must not reserve a wide fixed middle gap or squeeze the editor to a narrow centered column. The identity rail remains above the editor, while long drafts wrap naturally inside the available editor width.

Acceptance proof: store and surface tests cover context-preserving view switches and Board selection; source/style tests cover the grid contract that prioritizes the editor width and the absence of a fixed narrow column; mutation of either navigation or width contract makes the focused tests red; production callers remain connected.
