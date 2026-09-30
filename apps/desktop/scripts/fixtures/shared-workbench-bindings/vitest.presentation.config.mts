import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../../../../..')
const mutations = {
  'wrong-tab-content-slot': ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
    'id={workbenchProjectionSlotId(effectiveViewHostPrefix, reference)}',
    "id={workbenchProjectionSlotId(effectiveViewHostPrefix, { ...reference, groupId: 'wrong-group' })}"],
  'restore-tab-group-chrome': ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
    "if (viewOwnership === 'projection' && projection?.entity.kind === 'tab') {",
    'if (false) {'],
  'drop-presentation-context': ['apps/desktop/src/renderer/src/App.tsx',
    "headerPortalTargetId: 'focus-workspace-slot-header', projection: focusProjection, reference,",
    "headerPortalTargetId: 'focus-workspace-slot-header',"],
  'first-occurrence': ['apps/desktop/src/renderer/src/lib/focus-tab-projection.ts',
    'const reference = execution.reference ?? (choices.length === 1 ? choices[0] : undefined)',
    'const reference = choices[0]'],
  'discard-reference': ['apps/desktop/src/renderer/src/store.ts',
    'reference && confirmedFocusReference(state, sessionId, reference) ? reference : undefined', 'undefined'],
  'wrong-group': ['apps/desktop/src/renderer/src/lib/focus-tab-projection.ts',
    'selection: [reference], onSelect',
    'selection: [choices.find(choice => choice.tabId === reference.tabId && choice.groupId !== reference.groupId) ?? reference], onSelect']
} as const
export default defineConfig({ ...original, root,
  plugins: [...(original.plugins ?? []), {
    name: 'loaded-shared-workbench-presentation-caller', enforce: 'pre',
    transform(source, id) {
      const path = id.split('?')[0]!
      if (!path.startsWith(root + '/apps/desktop/src/')) return
      const mutation = process.env.AGENTMUX_BINDING_PRESENTATION_MUTATION as keyof typeof mutations | undefined
      let code = source
      if (mutation) {
        const change = mutations[mutation]
        assert.ok(change, 'Known presentation semantic mutation')
        if (path === resolve(root, change[0])) {
          assert.equal(source.split(change[1]).length - 1, 1, `Unique loaded ${mutation} anchor`)
          code = source.replace(change[1], change[2])
        }
      }
      if (process.env.AGENTMUX_BINDING_PRESENTATION_LOADED) appendFileSync(process.env.AGENTMUX_BINDING_PRESENTATION_LOADED,
        JSON.stringify({ path: relative(root, path), sourceSHA256: createHash('sha256').update(source).digest('hex'),
          loadedSHA256: createHash('sha256').update(code).digest('hex'), mutated: code !== source,
          ...(code !== source ? { mutation } : {}) }) + '\n')
      if (code !== source) return { code, map: null }
    }
  }],
  cacheDir: resolve(root, '.tmp/shared-workbench-presentation-cache'),
  test: { ...original.test, include: ['apps/desktop/test/shared-workbench-presentation.test.tsx'],
    fileParallelism: false, passWithNoTests: false, maxWorkers: 1, testTimeout: 15_000 }
})
