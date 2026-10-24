import base from './vitest.conversation-unified.config.mts'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
const changes: Record<string, [string, string]> = {
  'lose-absent-page-source': ['return { older: older.length ? Math.min(...older) : null, newer: newer.length ? Math.max(...newer) : null }', `
    const combined = present.map(page => ({ count: (page.native?.count ?? 0) + (page.captured?.count ?? 0),
      earlier: page.native?.earlier || page.captured?.earlier, newer: page.native?.newer || page.captured?.newer }))
    const first = combined.findIndex(page => page.count), last = combined.length - 1 - [...combined].reverse().findIndex(page => page.count)
    return { older: combined[last]!.earlier ? last : adjacent(last + 1, 1), newer: combined[first]!.newer ? first : adjacent(first - 1, -1) }
  `],
  'delete-parked-view': ['view.observers--; this.trimParked()', 'view.observers--; this.views.delete(view.id); this.trimParked()'],
  'lose-newer-position': ["newer: complete ? historyCursor(navigation.newer, 'newer') : null", 'newer: null'],
  'follow-anchored-view': ["if (mode === 'changes' && view.anchor)", "if (false && mode === 'changes' && view.anchor)"],
  'ignore-retained-head-version': ['!sizes.has(row.id) || records.get(row.id)?.revision !== row.revision', '!sizes.has(row.id)']
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-window-navigation', plugins: [...base.plugins ?? [], {
  name: 'navigation-source-mutations', enforce: 'pre', transform(source, id) {
    const mutation = process.env.AGENTMUX_NAVIGATION_MUTATION
    if (!id.endsWith('/packages/core/src/conversation-reader.ts')) return
    const change = mutation ? changes[mutation] : undefined
    if (mutation && (!change || source.split(change[0]).length !== 2)) throw Error('Missing unique navigation mutation anchor: ' + mutation)
    const code = change ? source.replace(...change) : source, sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_NAVIGATION_LOADED) appendFileSync(process.env.AGENTMUX_NAVIGATION_LOADED,
      JSON.stringify({ path: 'packages/core/src/conversation-reader.ts', mutation, originalSHA256: sha(source), sha256: sha(code) }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/conversation-window-navigation.test.ts'], passWithNoTests: false } })
