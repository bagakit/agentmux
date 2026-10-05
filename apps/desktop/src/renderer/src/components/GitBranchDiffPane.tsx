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
  const release = useAppStore((state) => state.releaseBranchDiff)
  const wordWrap = useAppStore((state) => state.editorWordWrap)
  const toggleWordWrap = useAppStore((state) => state.toggleEditorWordWrap)
  const theme = useMonacoTheme()
  useEffect(() => {
    // The durable descriptor is the only rebuild input. Hidden panes don't eagerly read every blob.
    // The existing budget releases the transient bytes as well as the Monaco owner.
    if (released) release(surface.regionId)
    else if (visible && !useAppStore.getState().editorRegionDiffs[surface.regionId]) void load(surface.regionId)
  }, [visible, released, surface.regionId, load, release])
  if (released) return <EditorReleasedState />
  const { file } = surface.comparison
  const commit = 'kind' in surface.comparison && surface.comparison.kind === 'commit' ? surface.comparison : null
  const branch = !commit ? surface.comparison as import('../../../shared/git-contracts').GitBranchDiffDescriptor : null
  const baseLabel = commit ? (commit.snapshot.parentOid ? 'Parent' : 'Empty tree')
    : branch!.snapshot.mode === 'merge-base' ? 'Merge base' : branch!.snapshot.baseBranch
  const targetLabel = commit ? 'Commit' : branch!.snapshot.targetBranch
  const baseOid = commit ? commit.snapshot.parentOid : branch!.snapshot.comparisonBaseOid
  const targetOid = commit ? commit.snapshot.commitOid : branch!.snapshot.targetOid
  return (
    <section className="editor-pane git-branch-diff" data-git-diff-region={surface.regionId}>
      <header className="editor-header">
        <span title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}>
          {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
        </span>
        <div className="editor-header__actions">
          <button className="small-button" aria-label="Toggle diff word wrap" aria-pressed={wordWrap} title="Toggle word wrap (Alt+Z)" onClick={toggleWordWrap}>
            <WrapText size={13} /><span className="editor-header__label">Wrap</span>
          </button>
          <button className="small-button" aria-label="Reload fixed diff" disabled={Boolean(diff?.loading)} title="Reread these fixed commits" onClick={() => void load(surface.regionId)}>
            <RefreshCw size={13} /><span className="editor-header__label">{diff?.loading ? 'Loading…' : 'Reload'}</span>
          </button>
        </div>
      </header>
      <div className="git-branch-diff__commits" aria-label="Fixed comparison commits">
        <span title={`${baseLabel}: ${baseOid ?? "no parent"}`}>{baseLabel}{baseOid ? ` · ${baseOid.slice(0, 8)}` : ""}</span>
        <span title={`${targetLabel}: ${targetOid}`}>{targetLabel} · {targetOid.slice(0, 8)}</span>
      </div>
      {diff?.error && diff.diff ? <div className="branches-inline-error" role="alert">{diff.error}</div> : null}
      <div className="git-branch-diff__canvas">
        <GitDiffCanvas diff={diff} wordWrap={wordWrap} language={detectLanguage(file.path)} theme={theme} />
      </div>
    </section>
  )
}
