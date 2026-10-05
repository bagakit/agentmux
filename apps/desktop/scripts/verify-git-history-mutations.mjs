import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const main = 'packages/git/src/git-repository.ts'
const preload = 'apps/desktop/src/preload/index.ts'
const hook = 'apps/desktop/src/renderer/src/features/git/history/useGitHistory.ts'
const panel = 'apps/desktop/src/renderer/src/features/git/history/GitHistoryPanel.tsx'

// Import is the router's execution boundary, just like its other owned scopes.
await verifyRendererSourceMutations({
  name: 'git-history-mutations',
  tests: ['apps/desktop/test/git-history.test.ts', 'apps/desktop/test/git-history-ipc.test.ts', 'apps/desktop/test/git-history-panel.test.tsx'],
  sources: [main, preload, hook, panel],
  mutations: [
    { label: 'remote-roots', file: main,
      before: "refs.filter(ref => ref.kind !== 'tag').map(ref => ref.oid)",
      after: "refs.filter(ref => ref.kind === 'local' || ref.kind === 'head').map(ref => ref.oid)" },
    { label: 'tag-only-roots', file: main,
      before: "refs.filter(ref => ref.kind !== 'tag').map(ref => ref.oid)",
      after: 'refs.map(ref => ref.oid)' },
    { label: 'complete-merge-parents', file: main,
      before: "header.filter(line => line.startsWith('parent ')).map(line => line.slice(7))",
      after: "header.filter(line => line.startsWith('parent ')).map(line => line.slice(7)).slice(0, 1)" },
    { label: 'fixed-root-input', file: main,
      before: "snapshot.roots.join('\\n') + '\\n'",
      after: "'HEAD\\n'" },
    { label: 'page-offset', file: main,
      before: 'offset: offset + commits.length', after: 'offset: offset' },
    { label: 'preload-main-channel', file: preload,
      before: "ipcRenderer.invoke('git:history', workspaceId, input)",
      after: "ipcRenderer.invoke('git:status', workspaceId, input)" },
    { label: 'stale-hidden-scope', file: hook,
      before: 'const current = () => generation.current === id && scope.current.enabled &&\n      scope.current.key === key && scope.current.reference === reference',
      after: 'const current = () => true' },
    { label: 'loaded-page-append', file: hook,
      before: 'const commits = [...previous.result.commits, ...next.commits]',
      after: 'const commits = next.commits' },
    { label: 'svg-all-parent-edges', file: panel,
      before: '{commit.parents.map(parent => <path',
      after: '{commit.parents.slice(0, 1).map(parent => <path' },
    { label: 'disconnected-root-edge', file: panel,
      before: '{continued && row > 0 && <path',
      after: '{row > 0 && <path' }
  ]
})
