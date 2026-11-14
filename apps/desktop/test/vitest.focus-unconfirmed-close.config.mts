import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import base from './vitest.workbench-close.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'broaden-focus-close': ['apps/desktop/src/renderer/src/hooks/useSourceWorkbenchClose.tsx', '      value.onlyMember && record.plan.projection.surfaces.length !== 1 ||', ''],
  'failure-done': ['apps/desktop/src/renderer/src/hooks/useSourceWorkbenchClose.tsx', '      if (value.issue) finish(false)', '      // Test mutation: failed position lookup cannot dismiss.'],
  'first-position': ['apps/desktop/src/renderer/src/hooks/useSourceWorkbenchClose.tsx', 'value.choices.locations.find(location => choiceKey(location) === value.selected)', 'value.choices.locations[0]'],
  'recovered-member': ['apps/desktop/src/renderer/src/hooks/useSourceWorkbenchClose.tsx', '      accept(value, operation)', '      // Test mutation: recovered member check removed.'],
  'region-scope': ['apps/desktop/src/main/source-workbench-close.ts', "kind: member.scope === 'region' ? 'region' : 'tab-occurrence'", "kind: 'tab-occurrence'"],
  'original-draft': ['apps/desktop/src/renderer/src/lib/workbench-close-owner.ts', '  if (plan.closesView) {', '  if (false) {']
}
const mutation = process.env.AGENTMUX_SOURCE_CLOSE_MUTATION
if (mutation) assert.ok(mutations[mutation], 'Known actual Source close mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/source-close-cache-' + (mutation ?? 'baseline')),
  plugins: [...base.plugins ?? [], { name: 'actual-source-close-consumer-mutation', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!Object.values(mutations).some(([target]) => target === path)) return
    let code = original
    if (mutation) { const [target, from, to] = mutations[mutation]!; if (path === target) { assert.equal(code.split(from).length - 1, 1, 'Unique production anchor'); code = code.replace(from, to) } }
    if (process.env.AGENTMUX_SOURCE_CLOSE_LOADED) appendFileSync(process.env.AGENTMUX_SOURCE_CLOSE_LOADED, JSON.stringify({ path, mutation: code !== original ? mutation : null,
      originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    if (code !== original) return { code, map: null }
  } }], test: { ...base.test, passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
