# Review: fixed Leader Topic launcher, floating drag, and compact placement

Status: approved

The current launcher still exposes a Default Session name, reuses the
`launcher:default` topic, and can project the currently selected Scratch topic
when the main workbench is visible. This closure replaces that product model
with a fixed product-owned `leader:topic` Topic and calls the surface **Leader
Topic** everywhere users can see it.

The approved behavior is:

- Leader Topic is a fixed Topic identity, independent of the user's current
  Scratch Topic and hidden from the user-owned Scratch Topic list.
- The launcher has two durable placements: `floating` at a draggable position
  on the current work surface, or `compact` beside the bottom Agents / Session /
  Board switcher. Both placements open or focus the same Leader Topic surface.
- Collapsing changes the launcher placement and size; it never destroys the
  Topic, Session, Region, draft, or attention projection. Window resizing clamps
  the floating launcher back into the visible work area.
- The launcher uses a project-local low-poly avatar generated with the built-in
  image generation workflow. It has no text or vendor mark and remains legible
  at compact size.
- The existing three surface buttons remain exactly three buttons. Leader Topic
  is a separate adjacent control and does not become a fourth surface.

The implementation may reuse the existing floating frame, store persistence,
topic binding, and bottom surface-switcher seam. It must not add a second
Runtime, Session, PTY, Topic registry, or attention counter.

Evidence reviewed before approval:

- `docs/design/agentmux-desktop-interaction.md`
- `docs/design/agentmux-surface-density.md`
- `apps/desktop/src/renderer/src/components/DefaultSessionFloatingPanel.tsx`
- `apps/desktop/src/renderer/src/components/TopRowChrome.tsx`
- `apps/desktop/src/renderer/src/store.ts`
- `apps/desktop/src/shared/scratch-topics.ts`
