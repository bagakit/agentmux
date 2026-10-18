import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import base from '../scripts/fixtures/settings-overview/vitest.config.mts'

const directoryField = 'apps/desktop/src/renderer/src/components/settings/ToolkitWorkingDirectoryField.tsx'
const edits = {
  'late-picker': { file: directoryField, before: '!mounted.current || request !== selectionGeneration.current || selected === null', after: '!mounted.current || selected === null', occurrences: 1 },
  'unknown-home-blocks': { file: directoryField, before: "cause instanceof AgentMuxError && cause.code === 'INVALID_SETTING_VALUE'", after: 'cause instanceof AgentMuxError', occurrences: 1 },
  'host-field-lost': { file: 'apps/desktop/src/renderer/src/components/settings/use-toolkit-drafts.ts', before: "errorField: cause instanceof AgentMuxError && cause.detail === TOOLKIT_WORKSPACE_PATH_ERROR_DETAIL ? 'workspacePath' : null", after: 'errorField: null', occurrences: 1 },
  'empty-default': { file: 'apps/desktop/src/renderer/src/components/settings/ToolkitSettingsPane.tsx', before: 'workspacePath: DEFAULT_TOOLKIT_WORKSPACE_PATH', after: "workspacePath: ''", occurrences: 2 }
} as const
const mutation = process.env.AGENTMUX_TOOLKIT_DIRECTORY_UI_MUTATION
assert.ok(!mutation || Object.hasOwn(edits, mutation), 'Known working directory UI mutation')
const selected = mutation ? edits[mutation as keyof typeof edits] : undefined

export default {
  ...base,
  resolve: { ...base.resolve, conditions: ['browser', 'module', 'development|production'] },
  esbuild: { jsx: 'automatic' as const },
  plugins: [{ name: 'toolkit-directory-loaded-source', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(base.root!, id.split('?')[0]!)
    if (!Object.values(edits).some(edit => edit.file === file)) return
    let loaded = source
    if (file === selected?.file) {
      assert.equal(source.split(selected.before).length - 1, selected.occurrences, 'Exact production mutation anchors')
      loaded = source.replaceAll(selected.before, selected.after)
      process.stderr.write(`TOOLKIT_DIRECTORY_UI_MUTATION_APPLIED=${mutation}\n`)
    }
    const receipt = process.env.AGENTMUX_TOOLKIT_DIRECTORY_UI_RECEIPT
    if (receipt) appendFileSync(resolve(receipt), JSON.stringify({ file, mutation: loaded !== source ? mutation : null,
      sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex') }) + '\n')
    return { code: loaded, map: null }
  } }],
  test: { ...base.test, passWithNoTests: false, include: [
    'apps/desktop/test/toolkit-working-directory-ui.test.tsx',
    'apps/desktop/test/toolkit-custom-ui.test.tsx',
    'apps/desktop/test/toolkit-custom-drafts.test.tsx',
    'apps/desktop/test/toolkit-editor-icon-meaning.test.tsx',
    'apps/desktop/test/toolkit-package-ui.test.tsx',
    'apps/desktop/test/toolkit-tui-ui.test.tsx'
  ] }
}
