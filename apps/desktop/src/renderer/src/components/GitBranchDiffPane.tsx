import { RefreshCw, WrapText } from 'lucide-react'
import { useEffect } from 'react'
import { useMonacoTheme } from '../hooks/useMonacoTheme'
import { detectLanguage } from '../lib/language-detect'
import type { GitDiffWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { EditorReleasedState } from './EditorReleasedState'
import { GitDiffCanvas } from './GitDiffCanvas'

export function GitBranchDiffPane({ surface, released = false, visible = true }: {
  surface: GitDiffWorkbenchSurface
  released?: boolean
  visible?: boolean
}) {
  const diff = useAppStore((state) => state.editorRegionDiffs[surface.regionId])
  const load = useAppStore((state) => state.loadBranchDiff)
  const wordWrap = useAppStore((state) => state.editorWordWrap)
  const toggleWordWrap = useAppStore((state) => state.toggleEditorWordWrap)
  const theme = useMonacoTheme()
  useEffect(() => {
    // The durable descriptor is the only rebuild input. Hidden panes don't eagerly read every blob.
    if (visible && !released && !useAppStore.getState().editorRegionDiffs[surface.regionId]) void load(surface.regionId)
  }, [visible, released, surface.regionId, load])
  if (released) return <EditorReleasedState />
  const { snapshot, file } = surface.comparison
  const baseLabel = snapshot.mode === 'merge-base' ? `Merge base of ${snapshot.baseBranch} and ${snapshot.targetBranch}` : snapshot.baseBranch
  return (
    <section className="editor-pane git-branch-diff" data-git-diff-region={surface.regionId}>
      <header className="editor-header">
        <span title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}>
          {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
        </span>
        <div className="editor-header__actions">
          <button className="small-button" aria-pressed={wordWrap} title="Toggle word wrap (Alt+Z)" onClick={toggleWordWrap}>
            <WrapText size={13} /> Wrap
          </button>
          <button className="small-button" disabled={Boolean(diff?.loading)} title="Reread these fixed commits" onClick={() => void load(surface.regionId)}>
            <RefreshCw size={13} /> {diff?.loading ? 'Loading…' : 'Reload'}
          </button>
        </div>
      </header>
      <div className="git-branch-diff__commits" aria-label="Fixed comparison commits">
        <span title={`${baseLabel}: ${snapshot.comparisonBaseOid}`}>{baseLabel} · {snapshot.comparisonBaseOid.slice(0, 8)}</span>
        <span title={`${snapshot.targetBranch}: ${snapshot.targetOid}`}>{snapshot.targetBranch} · {snapshot.targetOid.slice(0, 8)}</span>
      </div>
      {diff?.error && diff.diff ? <div className="branches-inline-error" role="alert">{diff.error}</div> : null}
      <GitDiffCanvas diff={diff} wordWrap={wordWrap} language={detectLanguage(file.path)} theme={theme} />
    </section>
  )
}
