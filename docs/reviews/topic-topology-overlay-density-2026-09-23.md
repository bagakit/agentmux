# Topic topology overlay and density review

- **Status:** approved
- **Observed problem:** `N tabs · M regions` repeats the Tab rail and mini Region preview, while the inline absolute inspector is clipped by the Topics scroll surface and adjacent rows. The mini map is too small to read as a mature workbench control.
- **Decision:** replace the mini map and total count with a horizontal strip of all Tab chips. Each chip carries a short label and compact Region count; the active Tab is explicit. Hover/focus on a chip opens a top-level portal inspector for that Tab, positioned against the preview within the viewport and flipped above/below when necessary.
- **Preserved facts:** `openTopicWorkSurfaces` remains the only source for Tab order, active state and Region bounds; the Topic row click action and shared background Agent presence remain unchanged.
- **Verification:** focused rendering tests assert all Tab chips, per-Tab Region counts and inspector content; a source contract asserts portal positioning and event wiring; typecheck, diff check and a live renderer update run after the change.
