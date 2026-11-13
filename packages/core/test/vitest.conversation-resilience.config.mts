import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'restore-unit-record-cap': ['conversation-changes.ts', 'p.records.length > CONVERSATION_MAX_WINDOW_RECORDS', 'p.records.length > 200'],
  'drop-retained-contributions': ['conversation-reader.ts', 'const records = new Map(view.rows.map(record => [record.id, record]))', 'const records = new Map()'],
  'ignore-window-record-cap': ['conversation-changes.ts', 'recordIds.size > CONVERSATION_MAX_WINDOW_RECORDS || ', ''],
  'evict-owned-view': ['conversation-reader.ts', 'this.views.set(view.id, view); return view', 'this.views.set(view.id, view); if (this.views.size > 16) this.views.delete(this.views.keys().next().value!); return view'],
  'retain-failed-open': ['conversation-reader.ts', 'if (created && !delivered) port.state.release', 'if (false && created && !delivered) port.state.release'],
}
export default defineConfig({ ...original, root, cacheDir: '.cache/conversation-resilience', plugins: [{
  name: 'conversation-resilience-actual-loaded', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
    const mutation = process.env.AGENTMUX_RESILIENCE_MUTATION, change = mutation ? mutations[mutation] : undefined
    if (mutation && !change) throw Error('Unknown conversation resilience mutation')
    let code = source
    if (change && path === 'packages/core/src/' + change[0]) {
      if (source.split(change[1]).length !== 2) throw Error('Missing unique conversation resilience anchor: ' + mutation)
      code = source.replace(change[1], change[2])
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_RESILIENCE_LOADED) appendFileSync(process.env.AGENTMUX_RESILIENCE_LOADED,
      JSON.stringify({ path, originalSHA256: sha(source), sha256: sha(code), ...(source === code ? {} : { mutation }) }) + '\n')
    if (source !== code) return { code, map: null }
  }
}], test: { ...original.test, globalSetup: [], include: ['packages/core/test/conversation-reader-lifetime.test.ts', 'packages/core/test/conversation-unit-capacity.test.ts'],
  passWithNoTests: false, fileParallelism: false, testTimeout: 15000 } })
