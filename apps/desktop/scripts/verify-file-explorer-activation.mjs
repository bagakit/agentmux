import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..'), base = 'apps/desktop/src/renderer/src/'
const fileOwner = base + 'lib/file-workbench-state.ts'
const explorer = base + 'components/FileExplorer.tsx', store = base + 'store.ts', focus = base + 'lib/region-focus.ts'
async function files(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []))).flat()
}
const scanned = await files(base)
assert.ok(scanned.length > 0)
const source = await Promise.all(scanned.map(async path => ({ path, code: await readFile(join(root, path), 'utf8') })))
const callers = source.filter(item => item.path !== store && /state\.openFileAndReveal/.test(item.code)).map(item => item.path)
const consumers = source.filter(item => item.path !== explorer && /<FileExplorer[\s/>]/.test(item.code)).map(item => item.path)
assert.ok(callers.length > 0); assert.ok(consumers.length > 0)
await verifyRendererSourceMutations({ name: 'file-explorer-activation',
  tests: ['apps/desktop/test/file-explorer-activation.test.tsx'],
  sources: [explorer, store, focus, fileOwner, 'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/file-tree-geometry.ts'],
  mutations: [
    { label: 'filename-activation', file: explorer, before: 'if (event.detail < 2) onClick(event)', after: 'if (event.detail < 2) onSelect(event)' },
    { label: 'visible-workbench', file: store, before: "set({ activeWorkspaceId: workspaceId, mainSurface: 'workbench' })\n    const request = get().regionCaretFocus", after: 'const request = get().regionCaretFocus' },
    { label: 'original-file-region', file: store, before: 'const tab = original?.tab, surface = original?.surface\n    const groupId = tab && tabGroupForTab(layout, tab.id)', after: 'const tab = original?.tab, surface = Object.values(tab?.regions ?? {}).find(region => region.regionId !== original?.surface.regionId) ?? original?.surface\n    const groupId = tab && tabGroupForTab(layout, tab.id)'  },
    { label: 'actual-input-focus', file: focus, before: "return cause === 'keyboard' || cause === 'navigation'", after: "return cause === 'keyboard'" },
    { label: 'rename-cancels-late-reveal', file: explorer, before: `function beginRename(node: TreeNode): void {
    fileRevealRef.current?.abort()
    if (!workspaceId || editSubmissionRef.current || !canRenameFileExplorerNode(workspaceId, node)) return
    setSelection(createSingleFileExplorerSelection(node.path))`, after: `function beginRename(node: TreeNode): void {
    if (!workspaceId || editSubmissionRef.current || !canRenameFileExplorerNode(workspaceId, node)) return
    setSelection(createSingleFileExplorerSelection(node.path), false)` },
    { label: 'create-cancels-old-reveal', file: explorer, before: "function beginCreate(kind: 'create-file' | 'create-directory', targetParent = createParent): void {\n    fileRevealRef.current?.abort()", after: "function beginCreate(kind: 'create-file' | 'create-directory', targetParent = createParent): void {" },
    { label: 'selection-cancels-old-reveal', file: explorer, before: 'if (cancelPendingReveal) fileRevealRef.current?.abort()', after: 'void cancelPendingReveal' },
    { label: 'create-navigation-roundtrip', file: explorer, before: 'if (fileNavigationSelection(state) !== navigation) navigationIntent?.abort()', after: 'void state' },
    { label: 'resource-rebind', file: store, before: "if (current?.hostId !== originalResource.hostId || current.path !== originalResource.path) {", after: 'if (false) {' },
    { label: 'promoted-file-reuse', file: fileOwner, before: 'const original = placement ? undefined : findFileWorkbenchSurface(state, workspaceId, path)', after: 'const original = undefined' },
    { label: 'first-workspace-layout', file: store, before: 'if (!navigation.layouts[workspaceId]) set(state => ({ layouts:', after: 'if (false) set(state => ({ layouts:' },
    { label: 'late-navigation', file: store, before: 'const mayReveal = await opening\n    const state = get(), currentResource', after: 'await opening; const mayReveal = true\n    const state = get(), currentResource' }
  ] })
function check(args) {
  const result = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config',
    'apps/desktop/scripts/fixtures/file-explorer-activation/vitest.config.mts', ...args, '--maxWorkers=1'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' } })
  process.stdout.write(result.stdout + result.stderr); assert.equal(result.status, 0)
}
check(['apps/desktop/test/explorer-redesign.test.tsx', 'apps/desktop/test/explorer-editing-polish.test.tsx',
  'apps/desktop/test/workface-explorer-scope.test.tsx', 'apps/desktop/test/region-caret-focus.test.ts'])
check(['apps/desktop/test/workface-file-open-control.test.tsx', '--testNamePattern', 'reuses the canonical File|explicit focus chooses'])
console.log(JSON.stringify({ passed: true, callers, consumers, mutations: 12 }))
