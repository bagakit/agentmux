import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import base from '../scripts/fixtures/settings-overview/vitest.config.mts'

const mutations = {
  admission: { file: 'apps/desktop/src/shared/toolkit-preferences.ts', before: 'TOOLKIT_ICON_OPTIONS.map(option => option.value)', after: "TOOLKIT_ICON_OPTIONS.map(option => option.value).filter(value => value !== 'hard-drive')" },
  semantic: { file: 'apps/desktop/src/renderer/src/components/toolkit/ToolkitIcon.tsx', before: 'name={option.semanticId}', after: 'name="toolkit.terminal"' },
  search: { file: 'apps/desktop/src/renderer/src/components/toolkit/ToolkitIconPicker.tsx', before: '${option.keywords}', after: '' }
} as const
const mutation = process.env.AGENTMUX_TOOLKIT_ICONS_MUTATION
assert.ok(!mutation || Object.hasOwn(mutations, mutation), 'Known Toolkit icon mutation')
const selected = mutation ? mutations[mutation as keyof typeof mutations] : undefined
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

export default {
  ...base,
  resolve: { ...base.resolve, conditions: ['browser', 'module', 'development|production'] },
  esbuild: { jsx: 'automatic' as const },
  plugins: [{ name: 'toolkit-icons-consumed-source', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(base.root!, id.split('?')[0]!)
    if (!file.startsWith('packages/') && !file.startsWith('apps/desktop/src/')) return
    let consumed = source
    if (file === selected?.file) {
      assert.equal(source.split(selected.before).length - 1, 1, 'One exact production mutation anchor')
      consumed = source.replace(selected.before, selected.after)
    }
    const receipt = process.env.AGENTMUX_TOOLKIT_ICONS_RECEIPT
    if (receipt) appendFileSync(receipt, JSON.stringify({ file, mutation: consumed === source ? null : mutation,
      fileSHA256: hash(readFileSync(id.split('?')[0]!, 'utf8')), sourceSHA256: hash(source), consumedSHA256: hash(consumed) }) + '\n')
    return consumed === source ? undefined : { code: consumed, map: null }
  } }],
  test: { ...base.test, maxWorkers: 1, fileParallelism: false, passWithNoTests: false, include: [
    'apps/desktop/test/toolkit-icons.test.tsx', 'apps/desktop/test/toolkit-icons-config.test.ts',
    'apps/desktop/test/toolkit-custom-identity.test.tsx', 'apps/desktop/test/toolkit-editor-icon-meaning.test.tsx'
  ] }
}
