import { memo, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { WorkspaceRecord } from '../../../../shared/contracts'
import type { GitCommitSnapshot } from '../../../../shared/git-contracts'
import type { GitWorkbenchSurface } from '../../lib/workbench-tabs'
import { detectLanguage } from '../../lib/language-detect'
import { useMonacoTheme } from '../../hooks/useMonacoTheme'
import { useAppStore } from '../../store'
import { EditorReleasedState } from '../../components/EditorReleasedState'
import { GitHistoryPanel, type GitHistoryViewportState } from './history/GitHistoryPanel'
import { useGitHistory, type GitHistoryWindow } from './history/useGitHistory'
import { useGitHistoryReader, useSharedGitHistory } from './history/GitHistoryContext'
import { GitCommitDetails } from './commit/GitCommitDetails'
import { useGitCommitDetails } from './commit/useGitCommitDetails'
import { GitDiffCanvas } from './diff/GitDiffCanvas'

const ThemeGitCommitIcon = semanticIconComponent('git.commit')
const ThemeObjectListIcon = semanticIconComponent('object.list')
const ThemeLayoutCloseLeftIcon = semanticIconComponent('layout.close-left')
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
    <strong>{surface.history ? 'Repository history' : surface.selection ? `Commit ${surface.selection.commitOid.slice(0, 8)}` : 'Commit details'}</strong>
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
      <button className="small-button" aria-label="View repository history" onClick={() => openHistory(workspace.id, surface.scope, reference)}><ThemeObjectListIcon size={13} /><span>History</span></button>
      {surface.selection && <button className="small-button" aria-label="Locate commit in history" onClick={() => openHistory(workspace.id, surface.scope, reference, { ...surface.scope, ...surface.selection! })}>Locate in history</button>}
    </Header>
    <CommitReview {...props} />
  </section>
}
function RepositoryReader(props: ViewProps) {
  const shared = useSharedGitHistory(props.workspace)
  const local = useGitHistory(props.workspace, props.visible && !shared)
  const localViewport = useRef<GitHistoryViewportState | null>(null)
  const history = shared?.history ?? local
  const viewportState = shared?.viewportState ?? localViewport
  // This Region remains mounted when the sidebar moves to another Workspace. Transfer only
  // completed facts for the exact resource; an in-flight read remains owned by its source.
  const previous = useRef<{ shared: boolean; window: GitHistoryWindow | null; viewport: RefObject<GitHistoryViewportState | null> } | null>(null)
  const changingOwner = previous.current && previous.current.shared !== Boolean(shared) ? previous.current : null
  const savedPosition = changingOwner?.viewport.current
  useLayoutEffect(() => {
    if (changingOwner) {
      if (changingOwner.window) history.adoptWindow(changingOwner.window)
      viewportState.current = savedPosition ? { ...savedPosition } : null
    }
    previous.current = { shared: Boolean(shared), window: history.captureWindow(), viewport: viewportState }
  })
  useGitHistoryReader(shared, props.surface.regionId, props.workspace, 'repository', props.visible)
  return <RepositoryView {...props} history={history} viewportState={viewportState} />
}
function RepositoryView({ history, viewportState, ...props }: ViewProps & {
  history: ReturnType<typeof useGitHistory>; viewportState: RefObject<GitHistoryViewportState | null>
}) {
  const { surface, workspace, visible } = props
  const selectCommit = useAppStore(state => state.selectGitCommit)
  const selectReference = useAppStore(state => state.selectGitHistoryReference)
  const showDetails = useAppStore(state => state.showGitCommitDetails)
  const select = useCallback((snapshot: GitCommitSnapshot) => selectCommit(surface.regionId, snapshot), [surface.regionId, selectCommit])
  // Apply the durable initial range before the reader's enabled effect. Later changes stay owned
  // by the same reading window, and are only projected back into this Region for restoration.
  const initialRange = useRef<{ regionId: string; desired: string | null; applied: boolean } | null>(null)
  useLayoutEffect(() => {
    if (!visible || initialRange.current?.regionId === surface.regionId) return
    initialRange.current = { regionId: surface.regionId, desired: surface.history?.reference ?? null, applied: false }
    if (surface.history && history.reference !== surface.history.reference) history.selectReference(surface.history.reference)
  }, [visible, surface.regionId, surface.history?.reference, history.selectReference])
  useEffect(() => {
    const initial = initialRange.current
    if (!history.result && !history.error || !visible || initial?.regionId !== surface.regionId || !initial.applied && history.reference !== initial.desired) return
    initial.applied = true
    selectReference(surface.regionId, history.reference)
  }, [visible, surface.regionId, history.reference, history.result, history.error, selectReference])
  const ready = history.result?.kind === 'ready' ? history.result : null
  const foreign = Boolean(ready && (ready.snapshot.hostId !== surface.scope.hostId || ready.snapshot.repoPath !== surface.scope.repoPath))
  const focusOid = surface.history?.focusOid
  const found = Boolean(focusOid && ready?.commits.some(commit => commit.oid === focusOid))
  return <section className="git-workbench" data-git-workbench-region={surface.regionId} aria-label="Git repository history">
    <Header surface={surface} workspace={workspace}>
      <button className="small-button" aria-label="Move history to sidebar" onClick={() => showDetails(surface.regionId)}><ThemeLayoutCloseLeftIcon size={13} /><span>To sidebar</span></button>
    </Header>
    {focusOid && !found && <div className="git-workbench__locating" role="status">
      <span>{foreign ? 'The repository changed; the saved commit is retained.' : history.error ? 'Locating paused. Retry history to continue.' : ready && !ready.nextCursor ? 'This commit is outside the current history range.' : 'This commit has not been loaded in the current range.'}</span>
      {!foreign && ready?.nextCursor && <button className="small-button" disabled={history.loading} onClick={() => void history.loadMore()}>Read next history page</button>}
    </div>}
    <div className="git-workbench__body">
      <aside className="git-workbench__history" aria-label="Repository history">
        {foreign ? <div className="git-history-error" role="alert"><span>The repository changed. The saved scope and commit are retained.</span><button onClick={() => void history.refresh()}>Retry history</button></div>
          : <GitHistoryPanel workspace={workspace} history={history} onSelectCommit={select} viewportState={viewportState}
            {...(surface.selection ? { selectedOid: surface.selection.commitOid } : {})} {...(found && focusOid ? { revealOid: focusOid } : {})} />}
      </aside>
      <CommitReview {...props} />
    </div>
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
