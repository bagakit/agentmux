import base from './vitest.conversation-unified.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
const mutations: Record<string, [string, string]> = {
  'freeze-location': ['delivered = true\n        return located', 'delivered = true\n        return await read({ ...request, anchor: { record, revision: view.rows.find(row => row.id === target)!.revision, frontier: located.window.checkpoint } }, port, \'inspect\') as AgentConversationReadPage'],
  'lose-location-navigation': ["navigation: { older: complete ? historyCursor(navigation.older) : null, newer: complete ? historyCursor(navigation.newer, 'newer') : null }", "navigation: { older: complete && !state.record ? historyCursor(navigation.older) : null, newer: complete && !state.record ? historyCursor(navigation.newer, 'newer') : null }"],
  'leak-failed-location': ['if (!delivered && token) port.state.release(token, input)', 'if (false && !delivered && token) port.state.release(token, input)']
}
const mutation = process.env.AGENTMUX_LOCATION_MUTATION, change = mutation ? mutations[mutation] : undefined
if (mutation && !change) throw Error('Unknown location mutation')
export default defineConfig({ ...base, cacheDir: '.cache/conversation-record-location', plugins: [...base.plugins ?? [], {
  name: 'conversation-location-loaded-source', enforce: 'pre', transform(source, id) {
    if (!id.endsWith('/packages/core/src/conversation-reader.ts')) return
    if (change && source.split(change[0]).length !== 2) throw Error('Missing unique location mutation anchor: ' + mutation)
    const code = change ? source.replace(...change) : source, sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_LOCATION_LOADED) appendFileSync(process.env.AGENTMUX_LOCATION_LOADED, JSON.stringify({ path: 'packages/core/src/conversation-reader.ts', mutation: change ? mutation : null, originalSHA256: sha(source), sha256: sha(code) }) + '\n')
    if (code !== source) return { code, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/conversation-record-location.test.ts'], passWithNoTests: false, testTimeout: 30000 } })
