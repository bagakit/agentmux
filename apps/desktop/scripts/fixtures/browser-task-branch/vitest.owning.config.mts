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
  'cli-drops-fresh-parameters': ['packages/core/src/agentmux.ts', 'parameters: supplied', 'parameters: {}'],
  'control-approves-human-wait': ['apps/desktop/src/main/browser-view-manager.ts',
    "        if (intent === 'control' && previous.status === 'waiting-human') {\n          throw new Error('This task is waiting for the person. Agent control cannot approve or continue its checkpoint.')\n        }", '        // Mutation: allow an Agent to advance the human checkpoint.'],
  'control-takes-human-input': ['apps/desktop/src/main/browser-view-manager.ts', "if (intent === 'human') this.returnControl(entry.id)", 'this.returnControl(entry.id)'],
  'unbound-version-history': ['apps/desktop/src/main/browser-task-control.ts',
    'state.runs.filter(run => run.browserId === request.browserId && run.assetId === request.assetId && run.version === request.version).flatMap(run => run.operationIds)', 'state.runs.flatMap(run => run.operationIds)'],
  'empty-terminal-samples': ['packages/core/src/browser-task-control.ts',
    "  if (samples.length !== terminalRuns || new Set(samples.map(row => row.runId)).size !== samples.length) bad('Browser task reliability samples are inconsistent.')\n  for (const key of RESULTS) if (samples.filter(row => row.result === key).length !== parsedCounts[key]) bad('Browser task reliability sample counts are inconsistent.')", '  // Mutation: accept an empty terminal sample collection.'],
  'nonfinite-rate': ['packages/core/src/browser-task-control.ts',
    "  if (terminalRuns === 0 ? passRate !== null : typeof passRate !== 'number' || !Number.isFinite(passRate) || passRate !== parsedCounts.passed / terminalRuns) bad('Browser task pass rate is inconsistent.')", '  // Mutation: accept an unchecked pass rate.'],
  'wrong-public-target': ['packages/core/src/control-host.ts',
    'assertBrowserTaskControlTarget(parseBrowserTaskControlPayload(request), parseBrowserTaskControlResult(request.operation, receipt.result))', '// Mutation: skip requested version identity.']
} as const
export default {
  root,
  resolve: { alias: coreAliases },
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
  test: { include: ['apps/desktop/test/browser-task-control.test.ts'], maxWorkers: 1, cache: false, passWithNoTests: false,
    testTimeout: 15_000, hookTimeout: 30_000, setupFiles: [fileURLToPath(new URL('vitest.setup.ts', rootUrl))] }
}
