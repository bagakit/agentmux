import { fileURLToPath } from 'node:url'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import assert from 'node:assert/strict'
const rootUrl = new URL('../../../../../', import.meta.url), root = fileURLToPath(rootUrl)
const manifest = JSON.parse(readFileSync(new URL('packages/core/package.json', rootUrl), 'utf8'))
const coreAliases = Object.entries(manifest.exports).map(([key, value]) => ({ find: '@agentmux/core' + (key === '.' ? '' : key.slice(1)),
  replacement: fileURLToPath(new URL('packages/core/' + (value as { types: string }).types.replace('./dist/', 'src/').replace('.d.ts', '.ts'), rootUrl)) })).sort((left, right) => right.find.length - left.find.length)
if (!coreAliases.length) throw new Error('Core Source aliases must be nonempty')
const mutations = {
  'batch-cli-input-shape': ['packages/core/src/agentmux.ts',
    "          Object.keys(supplied).some(key => key !== 'parameters' && key !== 'items')",
    "          false"],

  "batch-item-secret": [
    "apps/desktop/src/main/browser-task-assets.ts",
    "if (!parameter || parameter.secret)",
    "if (!parameter)"
  ],
  "batch-original-binding": [
    "apps/desktop/src/main/browser-task-assets.ts",
    "if (!original || result.id !== original.id || result.browserId !== browserId || result.assetId !== batch!.assetId || result.version !== batch!.version ||\n              result.status !== original.status || result.nextStep !== original.nextStep)",
    "if (false)"
  ],
  "batch-unknown-next-item": [
    "apps/desktop/src/main/browser-task-assets.ts",
    "else { batch!.status = original.status; batch!.warning = original.warning ?? 'Inspect this original task run before continuing the batch.' }",
    "else { batch!.nextItem += 1 }"
  ],
  "batch-repeat-human-intent": [
    "apps/desktop/src/main/browser-view-manager.ts",
    "return this.executeTaskAsset(item, itemIntent, budget)",
    "return this.executeTaskAsset(item, intent, budget)"
  ],
  "batch-preparation-stop": [
    "apps/desktop/src/main/browser-task-assets.ts",
    " && batch.status === 'running'",
    ""
  ],
  "batch-lease-gap": [
    "apps/desktop/src/main/browser-task-assets.ts",
    "return !!active && (batchId === undefined || active.batchId !== batchId)",
    "return false"
  ],
  "batch-aggregate-ops": [
    "apps/desktop/src/main/browser-task-assets.ts",
    "batch.operationCount >= BROWSER_TASK_BATCH_MAX_OPERATIONS || ",
    ""
  ],
  "batch-aggregate-time": [
    "apps/desktop/src/main/browser-task-assets.ts",
    "timeMillis: BROWSER_TASK_BATCH_MAX_MILLIS - batch.executedMillis + (previous?.executedMillis ?? 0)",
    "timeMillis: BROWSER_TASK_BATCH_MAX_MILLIS"
  ],
  "batch-cost-projection": [
    "apps/desktop/src/main/browser-task-assets.ts",
    "for (const batch of this.document.batches ?? []) {\n      if (browserId && batch.browserId !== browserId) continue",
    "for (const batch of []) {\n      if (browserId && batch.browserId !== browserId) continue"
  ],
  "batch-public-item-order": [
    "packages/core/src/browser-task-control.ts",
    "(request.batchId !== undefined && request.batchId !== result.batch.id) || result.batch.items.length !== request.items.length || result.batch.items.some((item, index) => item.id !== request.items[index]?.id)",
    "(request.batchId !== undefined && request.batchId !== result.batch.id)"
  ],
  "batch-public-cost-binding": [
    "packages/core/src/browser-task-control.ts",
    "    if (batch.operationCount !== related.reduce((sum, run) => sum + run.operationIds.length, 0) ||\n        batch.executedMillis !== related.reduce((sum, run) => sum + (run.executedMillis ?? 0), 0)) bad('Browser task batch costs are not bound to original runs.')",
    "    // Mutation: accept reported costs without original run facts."
  ],
  "batch-transient-values": [
    "apps/desktop/src/main/browser-task-assets.ts",
    "items: supplied.items.map(item => ({ id: item.id }))",
    "items: supplied.items.map(item => ({ id: item.id, parameters: item.parameters }))"
  ],
  "batch-ui-secret-clear": [
    "apps/desktop/src/renderer/src/components/BrowserTaskBatchEditor.tsx",
    "finally { setFresh({}) }",
    "finally {}"
  ],
  "batch-ui-item-budget": [
    "apps/desktop/src/renderer/src/components/BrowserTaskBatchEditor.tsx",
    "items.length >= 16",
    "items.length > 16"
  ],
  "batch-editor-mount": [
    "apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx",
    "{version && onRunBatch && onStopBatch ? <BrowserTaskBatchEditor version={version} batch={batch ?? null} runs={batchRuns} busy={busy} onRun={onRunBatch} onStop={onStopBatch} /> : null}",
    "{null}"
  ],
  "batch-cli-drops-items": [
    "packages/core/src/agentmux.ts",
    "invocation.params.items = (supplied as Record<string, unknown>).items",
    "invocation.params.items = []"
  ],
  "batch-active-preparation-projection": [
    "apps/desktop/src/main/browser-task-assets.ts",
    "activeBatchId: this.activeBrowsers.get(browserId)?.batchId ?? null",
    "activeBatchId: null"
  ],
  "batch-active-public-binding": [
    "packages/core/src/browser-task-control.ts",
    "  if (activeBatchId && !batches?.some(batch => batch.id === activeBatchId)) bad('Browser task active batch is not present.')",
    "  // Mutation: accept an active batch outside original progress."
  ],
  "batch-grouped-run-owner": [
    "apps/desktop/src/main/browser-task-assets.ts",
    "        if (existing && this.document.batches?.some(batch => batch.items.some(item => item.runId === existing.id) && batch.id !== budget?.batchId)) {\n          throw new Error('Continue this item through its original batch to preserve its bounds and progress.')\n        }",
    "        // Mutation: allow an original grouped item outside its aggregate budget."
  ],
  "batch-grouped-human-owner": [
    "apps/desktop/src/main/browser-view-manager.ts",
    "        if (state.batches?.some(batch => batch.items.some(item => item.runId === previous.id) && batch.id !== budget?.batchId)) {\n          throw new Error('Continue this item through its original batch to preserve its bounds and progress.')\n        }",
    "        // Mutation: record person approval before rejecting an out-of-batch request."
  ],
  "batch-single-ui-escape": [
    "apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx",
    "const selectedBatch = batch?.version === versionNumber ? batch : null",
    "const selectedBatch = null"
  ]
} as const
export default {
  root,
  resolve: { alias: [
    { find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: fileURLToPath(new URL('packages/client-ui/src/components/$1.tsx', rootUrl)) },
    { find: /^@agentmux\/client-ui\/(.+)$/, replacement: fileURLToPath(new URL('packages/client-ui/src/lib/$1.ts', rootUrl)) },
    { find: '@agentmux/client-ui', replacement: fileURLToPath(new URL('packages/client-ui/src/index.ts', rootUrl)) },
    { find: '@agentmux/layout', replacement: fileURLToPath(new URL('packages/layout/src/index.ts', rootUrl)) }, ...coreAliases] },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  plugins: [{ name: 'browser-task-owning-source', enforce: 'pre' as const, transform(source: string, id: string) {
    const path = id.split('?')[0]!, rel = relative(root, path)
    const key = process.env.AGENTMUX_BROWSER_TASK_MUTATION as keyof typeof mutations | undefined
    let code = source
    if (key) {
      assert.ok(mutations[key], 'Known actual Browser task Source mutation')
      const [file, from, to] = mutations[key]
      if (rel === file) { assert.equal(source.split(from).length - 1, 1, `Unique loaded ${key} block`); code = source.replace(from, to) }
    }
    if (process.env.AGENTMUX_BROWSER_TASK_LOADED && /^(apps\/desktop\/src|packages\/core\/src)\//.test(rel) && /\.[cm]?tsx?$/.test(rel))
      appendFileSync(process.env.AGENTMUX_BROWSER_TASK_LOADED, JSON.stringify({ path: rel, sha256: createHash('sha256').update(source).digest('hex'),
        loadedSha256: createHash('sha256').update(code).digest('hex'), ...(code === source ? {} : { mutation: key }) }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { include: ['apps/desktop/test/browser-task-control.test.ts', 'apps/desktop/test/browser-task-batch.test.ts', 'apps/desktop/test/browser-task-batch-editor.test.tsx', 'apps/desktop/test/browser-task-budget.test.ts', 'apps/desktop/test/browser-task-branch.test.tsx', 'apps/desktop/test/browser-task-assets.test.tsx'], maxWorkers: 1, cache: false, passWithNoTests: false,
    testTimeout: 15_000, hookTimeout: 30_000, setupFiles: [fileURLToPath(new URL('vitest.setup.ts', rootUrl))] }
}
