import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const component = name => `apps/desktop/src/renderer/src/components/${name}.tsx`
const group = component('ProjectGroupDialog'), category = component('TopicCategoryDialog'), mote = component('MoteRenameDialog')
const tests = ['apps/desktop/test/form-dialog-craft.test.tsx']
const mutations = [
  { label: 'retry-inferred-from-error-copy', file: group, before: "unconfirmed ? 'Retry saving'", after: "failure?.startsWith('Group applied.') ? 'Retry saving'" },
  { label: 'group-focus-not-returned', file: group, before: 'original.focus({ preventScroll: true })', after: 'void original' },
  { label: 'category-ime-submits', file: category, before: "event.key === 'Enter' && isImeOwnedKeyboardEvent(event.nativeEvent)", after: 'false' },
  { label: 'group-primary-action-lost', file: group, before: '<Button type="submit" variant="primary"', after: '<Button type="submit" variant="secondary"' }
]
const sources = [group, category, mote, component('HostFolderDialog'), 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
  'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/vitest.ui-controls-owning.config.mts', 'packages/capsule/package.json',
  'test/fixture-values.mjs', 'test/fixture-epoch.cjs']
const evidenceRoot = process.env.AGENTMUX_EVIDENCE_ROOT ?? join(root, '.tmp/form-dialog-craft')
const name = 'mutations-' + randomUUID()
await verifyRendererSourceMutations({ name, evidenceRoot, owningConfig: 'apps/desktop/test/form-dialog-craft-consumers.config.mts', tests, sources, mutations })
const receipt = join(evidenceRoot, name, 'receipt.json')
const proof = JSON.parse(await readFile(receipt, 'utf8'))
assert.equal(proof.passed, true); assert.equal(proof.cases.length, mutations.length)
console.log(JSON.stringify({ passed: true, receipt, mutants: mutations.length }))
