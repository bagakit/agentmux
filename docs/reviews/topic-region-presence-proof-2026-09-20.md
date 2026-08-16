# Topic Region presence proof

Candidate: isolated `da29f060` descendant; feature `f-27t8fe2kg/T-001`.

- Desktop typecheck passes.
- 72 targeted tests pass: Topic component behavior, Region mapping, focus visibility, density scale, presence input contract and nonempty source scans.
- Five controlled mutants fail: 2px focus token, ended Agent still visible, wrong Region/session mapping, duplicate outside avatar, keyboard event opening the enclosing Topic. Original source restored after each run.
- Production callers: `WorkspaceTopicsPanel` consumes `TopicPresence` and `openTopicRegionMosaics`; workbench CSS and `browser-bounds-sync` consume the shared focus width token outside `tokens.css`.
- Browser proof renders actual `TopicPresence` and production CSS: one/two/four Region geometries; all seven displayed avatar rectangles fit their cell; clicking Implementation selects it; computed focused Region border is 1px. Screenshot: `/tmp/topic-region-presence.png`. Ego TaskSpace 9 finished.
- Layout JSON serialization/reload retains the exact roster and cell mapping. This is a projection-only change: no Session lifecycle or layout persistence mutation. Full installed-app restart proof belongs to the parent's packaging/integration run.

Commands (the isolated worktree reuses installed dependencies, so disable pnpm's automatic dependency reinstall for these checks):

```sh
pnpm --config.verify-deps-before-run=false --filter @agentmux/desktop typecheck
pnpm --config.verify-deps-before-run=false exec vitest run apps/desktop/test/topic-region-mosaic.test.tsx apps/desktop/test/workspace-topics-panel.test.tsx apps/desktop/test/scratch-topic-layout.test.ts apps/desktop/test/region-focus-visibility.test.ts apps/desktop/test/surface-scale-contract.test.ts apps/desktop/test/selector-presence-shape.test.ts apps/desktop/test/sliced-scan-surface-not-empty.test.ts
python3 /tmp/topic-region-mutants.py
```

Integration note: AgentAvatar is deliberately unchanged. The parent is adding per-executor appearance; pass the same appearance through `TopicPresence`/`RegionMosaic` as through the remaining background `SelectorPresence` avatars. Current avatar size is 18px, with a .6 visual scale inside 48×28 mosaics; verify after any avatar size change.
