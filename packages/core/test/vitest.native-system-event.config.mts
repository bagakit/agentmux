import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const target = 'packages/providers/src/codex/saved-history.ts'
const purpose = "...(record.type === 'token_usage_record' || record.type === 'event_msg' &&\n        (type === 'task_started' || type === 'task_complete' || type === 'turn_aborted')\n        ? { recordPurpose: 'system-event' as const } : {}),"
export default defineConfig({ ...original, root,
  resolve: { ...original.resolve, alias: [
    { find: '@agentmux/providers/codex/saved-history', replacement: resolve(root, 'packages/providers/src/codex/saved-history.ts') },
    ...(Array.isArray(original.resolve?.alias) ? original.resolve.alias : [])
  ] }, cacheDir: resolve(root, '.cache/native-system-event', process.env.AGENTMUX_SYSTEM_EVENT_MUTATION ?? 'baseline'),
  plugins: [...original.plugins ?? [], { name: 'native-system-event-actual-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if ((!path.startsWith('packages/core/src/') && path !== target) || !path.endsWith('.ts')) return
    let code = source
    const mutation = process.env.AGENTMUX_SYSTEM_EVENT_MUTATION
    if (mutation) {
      assert.equal(mutation, 'omit-purpose', 'Known unique classification mutation')
      if (path === target) {
        assert.equal(source.split(purpose).length, 2, 'Exactly one original Provider purpose contribution')
        code = source.replace(purpose, '')
      }
    }
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_SYSTEM_EVENT_LOADED) appendFileSync(process.env.AGENTMUX_SYSTEM_EVENT_LOADED,
      JSON.stringify({ path, sourceSHA256: hash(source), loadedSHA256: hash(code), ...(source !== code ? { mutation } : {}) }) + '\n')
    if (code !== source) return { code, map: null }
  } }], test: { ...original.test, globalSetup: [], include: ['packages/core/test/native-system-event-purpose.test.ts'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
