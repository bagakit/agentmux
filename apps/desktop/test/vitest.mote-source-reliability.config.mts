import { defineConfig } from 'vitest/config'
import original from './vitest.file-path-client.config.mts'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_TEST_MOTE_SOURCE_MUTATION
const edits: Record<string, { path: string; before: string; after: string }> = {
  'publish-default': { path: 'renderer/src/lib/source-files-workbench.ts', before: 'const original = ports.get().selections[workspaceId]\n    const owns',
    after: 'if (!ports.get().selections[workspaceId]) ports.set(state => ({ ...state, selections: { ...state.selections, [workspaceId]: input } })); const original = ports.get().selections[workspaceId]\n    const owns' },
  'discard-locator': { path: 'renderer/src/lib/source-files-workbench.ts', before: 'const observed = { ...input,', after: 'const observed = { ...input, locator: undefined,' },
  'substitute-main': { path: 'renderer/src/lib/source-files-discovery.ts', before: 'if (!input.locator ||', after: 'if (input.issue) return null; if (!input.locator ||' },
  'forget-pending': { path: 'renderer/src/lib/source-files-discovery.ts', before: 'Object.values(state.sourceFilesInputs.pending).some(request => sourceFilesWorkspaceMatches(request.workspace, workspace)) ||', after: '' },
  'merge-wrong-root': { path: 'renderer/src/lib/source-files-discovery.ts', before: 'Object.values(state.sourceFilesInputs.pending).some(request => sourceFilesWorkspaceMatches(request.workspace, workspace))', after: 'Object.values(state.sourceFilesInputs.pending).some(request => request.workspace.id === workspaceId)' },
  'hide-probe-issue': { path: 'renderer/src/components/SourceFilesAccess.tsx', before: "result?.status === 'unconfirmed' ? result.issue.message : ", after: '' },
  'rebind-scratch': { path: 'main/workspace-rebind.ts', before: "if (isScratchWorkspaceId(current.id)) throw new Error('The reserved Scratch resource keeps its original root. Open the original Mote or Topic directory without rebinding this container.')", after: '' },
  'offer-scratch': { path: 'renderer/src/components/FileExplorer.tsx', before: "workspace?.hostId === 'local' && !isScratchWorkspaceId(workspace.id) &&", after: "workspace?.hostId === 'local' &&" },
  'rewrite-reserved': { path: 'main/workspace-location.ts', before: "if (!next || next.hostId !== original.hostId || next.path !== original.path) throw new Error('The reserved Scratch resource keeps its original Host and root. Existing files, workfaces and Agent Sessions are retained.')", after: '' }
}
if (mutation && !edits[mutation]) throw new Error('Unknown Source reliability mutation: ' + mutation)

export default defineConfig({ ...original, plugins: [...original.plugins ?? [], {
  name: 'loaded-source-mote-reliability-counterexample', enforce: 'pre', transform(source, id) {
    const edit = mutation ? edits[mutation] : undefined
    if (!edit || relative(root, id.split('?')[0]!) !== 'apps/desktop/src/' + edit.path) return
    if (source.split(edit.before).length !== 2) throw new Error('Mutation must select exactly one loaded production expression: ' + mutation)
    return { code: source.replace(edit.before, edit.after), map: null }
  }
}], test: { ...original.test, include: ['apps/desktop/test/file-path-client-projection.test.ts', 'apps/desktop/test/workspace-rebind.test.ts',
  'apps/desktop/test/config-owner-interleaving.test.ts'], passWithNoTests: false, testTimeout: 60000 } })
