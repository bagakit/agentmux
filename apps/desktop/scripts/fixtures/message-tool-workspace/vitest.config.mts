import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import type { Reporter } from 'vitest/reporters'
import type { Task } from '@vitest/runner'
import sourceConfig from '../settings-overview/vitest.config.mts'
import { mutations } from './mutations.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const exported = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8')).exports
const aliases = Object.entries(exported).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length).map(([key, value]) => {
  const target = typeof value === 'string' ? value : (value as { browser: string }).browser
  const name = key === '.' ? '@agentmux/client-ui' : '@agentmux/client-ui/' + key.slice(2)
  const pattern = name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
  return { find: new RegExp('^' + pattern + '$'), replacement: resolve(root, 'packages/client-ui', target).replace('*', '$1') }
})
const mutation = process.env.AGENTMUX_MESSAGE_WORKSPACE_MUTATION
const selected = mutations.find(item => item.name === mutation)
assert.ok(!mutation || selected, 'The requested behavior mutation is declared')
const applied: Array<{ file: string; original: string; changed: string }> = []
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const requested = process.argv.filter(argument => /^apps\/desktop\/test\/.+\.test\.tsx$/.test(argument))
const directory = resolve(root, process.env.AGENTMUX_MESSAGE_WORKSPACE_EVIDENCE ?? '.tmp/message-tool-workspace/mounted')
const count = (task: Task): number => task.type === 'test' ? ['pass', 'fail'].includes(task.result?.state ?? '') ? 1 : 0 : task.tasks.reduce((sum, child) => sum + count(child), 0)
const discovery: Reporter = { onFinished(files = []) {
  const discovered = files.map(file => ({ file: relative(root, file.filepath), tests: count(file) }))
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'discovery.json'), JSON.stringify({ requested, discovered, mutation: mutation ?? null, applied }, null, 2) + '\n')
  assert.ok(requested.length > 0, 'The requested behavior suites are nonempty')
  assert.deepEqual(discovered.map(item => item.file).sort(), [...requested].sort(), 'Every requested suite is actually discovered')
  assert.ok(discovered.every(item => item.tests > 0), 'Every discovered suite executes tests')
  if (mutation) assert.equal(applied.length, 1, 'The actual imported consumer is mutated exactly once')
} }
export default defineConfig({ ...sourceConfig, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(root, '.tmp/message-tool-workspace/cache', mutation ?? 'candidate'),
  resolve: { ...sourceConfig.resolve, alias: [...aliases, ...sourceConfig.resolve!.alias] },
  plugins: selected ? [{ name: 'message-workspace-private-mutation', enforce: 'pre', transform(code, id) {
    if (id.split('?')[0] !== resolve(root, selected.file)) return
    assert.equal(code.split(selected.before).length, 2, 'The actual consumer mutation anchor is unique')
    const changed = code.replace(selected.before, selected.after)
    applied.push({ file: selected.file, original: sha(code), changed: sha(changed) })
    return changed
  } }] : [],
  test: { ...sourceConfig.test, include: ['apps/desktop/test/message-tool-workspace.test.tsx'], reporters: ['default', 'json', discovery],
    outputFile: { json: resolve(directory, 'results.json') } }
})
