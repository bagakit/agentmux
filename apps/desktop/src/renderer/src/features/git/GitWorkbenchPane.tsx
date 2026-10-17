import { memo, useEffect, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { WorkspaceRecord } from '../../../../shared/contracts'
import type { GitWorkbenchSurface } from '../../lib/workbench-tabs'
import { detectLanguage } from '../../lib/language-detect'
import { useMonacoTheme } from '../../hooks/useMonacoTheme'
import { useAppStore } from '../../store'
import { EditorReleasedState } from '../../components/EditorReleasedState'
import { useGitHistoryReader, useSharedGitHistory } from './history/GitHistoryContext'
import { GitCommitDetails } from './commit/GitCommitDetails'
import { useGitCommitDetails } from './commit/useGitCommitDetails'
import { GitDiffCanvas } from './diff/GitDiffCanvas'

const ThemeGitCommitIcon = semanticIconComponent('git.commit')
const ThemeObjectHistoryIcon = semanticIconComponent('object.history')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeActionCloseIcon = semanticIconComponent('action.close')


type PaneProps = { surface: GitWorkbenchSurface; visible?: boolean; released?: boolean }
/** A durable Git Region keeps its exact saved resource, independently of the active sidebar. */
export const GitWorkbenchPane = memo(function GitWorkbenchPane({ surface, visible = true, released = false }: PaneProps) {
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === surface.workspaceId))
  if (!workspace || workspace.hostId !== surface.scope.hostId || workspace.path !== surface.scope.workspacePath) return <section className="pane-state" role="alert">
    <strong>Original Git workspace unavailable</strong><span>The saved repository and commit are retained. Restore the original workspace Host and path to read them.</span><code>{surface.scope.workspacePath}</code>
  </section>
  return surface.history ? <RepositoryReader surface={surface} workspace={workspace} visible={visible} released={released} />
    : <CommitView surface={surface} workspace={workspace} visible={visible} released={released} />
})
type ViewProps = { surface: GitWorkbenchSurface; workspace: WorkspaceRecord; visible: boolean; released: boolean }
function Header({ surface, workspace, children }: Pick<ViewProps, 'surface' | 'workspace'> & { children?: ReactNode }) {
  return <header className="git-workbench__header"><ThemeGitCommitIcon size={15} />
    <strong>{surface.selection ? `Commit ${surface.selection.commitOid.slice(0, 8)}` : 'Repository review'}</strong>
    <span title={surface.scope.repoPath}>{workspace.name}</span><span className="git-workbench__readonly">Read only</span>{children}
  </header>
}
function CommitView(props: ViewProps) {
  const openHistory = useAppStore(state => state.openGitHistory)
  const { surface, workspace } = props
  const shared = useSharedGitHistory(workspace)
  const reference = shared?.history.reference
  return <section className="git-workbench" data-git-workbench-region={surface.regionId} aria-label="Git commit details">
    <Header surface={surface} workspace={workspace}>
      <button className="small-button" aria-label="View repository history" onClick={() => openHistory(workspace.id, surface.scope, reference)}><ThemeObjectHistoryIcon size={13} /><span>History</span></button>
      {surface.selection && <button className="small-button" aria-label="Locate commit in history" onClick={() => openHistory(workspace.id, surface.scope, reference, { ...surface.scope, ...surface.selection! })}>Locate in history</button>}
    </Header>
    <CommitReview {...props} />
  </section>
}
function RepositoryReader(props: ViewProps) {
  const shared = useSharedGitHistory(props.workspace)
  const { surface, workspace, visible } = props
  const openHistory = useAppStore(state => state.openGitHistory)
  const selectReference = useAppStore(state => state.selectGitHistoryReference)
  const history = shared?.history
  useGitHistoryReader(shared, surface.regionId, workspace, 'repository', visible, surface.history?.reference ?? null)
  useEffect(() => {
    if (history?.repository?.hostId === surface.scope.hostId && history.repository.repoPath === surface.scope.repoPath) {
      selectReference(surface.regionId, history.reference)
    }
  }, [history?.repository?.hostId, history?.repository?.repoPath, history?.reference, surface.regionId, surface.scope.hostId, surface.scope.repoPath, selectReference])
  return <section className="git-workbench" data-git-workbench-region={surface.regionId} aria-label="Git repository review">
    <Header surface={surface} workspace={workspace}>
      <button className="small-button" aria-label="View repository history" onClick={() => openHistory(workspace.id, surface.scope, history ? history.reference : surface.history?.reference)}><ThemeObjectHistoryIcon size={13} /><span>History</span></button>
      {surface.selection && <button className="small-button" aria-label="Locate commit in history" onClick={() => openHistory(workspace.id, surface.scope, history ? history.reference : surface.history?.reference, { ...surface.scope, ...surface.selection! })}>Locate in history</button>}
    </Header>
    <CommitReview {...props} />
  </section>
}
function CommitReview({ surface, workspace, visible, released }: ViewProps) {
  const { read, reload } = useGitCommitDetails(workspace, surface.scope, surface.selection, visible)
  const select = useAppStore(state => state.selectGitCommit), selectFile = useAppStore(state => state.selectGitFile)
  const result = read?.result?.kind === 'ready' ? read.result : null
  return <div className={'git-workbench__review' + (surface.file ? ' git-workbench__review--diff' : '')}>
    <GitCommitDetails regionId={surface.regionId} selection={surface.selection} result={result}
      loading={Boolean(read?.loading)} error={read?.error ?? null} onReload={reload}
      onSelectParent={snapshot => select(surface.regionId, snapshot)} onSelectFile={file => selectFile(surface.regionId, { path: file.path, origPath: file.origPath })}
      {...(surface.file ? { selectedPath: surface.file.path } : {})} />
    {surface.file && surface.selection && <InlineCommitDiff surface={surface} visible={visible} released={released} />}
  </div>
}
function InlineCommitDiff({ surface, visible, released }: Required<Pick<PaneProps, 'surface' | 'visible' | 'released'>>) {
  const diff = useAppStore(state => state.editorRegionDiffs[surface.regionId])
  const load = useAppStore(state => state.loadBranchDiff), release = useAppStore(state => state.releaseBranchDiff)
  const selectFile = useAppStore(state => state.selectGitFile), openDiff = useAppStore(state => state.openBranchDiff)
  const wordWrap = useAppStore(state => state.editorWordWrap), theme = useMonacoTheme()
  const key = JSON.stringify([surface.scope, surface.selection, surface.file])
  useEffect(() => {
    if (released) release(surface.regionId)
    else if (visible && !useAppStore.getState().editorRegionDiffs[surface.regionId]) void load(surface.regionId)
  }, [key, visible, released, surface.regionId, load, release])
  const file = surface.file!, selection = surface.selection!
  return <section className="git-workbench__diff" aria-label="Commit file diff">
    <header className="editor-header"><span title={file.origPath ? file.origPath + ' → ' + file.path : file.path}>{file.path}</span>
      <div className="editor-header__actions">
        <button className="icon-button" aria-label="Reload fixed diff" title="Reload fixed diff" disabled={Boolean(diff?.loading)} onClick={() => void load(surface.regionId)}><ThemeActionRefreshIcon size={13} /></button>
        <button className="icon-button" aria-label="Open diff in separate tab" title="Open diff in separate tab" onClick={() => openDiff(surface.workspaceId, { kind: 'commit', snapshot: { hostId: surface.scope.hostId, repoPath: surface.scope.repoPath, ...selection }, file })}><ThemeActionOpenExternalIcon size={13} /></button>
        <button className="icon-button" aria-label="Close file diff" title="Close file diff" onClick={() => selectFile(surface.regionId, null)}><ThemeActionCloseIcon size={13} /></button>
      </div>
    </header>
    <div className="git-branch-diff__commits" aria-label="Fixed comparison commits"><span title={selection.parentOid ?? 'Empty tree'}>{selection.parentOid ? 'Parent · ' + selection.parentOid.slice(0, 8) : 'Empty tree'}</span><span title={selection.commitOid}>Commit · {selection.commitOid.slice(0, 8)}</span></div>
    {diff?.error && diff.diff && <div className="branches-inline-error" role="alert">{diff.error}</div>}
    <div className="git-branch-diff__canvas">{released ? <EditorReleasedState /> : <GitDiffCanvas diff={diff} wordWrap={wordWrap} language={detectLanguage(file.path)} theme={theme} />}</div>
  </section>
}
