# Review: visible Default Session launcher and top-level Session tabs

Status: approved

The current implementation mounts the Default Session floating panel but has no
stable floating trigger, so the entry disappears on a split Session surface.
The split workbench also reserves a separate `workbench-chromeline` above the
Pane tab bars. That row has no tabs and leaves the Session surface with an
empty top band.

This closure is approved for implementation in the current tree:

- Keep one visible, keyboard-focusable floating launcher at the edge of the
  current work surface. It opens or focuses the existing `launcher:default`
  floating Topic and uses the existing hidden-to-Board recovery behavior.
- Make the top-level Session tab strip own the first row in both single-pane
  and split layouts. The primary (upper-left) Pane may carry the one required
  window chrome; secondary Panes must not recreate it. Remove the empty split
  chrome row and its reserved height.
- Keep the bottom Agents / Session / Board switch as the sole global surface
  switch. Do not add another top-right navigation control.

Evidence reviewed before approval:

- `docs/design/agentmux-desktop-interaction.md`
- `docs/design/agentmux-surface-density.md`
- `apps/desktop/src/renderer/src/components/DefaultSessionFloatingPanel.tsx`
- `apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx`

The implementation is bounded to renderer surface ownership and CSS. It does
not add a second Runtime, Session, PTY, or attention counter.
