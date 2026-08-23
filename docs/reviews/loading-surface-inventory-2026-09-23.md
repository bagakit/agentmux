# Review: loading surface inventory

## Decision

Use `FullPageLoadingSurface` for every app or Region phase that temporarily replaces primary content: startup, workspace recovery, Session connection, fixed Topic preparation, terminal replay/hydration, and first-load Browser/file/diff surfaces. Preserve last known facts for local refreshes and use an inline busy affordance there.

## Acceptance evidence

- Source scan enumerates every primary-content loading branch and has a non-empty result.
- Contract tests prove each full-page branch references the shared component.
- A block mutation of one caller turns the contract test red.
