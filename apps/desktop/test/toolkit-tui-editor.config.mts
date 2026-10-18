import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import base from '../scripts/fixtures/settings-overview/vitest.config.mts'
const editor = 'apps/desktop/src/renderer/src/components/settings/ToolkitToolEditor.tsx'
const picker = 'apps/desktop/src/renderer/src/components/toolkit/ToolkitIconPicker.tsx'
const edits = {
  'icon-edit': { file: picker, before: 'onChange={() => onChange(option.value)}', after: 'onChange={() => undefined}' },
  'icon-label': { file: picker, before: '<span>Icon</span>', after: '<span></span>' },
  'display-presence': { file: editor, before: '...(tool.display ? { display: null } : {})', after: 'display: null' },
  'variable-colors': { file: 'apps/desktop/src/renderer/src/lib/monaco-theme.ts', before: "{ token: 'variable', foreground: c.info.slice(1) }, { token: 'variable.predefined', foreground: c.info.slice(1) },", after: '' }
} as const
const mutation = process.env.AGENTMUX_TOOLKIT_EDITOR_MUTATION
assert.ok(!mutation || Object.hasOwn(edits, mutation), 'Known Toolkit editor mutation')
const edit = mutation ? edits[mutation as keyof typeof edits] : null
export default { ...base, resolve: { ...base.resolve, conditions: ['browser', 'module', 'development|production'] }, esbuild: { jsx: 'automatic' as const },
  plugins: [{ name: 'actual-toolkit-icon-consumer', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(base.root!, id.split('?')[0]!)
    if (!Object.values(edits).some(edit => edit.file === file)) return
    let loaded = source
    if (edit?.file === file) { assert.equal(source.split(edit.before).length, 2, 'Unique editor mutation anchor'); loaded = source.replace(edit.before, edit.after) }
    const receipt = process.env.AGENTMUX_TOOLKIT_EDITOR_RECEIPT
    if (receipt) appendFileSync(receipt, JSON.stringify({ file, mutation, sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex') }) + '\n')
    return { code: loaded, map: null }
  } }], test: { ...base.test, passWithNoTests: false, include: ['apps/desktop/test/toolkit-custom-identity.test.tsx', 'apps/desktop/test/monaco-theme.test.ts'] }
}
