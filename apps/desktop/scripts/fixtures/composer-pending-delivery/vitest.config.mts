import { defineConfig } from 'vitest/config'
import type { Reporter } from 'vitest/reporters'
import type { Task } from '@vitest/runner'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import source from '../settings-overview/vitest.config.mts'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const linkedCoreBin = resolve(dirname(fileURLToPath(import.meta.resolve('@agentmux/core'))), '../bin')
const suites = [...(process.env.AGENTMUX_PENDING_COMPACT_CONTRACT === '1' ? ['apps/desktop/test/composer-pending-compact.integration.test.tsx', 'apps/desktop/test/terminal-view-control-observation.test.ts'] : []), 'apps/desktop/test/composer-pending-delivery.integration.test.tsx', 'apps/desktop/test/agent-steer-queue-phase.test.ts', 'apps/desktop/test/agent-explicit-steer.test.tsx']
function count(task: Task): number { return task.type === 'test' ? ['pass', 'fail'].includes(task.result?.state ?? '') ? 1 : 0 : task.tasks.reduce((n,t) => n + count(t),0) }
const discovery: Reporter = { onFinished(files = []) {
  const found = files.map(file => ({ path: relative(root,file.filepath), tests: count(file) }))
  const passed = found.length === suites.length && found.every(f => f.tests > 0) && JSON.stringify(found.map(f => f.path).sort()) === JSON.stringify([...suites].sort())
  const directory = resolve(root,'.tmp/composer-pending-delivery/mounted'); mkdirSync(directory,{recursive:true})
  writeFileSync(resolve(directory,'discovery.json'),JSON.stringify({suites,found,passed},null,2))
  assert.ok(passed,'Every explicit owning suite executes nonempty tests')
} }
export default defineConfig({...source, server:{fs:{allow:[root, linkedCoreBin]}}, esbuild:{jsx:'automatic'},cacheDir:resolve(root,'.tmp/composer-pending-delivery/cache'),resolve:{alias:[
  {find:/^ws$/,replacement:resolve(root,'node_modules/.pnpm/node_modules/ws/index.js')},
  {find:/^@agentmux\/client-ui\/components\/(.+)$/,replacement:resolve(root,'packages/client-ui/src/components/$1.tsx')},
  {find:/^@agentmux\/client-ui\/terminal\/(.+)$/,replacement:resolve(root,'packages/client-ui/src/terminal/$1.ts')},
  {find:/^@agentmux\/client-ui\/platform$/,replacement:resolve(root,'packages/client-ui/src/platform.tsx')},
  {find:/^@agentmux\/client-ui\/(.+)$/,replacement:resolve(root,'packages/client-ui/src/lib/$1.ts')},
  {find:/^@agentmux\/client-ui$/,replacement:resolve(root,'packages/client-ui/src/index.ts')},
  {find:/^@agentmux\/layout$/,replacement:resolve(root,'packages/layout/src/index.ts')},
  {find:/^@agentmux\/demand\/goals$/,replacement:resolve(root,'packages/demand/src/goals.ts')},
  ...source.resolve!.alias
]},test:{...source.test,include:suites,reporters:['default','json',discovery],outputFile:{json:resolve(root,'.tmp/composer-pending-delivery/mounted/results.json')}}})
