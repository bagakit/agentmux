# Topic topology Tab thumbnail review

- **Status:** approved
- **Observed problem:** the collapsed Tab strip spends its narrow rail on implementation labels such as `T4 1R`, while the hover inspector is wide enough to dominate the Topic list. The labels do not help users read the real workbench shape.
- **Decision:** use a reusable visual Tab thumbnail. A single Region fills one square; multiple Regions render their actual normalized bounds as a compact grid. Remove `Tn` and `nR` from the collapsed chip; keep the full title, count, Region facts and activity in the existing hover/focus inspector. Reduce inspector width to a content-sized narrow surface and preserve viewport portal positioning.
- **Preserved facts:** `openTopicWorkSurfaces` remains the source for Tab order, active state, Region bounds, Executor and activity; Topic row navigation and shared Agent presence remain unchanged.
- **Verification:** focused component tests assert the thumbnail cells and absence of collapsed implementation labels; a mutation removes the thumbnail contract and must fail; typecheck, diff check and caller grep verify the reusable component is connected from the Topic surface.
