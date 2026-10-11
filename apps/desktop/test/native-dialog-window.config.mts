import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'

const mutation = process.env.NATIVE_DIALOG_MUTATION
const root = resolve(import.meta.dirname, '../../..')
const mutants: Record<string, { path: string; before: string; after: string }> = {
  'wrong-native-parent': { path: '/apps/desktop/src/main/ipc.ts', before: 'args.workbenchWindows.windowForDocument(scope)', after: 'args.window' },
  'drop-preload-scope': { path: '/apps/desktop/src/preload/index.ts', before: "ipcRenderer.invoke('ui:exportTheme', document, window)", after: "ipcRenderer.invoke('ui:exportTheme', document)" },
  'drop-renderer-scope': { path: '/apps/desktop/src/renderer/src/components/settings/ThemeLibrary.tsx',
    before: 'api.ui.exportTheme({ id: selected.id, ...selected.value }, dialogDocument)', after: 'api.ui.exportTheme({ id: selected.id, ...selected.value })' },
  'drop-composer-scope': { path: '/apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
    before: 'api.ui.chooseFiles(workspacePath ? { defaultPath: workspacePath } : undefined, dialogDocument)',
    after: 'api.ui.chooseFiles(workspacePath ? { defaultPath: workspacePath } : undefined)' }
}
if (mutation) assert.ok(mutation in mutants, 'Unknown native dialog source mutation')
export default defineConfig({ ...original, define: { ...original.define, __AGENTMUX_WEB_PREVIEW__: 'false' },
  resolve: { conditions: ['browser', 'module', 'import'] },
  plugins: [{ name: 'actual-native-dialog-owner-mutation', enforce: 'pre', transform(source, id) {
    if (!mutation) return
    const mutant = mutants[mutation]!, file = id.split('?')[0]!
    if (!file.endsWith(mutant.path)) return
    const hits = source.split(mutant.before).length - 1
    assert.equal(hits, mutation === 'wrong-native-parent' ? 5 : 1, 'Actual loaded owner/forwarding mutation must have its exact bounded hit count')
    const changed = source.replaceAll(mutant.before, mutant.after)
    if (process.env.NATIVE_DIALOG_MUTATION_HIT) {
      const hitFile = resolve(root, process.env.NATIVE_DIALOG_MUTATION_HIT)
      const snapshots = join(dirname(hitFile), 'sources')
      mkdirSync(snapshots, { recursive: true })
      const disk = readFileSync(file, 'utf8')
      const diskFile = join(snapshots, `${mutation}.disk.txt`), loadedFile = join(snapshots, `${mutation}.loaded.txt`), changedFile = join(snapshots, `${mutation}.changed.txt`)
      writeFileSync(diskFile, disk); writeFileSync(loadedFile, source); writeFileSync(changedFile, changed)
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(hitFile, JSON.stringify({ mutation, file: relative(root, file), hits, sourceSHA: hash(disk), loadedSHA: hash(source), changedSHA: hash(changed),
        diskFile: relative(root, diskFile), loadedFile: relative(root, loadedFile), changedFile: relative(root, changedFile), productionWritten: false,
        before: mutant.before, after: mutant.after }) + '\n')
    }
    return changed
  } }],
  test: { ...original.test, include: ['apps/desktop/test/native-dialog-window.test.tsx'], passWithNoTests: false,
    environment: 'happy-dom', maxWorkers: 1, testTimeout: 20000, hookTimeout: 20000, server: { deps: { inline: [/@radix-ui\//] } } }
})
