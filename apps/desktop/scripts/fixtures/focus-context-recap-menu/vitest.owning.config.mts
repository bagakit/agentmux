import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const row = 'apps/desktop/src/renderer/src/components/FocusContextRow.tsx'
const menu = 'apps/desktop/src/renderer/src/components/FocusContextMenu.tsx'
const projection = 'apps/desktop/src/renderer/src/lib/focus-context.ts'
const mutations = {
  'drop-recap': [row, "const recap = context.bucket !== 'attention' && context.state !== 'disconnected' ? context.recap : null", 'const recap = null'],
  'cover-critical': [row, "const recap = context.bucket !== 'attention' && context.state !== 'disconnected' ? context.recap : null", 'const recap = context.recap'],
  'wrong-session': [menu, 'agentRosterMenuActions({ sessionId,', 'agentRosterMenuActions({ sessionId: useAppStore.getState().sessions[0]!.id,'],
  'discard-new-prompt': [projection, "const detailIsRecap = Boolean(detailIsMessage && recap && latest?.content?.trim()\n    && latest.kind === (recap.source === 'Last assistant message' ? 'assistant_message' : 'user_message'))", 'const detailIsRecap = detailIsMessage'],
  'hide-retained-result': [row, "const recap = context.bucket !== 'attention' && context.state !== 'disconnected' ? context.recap : null", "const recap = context.bucket !== 'attention' && context.state !== 'disconnected' && context.processState === 'running' ? context.recap : null"],
  'hide-service-explanation': [projection, '          next.detailIsRecap = false', '          // Loaded old dedup flag: the service explanation is silently suppressed.']
} as const
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.tmp/focus-context-recap-menu-cache'), plugins: [...original.plugins ?? [], {
  name: 'actual-loaded-focus-context-recap-menu', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    if (!path.startsWith(root + '/apps/desktop/src/')) return
    const key = process.env.AGENTMUX_FOCUS_RECAP_MUTATION as keyof typeof mutations | undefined
    let code = source
    if (key) {
      const rule = mutations[key]; assert.ok(rule, 'Known loaded semantic mutation')
      if (path === resolve(root, rule[0])) {
        assert.equal(source.split(rule[1]).length - 1, 1, 'Exact nonempty loaded product anchor')
        code = source.replace(rule[1], rule[2])
      }
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_FOCUS_RECAP_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_RECAP_LOADED, JSON.stringify({ path: relative(root, path), sourceSHA256: hash(source), loadedSHA256: hash(code), mutated: code !== source, ...(code !== source ? { mutation: key } : {}) }) + '\n')
    if (code !== source) return { code, map: null }
  }
}], test: { ...original.test, include: ['apps/desktop/test/focus-context-recap-menu.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15000 } })
