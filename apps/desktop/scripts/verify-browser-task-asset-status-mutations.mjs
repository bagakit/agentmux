import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const components = 'apps/desktop/src/renderer/src/components/'
const status = components + 'BrowserOperationSurface.tsx'
const demonstration = components + 'BrowserDemonstrationSurface.tsx'
const editor = components + 'BrowserTaskAssetEditor.tsx'
const pane = components + 'BrowserPane.tsx'

await verifyRendererSourceMutations({
  name: `browser-task-asset-status-mutations-${Date.now()}-${randomUUID().slice(0, 8)}`,
  tests: ['apps/desktop/test/browser-task-asset-status.test.tsx'],
  sources: [status, demonstration, editor, pane,
    'apps/desktop/src/renderer/src/styles/browser-operation-surface.css',
    'apps/desktop/src/renderer/src/styles/browser-task-assets.css',
    'apps/desktop/src/main/browser-task-assets.ts',
    'apps/desktop/src/main/browser-operation-journal.ts',
    'apps/desktop/src/main/browser-replay-compiler.ts',
    'apps/desktop/src/shared/browser-task-assets.ts',
    'apps/desktop/src/shared/browser-operation.ts',
    'apps/desktop/src/shared/browser-demonstration.ts',
    'packages/core/src/browser-page-capability.ts'],
  mutations: [
    { label: 'prepared-main-cursor-not-bound-to-host', file: 'apps/desktop/src/main/browser-task-assets.ts',
      before: 'host.onRunPrepared(next.id)', after: 'void next.id' },
    { label: 'current-cursor-disconnected', file: pane,
      before: '{...(tab.taskAssets ? { taskAssets: tab.taskAssets } : {})}',
      after: '{...(tab.taskAssets ? { taskAssets: undefined } : {})}' },
    { label: 'completed-action-masquerades-as-workflow-completion', file: status,
      before: "const phase = taskRun ? taskRun.status === 'waiting-human' ? 'human' : 'waiting' : operation",
      after: 'const phase = operation' },
    { label: 'old-waiting-covers-new-healthy-activity', file: status,
      before: `(operation ? terminal && operation.browserId === browserId &&
      (latestRun.operationIds.at(-1) === operation.id || (latestRun.operationIds.length === 0 && operation.startedAt < latestRun.startedAt))
      : activity.control === 'human')`,
      after: 'true' },
    { label: 'older-unrelated-journal-adopted-after-observed-action', file: status,
      before: 'latestRun.operationIds.length === 0', after: 'true' },
    { label: 'foreign-browser-cursor-adopted', file: status,
      before: 'taskAssets?.runs.filter(run => run.browserId === browserId)',
      after: 'taskAssets?.runs' },
    { label: 'editor-version-masquerades-as-running-version', file: editor,
      before: 'asset?.versions.find(item => item.version === actualRun?.version)',
      after: 'asset?.versions.find(item => item.version === versionNumber)' },
    { label: 'original-and-edited-steps-always-expanded', file: demonstration,
      before: 'open={recording || !collapseSteps}', after: 'open' },
    { label: 'review-opens-another-selected-asset', file: pane,
      before: 'setSelectedTaskAssetId(assetId); setTaskAssetReview({ assetId, version }); openOperationTimeline()',
      after: 'setTaskAssetReview({ assetId, version }); openOperationTimeline()' },
    { label: 'review-does-not-locate-the-stated-version', file: pane,
      before: '{...(taskAssetReview ? { reviewRequest: taskAssetReview } : {})}',
      after: '{...(taskAssetReview ? { reviewRequest: undefined } : {})}' },
    { label: 'consumed-review-replays-on-generic-reopen', file: editor,
      before: 'onReviewRequestConsumed?.()', after: 'void onReviewRequestConsumed' },
    { label: 'continue-uses-latest-instead-of-actual-version', file: editor,
      before: 'version: version.version, parameters:',
      after: 'version: asset!.versions.at(-1)!.version, parameters:' },
    { label: 'save-failure-hidden-by-storage-warning', file: editor,
      before: '[warning, error].filter(Boolean).map((message, index) => <p key={index} className="browser-rsi-timeline__warning" role="status"><CircleAlert size={12} aria-hidden="true" />{message}</p>)}\n    {actualRun ?',
      after: '[warning].filter(Boolean).map((message, index) => <p key={index} className="browser-rsi-timeline__warning" role="status"><CircleAlert size={12} aria-hidden="true" />{message}</p>)}\n    {actualRun ?' },
    { label: 'stop-addresses-asset-instead-of-actual-run', file: editor,
      before: 'onStop(actualRun.id, event)', after: 'onStop(asset!.id, event)' }
  ]
})
