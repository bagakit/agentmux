# Project Rail pinned child styling and density review

## Scope

This review turns the current request into two durable Project Rail constraints:

1. Pinned Topic/Branch rows remain clickable child navigation, use a smaller title, underline-only hover, and a quiet dashed relation line to their owning Project.
2. The rail keeps one depth formula while offering three durable density tiers. The default depth step is tightened, and the new densest tier tightens the indent, icon, and row height together.

## Design decisions

- The existing `project-rail-row--pinned-child` class remains the semantic hook; no second tree or pin data model is introduced.
- The connector is decorative structure only. It does not use attention colors, selection fill, or animation, and it does not change navigation or focus order.
- Density remains a single persisted `projectRailDensity` union. The heading control cycles `default → compact → dense → default`; all three dials are redefined per tier.
- Existing tree depth, pin scope, collapse behavior, and durable config shape remain unchanged apart from accepting the new finite density id.

## Review result

**Approved for implementation.** The constraints are recorded in both design SSOT files before code changes. The implementation must add falsifiable DOM/CSS tests, mutate the pinned visual rule and density consumer to prove those tests turn red, and run a production-caller search for the new density id/control.
