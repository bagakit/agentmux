import base from './vitest.conversation-unified.config.mts'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
const changes: Record<string, [string, string]> = {
  'delete-parked-view': ['view.observers--; this.trimParked()', 'view.observers--; this.views.delete(view.id); this.trimParked()'],
  'lose-newer-position': ["newer: complete ? historyCursor(navigation.newer, 'newer') : null", 'newer: null'],
  'follow-anchored-view': ["if (mode === 'changes' && view.anchor)", "if (false && mode === 'changes' && view.anchor)"],
  'ignore-retained-head-version': ['!sizes.has(row.id) || records.get(row.id)?.revision !== row.revision', '!sizes.has(row.id)']
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-window-navigation', plugins: [...base.plugins ?? [], {
  name: 'navigation-source-mutations', enforce: 'pre', transform(source, id) {
    const mutation = process.env.AGENTMUX_NAVIGATION_MUTATION
    if (!mutation || !id.endsWith('/packages/core/src/conversation-reader.ts')) return
    const change = changes[mutation]
    if (!change || source.split(change[0]).length !== 2) throw Error('Missing unique navigation mutation anchor: ' + mutation)
    const code = source.replace(...change), sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_NAVIGATION_LOADED) appendFileSync(process.env.AGENTMUX_NAVIGATION_LOADED,
      JSON.stringify({ path: 'packages/core/src/conversation-reader.ts', mutation, originalSHA256: sha(source), sha256: sha(code) }) + '\n')
    return { code, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/conversation-window-navigation.test.ts'], passWithNoTests: false } })
