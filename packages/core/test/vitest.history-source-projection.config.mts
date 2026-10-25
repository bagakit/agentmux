import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...original, root, cacheDir: '.cache/history-source-projection', plugins: [{
  name: 'exact-history-source-work', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== 'packages/core/src/agent-session-store.ts') return
    let code = source
    const mutation = process.env.AGENTMUX_HISTORY_SOURCE_MUTATION
    if (mutation) {
      if (mutation !== 'full-session') throw Error('Unknown history source mutation')
      const active = "const activeRow = db.prepare('SELECT json FROM sessions WHERE id=?').get(agentSessionId)\n      if (activeRow) return activeSessionHistorySource(JSON.parse(String(activeRow.json)), agentSessionId)"
      if (code.split(active).length !== 2) throw Error('Missing unique active history source owner')
      code = code.replace(active, 'const active = this.sessionMetadata(db, agentSessionId)\n      if (active) return sessionHistorySources([active], [], [])[0]!')
    }
    const entry = 'export function normalizeStoredAgentSession(value: unknown): AgentMuxStoredAgentSession {'
    if (code.split(entry).length !== 2) throw Error('Missing unique full-record normalization owner')
    code = code.replace(entry, entry + `
      const probe = Reflect.get(globalThis, '__amuxHistorySourceCost')
      if (probe) {
        const valueRecord = value as AgentMuxStoredAgentSession
        probe.fullRecords++
        probe.continuityOperations += Object.keys(valueRecord.continuityOperations ?? {}).length
        probe.executorBodies += valueRecord.continuityExecutors === undefined ? 0 : 1
      }
    `)
    if (process.env.AGENTMUX_HISTORY_SOURCE_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_HISTORY_SOURCE_LOADED, JSON.stringify({ path,
        originalSHA256: hash(source), loadedSHA256: hash(code), mutation: mutation ?? null }) + '\n')
    }
    return { code, map: null }
  }
}], test: { ...original.test, globalSetup: [], include: ['packages/core/test/history-source-projection.test.ts'],
  passWithNoTests: false, fileParallelism: false, testTimeout: 15000 } })
