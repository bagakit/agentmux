# Global system notifications: unified footer

Bounded extension of `f-27w8fu3gk / T-001`, following the approved global-notification closure in the parent design/review. Base: `28c5c584` in `/tmp/agentmux-global-notice-20260920`; parent worktree and SessionMailbox were untouched.

## Ownership and closure

Three existing service facts now project into **one** `GlobalSystemNotices` popover in App's existing bottom status row: shell environment, Runtime launch-record ownership, and displaced Agent placement. The separate three components are deleted. Agent rollup stays independently scoped; the system entry remains available with zero Agents. There is no extra notification row.

Existing `useServiceNotices` remains the only receipt mechanism. Per-owner scopes preserve existing environment receipts and independent unknown/known boundaries. Opening reads the displayed fingerprints; collapsing, outside click, and Escape never resolve or erase a fact. Same content after restart remains read, while changed content becomes unread. Runtime warning `undefined` means unavailable snapshot; only a successful canonical snapshot establishes an empty list. Successful resync also updates shell-environment facts, which previously remained stuck at startup values.

The existing displaced ID list now persists as unresolved placement intent. It is not a second Session ledger: current details and recovery action still derive from Sessions plus layout. Missing Session facts during restart retain receipts. `selectSession` removes the marker in the same successful layout commit; an unavailable Tab Group leaves it intact. A later intentional view close therefore does not resurrect the old displacement. Existing `removeSessionProjection` also removes the marker when its owner removes that Session, with a real matching-Run removal test and stale-Run negative case. Empty/unknown projections do not establish recovery.

The persistence version remains 1: an optional placement-intent key is added without changing the meaning of existing fields. No version-specific conversion is needed. The real previous-version and same-version rehydrate fixture now includes non-default `noticeReadReceipts` and `displacedAgentSessionIds`, and asserts their values, rather than merely listing keys.

## Verification

Executed directly from this worktree (Vitest reported `/private/tmp/agentmux-global-notice-20260920`):

```sh
node node_modules/vitest/vitest.mjs run apps/desktop/test/shell-environment-notice.test.tsx apps/desktop/test/runtime-ownership-notice.test.tsx apps/desktop/test/displaced-agent-notice.test.tsx apps/desktop/test/app-service-window-mount.test.tsx apps/desktop/test/app-resize-owner.test.tsx apps/desktop/test/agent-status-bar.test.tsx apps/desktop/test/rendered-class-has-rule.test.ts apps/desktop/test/surface-scale-contract.test.ts apps/desktop/test/workbench-persist-version-bump.test.ts apps/desktop/test/store-persistence.test.ts apps/desktop/test/service-window-notice.test.ts apps/desktop/test/service-window-notice-component.test.tsx apps/desktop/test/surface-radius-contract.test.ts apps/desktop/test/renderer-state-owners.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.json --noEmit
```

**14 files / 165 tests passed.** Desktop production typecheck passed. A temporary config extending `apps/desktop/tsconfig.json`, including all production source plus the six changed behavior-test files, also passed `tsc --noEmit`; it was removed after verification. The version-bump fixture's existing optional-name TypeScript errors were corrected with its known configured persistence key.

Real App tests prove the actual footer caller with zero Agents, canonical initialization, and event-triggered resync. True store displacement tests drive a launch whose target Region is removed while launching, recover it by the actual button, and then close the recovered view while keeping the Agent alive. Receipt tests exercise `pagehide` persistence flush, fresh unknown startup state, real `persist.rehydrate()`, partial fact recovery, and changed content.

## Mutation results

Each mutation was applied alone to production source, run with the command below, and restored in `finally`. **13 mutants killed / 24 failing test cases across runs.** Final restored checks passed.

| Mutant | Command | Actual result |
| --- | --- | --- |
| `no-read-ack` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/shell-environment-notice.test.tsx --maxWorkers=1` | Tests  5 failed \| 3 passed (8) (exit 1) |
| `collapse-deletes-facts` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/shell-environment-notice.test.tsx --maxWorkers=1` | Tests  5 failed \| 3 passed (8) (exit 1) |
| `omit-runtime-projection` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/app-service-window-mount.test.tsx --maxWorkers=1` | Tests  2 failed \| 1 passed (3) (exit 1) |
| `recovery-action-noop` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/displaced-agent-notice.test.tsx --maxWorkers=1` | Tests  1 failed \| 3 passed (4) (exit 1) |
| `unknown-displacement-prunes-read` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/shell-environment-notice.test.tsx --maxWorkers=1` | Tests  1 failed \| 7 passed (8) (exit 1) |
| `runtime-startup-means-resolved` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/shell-environment-notice.test.tsx --maxWorkers=1` | Tests  1 failed \| 7 passed (8) (exit 1) |
| `forget-durable-placement-intent` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/shell-environment-notice.test.tsx apps/desktop/test/workbench-persist-version-bump.test.ts --maxWorkers=1` | Tests  2 failed \| 18 passed (20) (exit 1) |
| `recovered-marker-survives` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/displaced-agent-notice.test.tsx --maxWorkers=1` | Tests  1 failed \| 3 passed (4) (exit 1) |
| `failed-placement-clears-marker` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/displaced-agent-notice.test.tsx --maxWorkers=1` | Tests  1 failed \| 3 passed (4) (exit 1) |
| `remove-product-caller` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/app-service-window-mount.test.tsx --maxWorkers=1` | Tests  2 failed \| 1 passed (3) (exit 1) |
| `collapse-button-opens` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/shell-environment-notice.test.tsx --maxWorkers=1` | Tests  1 failed \| 7 passed (8) (exit 1) |
| `resync-drops-environment` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/app-service-window-mount.test.tsx --maxWorkers=1` | Tests  1 failed \| 2 passed (3) (exit 1) |
| `terminal-removal-keeps-marker` | `node node_modules/vitest/vitest.mjs run apps/desktop/test/displaced-agent-notice.test.tsx --maxWorkers=1` | Tests  1 failed \| 4 passed (5) (exit 1) |

Production mutation details:

- `no-read-ack` in `apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx`: `if (open) for (const inbox of inboxes)` → `if (false) for (const inbox of inboxes)`.
- `collapse-deletes-facts` in `apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx`: `onToggle={(event) => setOpen(event.newState === 'open')}` → `onToggle={(event) => { setOpen(event.newState === 'open'); if (event.newState !== 'open') useAppStore.setState({environmentWarning:null,runtimeOwnershipWarnings:[],displacedAgentSessionIds:[]}) }}`.
- `omit-runtime-projection` in `apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx`: `const ownership: ServiceNoticeItem[] = hosts?.length ?` → `const ownership: ServiceNoticeItem[] = false ?`.
- `recovery-action-noop` in `apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx`: `run: () => selectSession(item.agentSessionId)` → `run: () => undefined`.
- `unknown-displacement-prunes-read` in `apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx`: `useServiceNotices('global:displaced-agents', displaced, displacedKnown)` → `useServiceNotices('global:displaced-agents', displaced, true)`.
- `runtime-startup-means-resolved` in `apps/desktop/src/renderer/src/store.ts`: `  runtimeOwnershipWarnings: undefined,` → `  runtimeOwnershipWarnings: [],`.
- `forget-durable-placement-intent` in `apps/desktop/src/renderer/src/store.ts`: `    displacedAgentSessionIds: state.displacedAgentSessionIds, ` → `[deleted]`.
- `recovered-marker-survives` in `apps/desktop/src/renderer/src/store.ts`: `      displacedAgentSessionIds: state.displacedAgentSessionIds.filter((sessionId) => sessionId !== id)` → `      displacedAgentSessionIds: state.displacedAgentSessionIds`.
- `failed-placement-clears-marker` in `apps/desktop/src/renderer/src/store.ts`: `  selectSession(id, preferredTabGroupId) {` → `  selectSession(id, preferredTabGroupId) {     set((state) => ({displacedAgentSessionIds:state.displacedAgentSessionIds.filter((sessionId) => sessionId !== id)}))`.
- `remove-product-caller` in `apps/desktop/src/renderer/src/App.tsx`: `        <GlobalSystemNotices />` → `[deleted]`.
- `collapse-button-opens` in `apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx`: `popoverTarget={id} popoverTargetAction="hide"` → `popoverTarget={id} popoverTargetAction="show"`.
- `resync-drops-environment` in `apps/desktop/src/renderer/src/store.ts`: `environmentWarning: snapshot.environmentWarning ?? null` → `environmentWarning: null`.
- `terminal-removal-keeps-marker` in `apps/desktop/src/renderer/src/lib/session-state.ts`: `    ...(state.displacedAgentSessionIds ? { displacedAgentSessionIds: state.displacedAgentSessionIds.filter((id) => id !== sessionId) } : {}), ` → `[deleted]`.

## Browser evidence

Used ego-browser TaskSpace 17, a Vite server rooted in this worktree on port 4317, and the real App. Preview-only snapshot fixture supplied the same shell/ownership warning on reload; displacement came from existing preview Sessions and the durable placement marker. The temporary `api.ts` fixture was restored (no remaining diff). The task space and owned Vite process were closed; no installed app or user Session was modified.

- At 1816×1146 the footer measured `{x:0,y:1122,width:1816,height:24}`. The old main-shell notice container measured height **0**.
- At 520×760 the same footer measured height **24**, the system trigger's right edge was **508**, and the open panel was `{x:88,y:436.18,width:420,height:299.57,right:508,bottom:735.75}`. Body scroll width remained **520**.
- Native click opened all three notices. Native close and Escape collapsed the popover; shell warning, ownership warning, and displaced marker remained intact after close.
- Native **Give it a place** created/selected the actual Session Tab and removed its notice. The production store regression additionally proves the now-added marker clearing and failed-placement negative case.
- Full page reload restored all three unchanged notices with `0 unread`; current loaded store had all three receipt scopes and the durable `session-codex` placement marker. The browser's Vite-loaded module URL was used for store inspection to avoid reading a second module instance after HMR.
- With current Sessions set to an empty preview fixture, the Agent summary was absent, the System entry still opened, and footer height stayed **24**.

Screenshots: [three notices in the narrow viewport](global-system-notices-2026-09-20/narrow-open.png), [same notices read after reload](global-system-notices-2026-09-20/reloaded-read.png), [zero-Agent system entry](global-system-notices-2026-09-20/zero-agents.png).

## Caller check

`rg -n 'GlobalSystemNotices' apps/desktop/src/renderer/src --glob '*.tsx'` finds the import and render in **App.tsx outside the definition file**. Removing that render causes both nonempty real-App cases to fail. There are no remaining imports/renders of `ShellEnvironmentNotice`, `RuntimeOwnershipNotice`, or the deleted `DisplacedAgentNotice` component. SessionMailbox is unchanged.
