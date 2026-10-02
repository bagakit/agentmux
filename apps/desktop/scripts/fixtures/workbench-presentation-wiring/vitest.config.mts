import { defineConfig } from 'vitest/config'
import type { Reporter } from 'vitest/reporters'
import type { Task } from '@vitest/runner'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sourceConfig from '../settings-overview/vitest.config.mts'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const requested = process.argv.filter(argument => /^(apps\/desktop\/test|packages\/client-ui\/test)\/.+\.test\.tsx$/.test(argument))
function countTests(task: Task): number { return task.type === 'test' ? task.result?.state === 'pass' || task.result?.state === 'fail' ? 1 : 0 : task.tasks.reduce((sum, child) => sum + countTests(child), 0) }
const discovery: Reporter = { onFinished(files = []) {
  const discovered = files.map(file => ({ path: relative(root, file.filepath), tests: countTests(file) }))
  const receipt = { requested, discovered, passed: discovered.every(file => file.tests > 0) &&
    JSON.stringify(discovered.map(file => file.path).sort()) === JSON.stringify([...requested].sort()) }
  const directory = resolve(root, '.tmp/workbench-presentation-wiring/mounted')
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'discovery.json'), JSON.stringify(receipt, null, 2) + '\n')
  assert.ok(requested.length > 0, 'Requested owning suites are nonempty')
  assert.deepEqual(discovered.map(file => file.path).sort(), [...requested].sort(), 'Every requested owning suite is actually discovered')
  for (const file of discovered) assert.ok(file.tests > 0, 'Every discovered suite executes nonempty tests: ' + file.path)
} }
const changes = {
  'drop-primary-reference': ["reference={targetId === null ? homeReferences.get(tab.id) ?? undefined : projection?.reference}", "reference={undefined}"],
  'drop-secondary-presentations': ["presentations={surface.kind === 'agent' ? browserTargets.filter(", "presentations={false ? browserTargets.filter("]
} as const
const observe = { name: 'workbench-presentation-wiring-proof', enforce: 'pre' as const, transform(source: string, id: string) {
  const path = id.split('?')[0]!
  const exact = resolve(root, 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx')
  if (path !== exact) return
  const mutation = process.env.AGENTMUX_WORKBENCH_MUTATION as keyof typeof changes | undefined
  let code = source
  if (mutation) {
    assert.ok(changes[mutation], 'Known actual Workbench producer mutant')
    const [from, to] = changes[mutation]
    assert.equal(source.split(from).length - 1, 1, 'Unique bearing Workbench producer block')
    code = source.replace(from, to)
  }
  if (process.env.AGENTMUX_WORKBENCH_LOADED) appendFileSync(process.env.AGENTMUX_WORKBENCH_LOADED,
    JSON.stringify({ path: relative(root, path), sourceSHA: createHash('sha256').update(source).digest('hex'),
      loadedSHA: createHash('sha256').update(code).digest('hex'), mutation: mutation ?? null, transformed: code !== source }) + '\n')
  if (code !== source) return { code, map: null }
} }
export default defineConfig({ ...sourceConfig, plugins: [observe], esbuild: { jsx: 'automatic' }, cacheDir: resolve(root, '.tmp/workbench-presentation-wiring/vite-cache'), resolve: { ...sourceConfig.resolve, alias: [
  { find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/components/$1.tsx') },
  { find: /^@agentmux\/client-ui\/platform$/, replacement: resolve(root, 'packages/client-ui/src/platform.tsx') },
  { find: /^@agentmux\/client-ui\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/lib/$1.ts') },
  { find: /^@agentmux\/client-ui$/, replacement: resolve(root, 'packages/client-ui/src/index.ts') },
  { find: /^@agentmux\/demand\/goals$/, replacement: resolve(root, 'packages/demand/src/goals.ts') },
  ...sourceConfig.resolve!.alias
] }, test: { ...sourceConfig.test, reporters: ['default', 'json', discovery], outputFile: { json: resolve(root, '.tmp/workbench-presentation-wiring/mounted/results.json') }, environmentMatchGlobs: [['packages/client-ui/test/**', 'happy-dom']], include: ['apps/desktop/test/workbench-presentation-wiring.integration.test.tsx'] } })
