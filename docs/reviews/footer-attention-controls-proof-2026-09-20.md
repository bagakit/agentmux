# Footer attention control verification

Scope: f-27w8fu3gk / T-002, following the parent-approved “全局通知与底部状态入口” design constraint and footer-attention-controls-2026-09-20 review. This proof covers the three footer attention controls; it does not claim delivery of global notifications.

## Cause and change

The roster disclosure used the action modifier without the base button class. It therefore retained native button decoration. Working nested the disclosure beside its count, while needs-you and error placed theirs as separate outer flex items, creating unequal spacing.

All three count/disclosure pairs now have the same group boundary. The disclosure inherits the existing button reset and uses a 16 × 16 box, with hover, visible focus and open feedback. Count jumps and list disclosure remain separate actions. No status, session or lifecycle semantics changed.

## Checks

All commands ran from `/private/tmp/agentmux-region-topic-20260920`, explicitly printing `process.cwd()`; no installed app or daemon was operated.

- Eight focused files: **110 tests passed**. Command: `node node_modules/vitest/vitest.mjs run apps/desktop/test/agent-tree-panel.test.tsx apps/desktop/test/agent-status-bar.test.tsx apps/desktop/test/working-count-convergence.test.tsx apps/desktop/test/surface-scale-contract.test.ts apps/desktop/test/surface-tool-dock.test.ts apps/desktop/test/topic-agent-status.test.ts apps/desktop/test/workspace-topics-panel.test.tsx apps/desktop/test/sliced-scan-surface-not-empty.test.ts`.
- Desktop production typecheck passed: `pnpm --config.verify-deps-before-run=false --filter @agentmux/desktop typecheck`.
- Sequential mutants, restored after each: remove trigger base class; remove one status group; change disclosure width to 24px. Each failed the new regression. Logs: `/tmp/footer-mutant-{reset,group,size}.log`.
- Topic integration guard mutant: replace the product `<TopicPresence` call. Both source-wiring tests detected the removal (`/tmp/topic-wiring-mutant.log`). Their scans require nonempty anchors.
- External callers: `rg -n AgentTreePanel apps/desktop/src/renderer/src --glob '!AgentRoster.tsx'` finds its import and all three real renders in AgentStatusBar.

## Browser proof

An isolated Vite preview rendered the actual AgentStatusBar, actual Zustand store and full production styles with three fixture agents; no copied footer markup or substitute style was used. Ego task space 12 was closed after verification; temporary preview files and server were removed.

The three live disclosure bounds were all 16 × 16, with zero native border, transparent rest background, and identical 2px count-to-disclosure gap. Production density rules supplied the same 0px 2px padding to all three. The open background computed to `rgb(42, 49, 56)`.

Pointer opened Working and clicked its actual roster item. The separate needs-you jump then dispatched `waiting` (the Working selection result was not separately sampled). Keyboard Enter opened Error, and selecting its roster item dispatched `error`. The needs-you jump was observed as `Selected: waiting`; Error selection as `Selected: error`.

Screenshots: `/tmp/footer-attention-controls-open.png`, `/tmp/footer-attention-controls-rest.png`. The open screenshot was visually inspected: controls share a baseline and the native gray pills are gone; only the active disclosure has a small highlight. This is component verification, not a claim that the installed application has been updated.
