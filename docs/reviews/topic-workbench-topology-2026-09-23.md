# Topic Workbench topology review

- **Status:** approved
- **Observed problem:** the Topic row currently places a Region mosaic, a `Tabs` count and a background Agent avatar cluster beside one another. The screenshot reads as unlabeled icons and does not expose the hierarchy.
- **Decision:** replace the collapsed mosaic/count combination with one mini workbench preview: a labeled Tab rail plus the active Tab's real Region geometry and short Executor labels. `N tabs · M regions` remains supporting text. Hover/focus opens one bounded inspector that groups every Tab's real Region geometry under its Tab and labels each Region with Executor, surface kind and recent activity.
- **Preserved facts:** `openTopicWorkSurfaces` remains the only source for Tab order, active state and Region bounds; background Agents still use shared `SelectorPresence`; no new store state or duplicate Session registry.
- **Verification:** focused rendering tests assert the explicit counts, Tab grouping, Region labels and activity; source contract keeps the reusable component connected from `WorkspaceTopicsPanel`; typecheck and diff check run after the change.
