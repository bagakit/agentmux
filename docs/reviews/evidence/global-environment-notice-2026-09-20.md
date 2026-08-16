# Global environment notice: behavior and recovery evidence

Owner task: f-27w8fu3gk / T-001. Approved scope: `docs/reviews/footer-attention-controls-2026-09-20.md`; the parent agent owns the design SSOT and tracker changes. Worktree: `/tmp/agentmux-global-notice-20260920`, branch `fix/global-environment-notice`, base `bb48dcc6`.

## Boundary

The existing `App → ShellEnvironmentNotice` production path now renders a compact Environment control. The native popover contains the full step, current mode, and recovery instruction, with a close control and Escape/light-dismiss support. Reading or closing never clears `environmentWarning` and never changes an Agent.

The existing mailbox receipt hook moved to `lib/use-service-notices.ts`; SessionMailbox and global environment notices use the same persisted `noticeReadReceipts` owner. The global scope is `global:environment`, not an invented Agent identity. Content fingerprints coalesce repeated identical warnings and mark changed warnings unread. Confirmed resolution removes the matching receipt; an unavailable startup snapshot does not. `environmentWarning === undefined` means unavailable, while `null` remains confirmed absence.

## Verification

All commands ran with real cwd `/private/tmp/agentmux-global-notice-20260920`. `apps/desktop/node_modules/@agentmux/core` resolves to this worktree's Core. Shared third-party dependencies do not select the tested source tree. The direct Node CLI avoids pnpm wrapper cwd ambiguity.

Core prerequisites were built in this worktree with `node node_modules/typescript/bin/tsc -b packages/core/tsconfig.build.json`. An initial combined prerequisite command also named a nonexistent layout build config; Core built, and layout is a source-export package with no build step. No production app was installed or replaced.

```
node node_modules/vitest/vitest.mjs run \
  apps/desktop/test/shell-environment-notice.test.tsx \
  apps/desktop/test/session-mailbox.test.tsx \
  apps/desktop/test/agent-session-composer.test.tsx \
  apps/desktop/test/app-service-window-mount.test.tsx \
  apps/desktop/test/surface-scale-contract.test.ts \
  apps/desktop/test/surface-radius-contract.test.ts \
  apps/desktop/test/stylesheet-organisation.test.ts \
  apps/desktop/test/selector-presence-shape.test.ts --maxWorkers=1
```

Result: **8 files, 85 tests passed**. This includes the actual App mount, both notification consumers, real localStorage flush and Zustand rehydration, unknown startup observation, changed content, confirmed recovery, and recurrence.

`node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json` passed. A temporary `apps/desktop/tsconfig.notice-check.json` extending `tsconfig.test.json`, including all production sources plus `test/shell-environment-notice.test.tsx`, also passed and was removed. The repository-wide test typecheck reports unrelated fixture/type errors, including `active-workspace-reseat.test.ts:172` and `activity-view-wiring.test.tsx:22`; no claim is made that the entire existing test typecheck is clean.

`git diff --check` passed.

## Mutations

Every production mutation was applied in isolation and restored exactly before the next. Shell mutations used:

```
node node_modules/vitest/vitest.mjs run apps/desktop/test/shell-environment-notice.test.tsx --maxWorkers=1
```

| Mutation | Observed result |
| --- | --- |
| Disable acknowledging visible notices | 3 failed, 2 passed |
| Treat unknown snapshot as available | 1 failed, 4 passed |
| Restore `environmentWarning` startup default to `null` | 1 failed, 4 passed |
| Remove notice content from the shared fingerprint | 1 failed, 4 passed |
| Clear the environment fact when collapsing | 3 failed, 2 passed |
| Change native close action from `hide` to `toggle` | 1 failed, 4 passed |

Removing `<ShellEnvironmentNotice />` from App was separately killed by:

```
node node_modules/vitest/vitest.mjs run apps/desktop/test/app-service-window-mount.test.tsx --maxWorkers=1
```

Result: **1 failed, 2 passed**. Thus the delivery path is covered, not only an isolated component. Seven final-contract mutation groups were killed, totaling eleven failing assertions. The earlier loading-only draft was additionally tested and replaced by the stronger snapshot-availability boundary.

## Production callers

`rg -n 'ShellEnvironmentNotice' apps/desktop/src/renderer/src --glob '!ShellEnvironmentNotice.tsx'` finds App's import and JSX mount. `useServiceNotices` has independent global-environment and Agent-composer consumers, with the gallery using the same owner. There is no compatibility wrapper and no second read-receipt store.

## Actual UI

Ego-browser TaskSpace 11, page p1, used this worktree's Vite web preview. A temporary mock RuntimeSnapshot supplied the warning on every startup, making a real reload exercise the same warning again; the fixture change to `lib/api.ts` was restored before final tests and is not committed.

Verified with native browser clicks:

- Initial compact control is unread and the detail popover is closed. The App footer consumes **23 px**.
- Opening displays the full step/mode/restore and marks read. Closing with X or Escape leaves the warning retrievable.
- A real reload with the same RuntimeSnapshot preserves read state and starts collapsed.
- At **520 × 760**, the open card is **420 px** wide, from x=92 to x=512, inside the viewport. The surrounding preview's pre-existing sidebars do not adapt to that narrow viewport; this check concerns the notification control and card.

Screenshots: [collapsed](global-environment-notice-2026-09-20/collapsed.png), [expanded](global-environment-notice-2026-09-20/expanded.png), [narrow](global-environment-notice-2026-09-20/narrow.png).
