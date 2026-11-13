import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useState } from 'react'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { GitCommitDetails } from '../../../src/renderer/src/features/git/commit/GitCommitDetails'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { GitCommitDetailsResult } from '../../../src/shared/git-contracts'
import '../../../src/renderer/src/styles/index.css'

// The real commit details in a private document. The commit is preview data; reading it from Git and
// the virtual list's mounting rules are proved by git-commit-workbench.test.tsx.
type Ready = Extract<GitCommitDetailsResult, { kind: 'ready' }>
const oid = '7c3e9f1a2b4d6e8f0a1b3c5d7e9f1a2b4c6d8e0f', parent = '1f2e3d4c5b6a79880716253443526170819a2b3c'
const scene = new URLSearchParams(location.search).get('scene')
const entries: Ready['entries'] = scene === 'small'
  ? [{ path: 'src/renderer/features/git/ChangedFileList.tsx', origPath: null, change: 'added' },
     { path: 'src/renderer/features/git/commit/GitCommitDetails.tsx', origPath: null, change: 'modified' },
     { path: 'src/renderer/styles/git-workbench.css', origPath: null, change: 'modified' },
     // Long folders and a deep rename: at a narrow width the name must stay readable before either path.
     { path: 'packages/client-ui/src/components/conversation/threads/MoteConversationThreadList.tsx', origPath: null, change: 'modified' },
     { path: 'apps/desktop/src/renderer/src/features/git/history/GitHistoryReferencePicker.tsx',
       origPath: 'apps/desktop/src/renderer/src/components/git/history/RefPicker.tsx', change: 'renamed' }]
  : [...Array.from({ length: 5000 }, (_, index) => ({ path: `assets/icons/${['action', 'state', 'object', 'brand'][index % 4]}/glyph-${String(index).padStart(4, '0')}.svg`,
      origPath: null, change: (index % 7 === 0 ? 'modified' : 'added') as Ready['entries'][number]['change'] })),
     { path: 'src/renderer/features/git/ChangedFileList.tsx', origPath: 'src/renderer/features/git/FileList.tsx', change: 'renamed' }]
const result: Ready = { kind: 'ready', snapshot: { hostId: 'local', repoPath: '/preview/repo', commitOid: oid, parentOid: parent },
  commit: { oid, parents: [parent], subject: 'feat(icons): import the complete glyph set',
    message: 'feat(icons): import the complete glyph set\n\nEvery glyph ships as its own SVG so the build can tree-shake unused ones.',
    author: 'Preview Author', authorEmail: '', committer: 'Preview Author', authoredAt: Date.UTC(2026, 9, 12, 9, 30), committedAt: Date.UTC(2026, 9, 12, 9, 30), refs: [] },
  entries, warnings: [] }

function Scene() {
  const [selectedPath, setSelectedPath] = useState<string | undefined>(entries[2]?.path)
  return <div className="git-workbench" style={{ flex: 1 }}>
    <GitCommitDetails regionId="preview" selection={{ commitOid: oid, parentOid: parent }} result={result} loading={false} error={null}
      onReload={() => {}} onSelectParent={() => {}} onSelectFile={file => setSelectedPath(file.path)} selectedPath={selectedPath} />
  </div>
}

const config = { terminalTheme: 'graphite' as const, appAppearance: 'dark' as const }
mountThemeRuntime(window, config)
Object.assign(window, { changedFileListVisual: { appearance: (appAppearance: 'dark' | 'light') => updateThemeSelection({ ...config, appAppearance }) } })
flushSync(() => createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><Scene /></DesktopClientUiProvider>))
