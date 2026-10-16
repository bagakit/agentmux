import { defineConfig } from 'vitest/config'
import type { Reporter } from 'vitest/reporters'
import type { Task } from '@vitest/runner'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import source from '../settings-overview/vitest.config.mts'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const clientUiExports = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8')).exports
const clientUiAliases = Object.entries(clientUiExports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length).map(([key, value]) => {
  const target = typeof value === 'string' ? value : (value as { browser: string }).browser
  const name = key === '.' ? '@agentmux/client-ui' : '@agentmux/client-ui/' + key.slice(2)
  const pattern = name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
  return { find: new RegExp('^' + pattern + '$'), replacement: resolve(root, 'packages/client-ui', target).replace('*', '$1') }
})
const suites = ['apps/desktop/test/composer-pending-delivery.integration.test.tsx', 'apps/desktop/test/agent-steer-queue-phase.test.ts', 'apps/desktop/test/agent-explicit-steer.test.tsx']
function count(task: Task): number { return task.type === 'test' ? ['pass', 'fail'].includes(task.result?.state ?? '') ? 1 : 0 : task.tasks.reduce((n,t) => n + count(t),0) }
const discovery: Reporter = { onFinished(files = []) {
  const found = files.map(file => ({ path: relative(root,file.filepath), tests: count(file) }))
  const passed = found.length === suites.length && found.every(f => f.tests > 0) && JSON.stringify(found.map(f => f.path).sort()) === JSON.stringify([...suites].sort())
  const directory = resolve(root,'.tmp/composer-pending-delivery/mounted'); mkdirSync(directory,{recursive:true})
  writeFileSync(resolve(directory,'discovery.json'),JSON.stringify({suites,found,passed},null,2))
  assert.ok(passed,'Every explicit owning suite executes nonempty tests')
} }
export default defineConfig({...source, esbuild:{jsx:'automatic'},cacheDir:resolve(root,'.tmp/composer-pending-delivery/cache'),resolve:{conditions:['browser','module','development|production'],alias:[
  ...clientUiAliases,
  {find:/^ws$/,replacement:resolve(root,'node_modules/.pnpm/node_modules/ws/index.js')},
  {find:/^@agentmux\/layout$/,replacement:resolve(root,'packages/layout/src/index.ts')},
  {find:/^@agentmux\/demand\/goals$/,replacement:resolve(root,'packages/demand/src/goals.ts')},
  ...source.resolve!.alias
]},test:{...source.test,include:suites,reporters:['default','json',discovery],outputFile:{json:resolve(root,'.tmp/composer-pending-delivery/mounted/results.json')}}})
