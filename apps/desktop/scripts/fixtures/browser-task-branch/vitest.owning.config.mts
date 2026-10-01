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
  'budget-late-page-send': ['apps/desktop/src/main/browser-view-manager.ts', "      if (taskPage?.cursor.deadlineMillis !== undefined && performance.now() >= taskPage.cursor.deadlineMillis) throw new Error('Task execution budget reached before page dispatch.')", '      // Mutation: send after original deadline.'],
  'budget-deadline': ['apps/desktop/src/main/browser-task-assets.ts', '        execution.deadlineMillis = callStartedAt + BROWSER_TASK_MAX_EXECUTED_MILLIS - (run.executedMillis ?? 0)', '        // Mutation: omit cumulative deadline.'],
  'budget-remaining-timeout': ['apps/desktop/src/main/browser-view-manager.ts', '        ...(remainingMillis === undefined ? {} : { timeoutMs: Math.min(30_000, remainingMillis) }),', '        // Mutation: grant default script timeout.'],
  "branch-empty-observation": ["apps/desktop/src/main/browser-task-branch.ts", "      if (snapshotResult.nodes.length === 0 || observed.returned !== snapshotResult.nodes.length || observed.scoped !== observed.fullObserved ||\n          observed.matched !== observed.scoped || observed.returned !== observed.matched) return fact;", "      // Mutation: empty returned nodes count as known absence."],
  "branch-selected-save-navigation": ["apps/desktop/src/main/browser-task-assets.ts", "        if (!started || (run as BrowserTaskAssetRun).status === 'stopped') break\n        if (selectedByBranch && host.navigationId?.(browserId) !== selectedByBranch.navigationId) return await invalidateSelection()", "        if (!started || (run as BrowserTaskAssetRun).status === 'stopped') break"],
  "branch-unknown-chooses-false": ["apps/desktop/src/main/browser-task-branch.ts", "return { result: fact.result, navigationId }", "return { result: fact.result === 'unknown' ? 'false' : fact.result, navigationId }"],
  "branch-unbound-result": ["apps/desktop/src/main/browser-task-branch.ts", "fact.browserId !== execution.browserId || fact.runId !== execution.runId || fact.assetId !== execution.assetId ||\n      fact.version !== execution.version || fact.stepId !== execution.stepId || ", ""],
  "branch-late-navigation": ["apps/desktop/src/main/browser-task-branch.ts", "currentNavigationId !== navigationId || ", ""],
  "branch-back-edge": ["apps/desktop/src/shared/browser-task-path.ts", "if (next <= index)", "if (next < 0)"],
  "branch-unreachable": ["apps/desktop/src/shared/browser-task-path.ts", "  if (reachable.size !== steps.length) throw new Error('Task has unreachable steps. Connect or delete them before saving a runnable version.')", "  // Mutation: allow disconnected steps."],
  "branch-budget": ["apps/desktop/src/shared/browser-task-path.ts", " || steps.filter(step => step.kind === 'branch').length > BROWSER_TASK_MAX_BRANCHES", ""],
  "branch-run-budget": ["apps/desktop/src/main/browser-task-assets.ts", "run.operationIds.length >= BROWSER_TASK_MAX_OPERATIONS || (run.executedMillis ?? 0) >= BROWSER_TASK_MAX_EXECUTED_MILLIS", "false"],
  "branch-native-stale-document": ["apps/desktop/src/main/browser-view-manager.ts", "      if (taskPage?.cursor.expectedNavigationId && entry.navigationId !== taskPage.cursor.expectedNavigationId) throw new Error('The selected condition document changed before dispatch.')", "      // Mutation: send the chosen arm to a replacement same-URL document."],
  "branch-public-path-unbound": ["packages/core/src/browser-task-control.ts", " || !stepExecutions?.some(step => step.operationId === fact.operationId && step.stepId === fact.stepId)", ""],
  'cli-drops-fresh-parameters': ['packages/core/src/agentmux.ts', 'invocation.params.parameters = text.trim() ? JSON.parse(text) : {}', 'invocation.params.parameters = {}'],
  'control-approves-human-wait': ['apps/desktop/src/main/browser-view-manager.ts',
    "        if (intent === 'control' && previous.status === 'waiting-human') {\n          throw new Error('This task is waiting for the person. Agent control cannot approve or continue its checkpoint.')\n        }", '        // Mutation: allow an Agent to advance the human checkpoint.'],
  'control-takes-human-input': ['apps/desktop/src/main/browser-view-manager.ts', "if (intent === 'human') this.returnControl(entry.id)", 'this.returnControl(entry.id)'],
  'unbound-version-history': ['apps/desktop/src/main/browser-task-control.ts',
    'state.runs.filter(run => run.browserId === request.browserId && run.assetId === request.assetId && run.version === request.version).flatMap(run => run.operationIds)', 'state.runs.flatMap(run => run.operationIds)'],
  'empty-terminal-samples': ['packages/core/src/browser-task-control.ts',
    "  if (samples.length !== terminalRuns || new Set(samples.map(row => row.runId)).size !== samples.length) bad('Browser task reliability samples are inconsistent.')\n  for (const key of RESULTS) if (samples.filter(row => row.result === key).length !== parsedCounts[key]) bad('Browser task reliability sample counts are inconsistent.')", '  // Mutation: accept an empty terminal sample collection.'],
  'nonfinite-rate': ['packages/core/src/browser-task-control.ts',
    "  if (terminalRuns === 0 ? passRate !== null : typeof passRate !== 'number' || !Number.isFinite(passRate) || passRate !== parsedCounts.passed / terminalRuns) bad('Browser task pass rate is inconsistent.')", '  // Mutation: accept an unchecked pass rate.'],
  'wrong-public-target': ['packages/core/src/rpc-business-codec.ts',
    'assertBrowserTaskControlTarget(parseBrowserTaskControlPayload(request), parseBrowserTaskControlResult(request.operation, result))', '// Mutation: skip requested version identity.']
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
  test: { include: ['apps/desktop/test/browser-task-control.test.ts', 'apps/desktop/test/browser-task-branch.test.tsx', 'apps/desktop/test/browser-task-assets.test.tsx','apps/desktop/test/browser-task-budget.test.ts'], maxWorkers: 1, cache: false, passWithNoTests: false,
    testTimeout: 15_000, hookTimeout: 30_000, setupFiles: [fileURLToPath(new URL('vitest.setup.ts', rootUrl))] }
}
