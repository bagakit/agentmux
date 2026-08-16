import {
  Activity,
  ArrowUpRight,
  BellRing,
  Bot,
  CheckCircle2,
  Columns3,
  FolderGit2,
  Globe2,
  History,
  LoaderCircle,
  MessageSquarePlus,
  NotebookText,
  RadioTower,
  Send,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  BrowserToolbarConfig,
  SessionSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import {
  BROWSER_TOOLBAR_ITEM_LABELS,
  BROWSER_TOOLBAR_ITEM_ORDER,
  type BrowserToolbarItem
} from '../lib/browser-toolbar'
import { BOARD_COLUMN_DESCRIPTIONS } from '../lib/project-board'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import type { MainSurface } from '../store'
import {
  contentSlotPresentation,
  resolveWorkspaceTools,
  boardListSegments,
  workspaceAgentGroups,
  type WorkspaceAgentGroupId,
  type WorkspaceTool
} from '../lib/surface-tool-dock'
import { useBoardRows } from '../hooks/useBoardRows'
import { projectWorkspaces } from '../lib/workspace-projects'
import { api } from '../lib/api'
import { formatRelativeAge } from '../lib/relative-age'
import { contextPressure, contextUsedPercent } from '../lib/agent-usage'
import { CONTEXT_PRESSURE_HINT } from './AgentRoster'
import {
  browserAnnotationDisplayNumber,
  formatBrowserAnnotationsContext,
  type BrowserAnnotation
} from '../lib/browser-annotations'
import { workbenchSurfaces } from '../lib/workbench-tabs'
import { browserOpenError } from '../lib/browser-open-feedback'
import { presentError } from '../lib/error-presentation'
import { useAppStore } from '../store'
import { agentComposerAvailability } from './AgentSessionComposer'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'
import { WorkspaceTopicsPanel } from './WorkspaceTopicsPanel'
import { BranchesPanel } from './BranchesPanel'
import { ChangesPanel } from './ChangesPanel'
import { BrowserProfilesPanel } from './BrowserProfilesPanel'
import { FileExplorer, type FileExplorerRevealRequest } from './FileExplorer'
import { StatusDot } from './StatusDot'
import { SidebarToggleChrome } from './TopRowChrome'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'

type ToolDefinition<T extends string> = {
  id: T
  label: string
  description: string
  icon: typeof FolderGit2
}

const WORKSPACE_TOOL_META: Record<WorkspaceTool, Omit<ToolDefinition<WorkspaceTool>, 'id'>> = {
  'files-branches': { label: 'Files + Branches', description: 'Browse the selected worktree', icon: FolderGit2 },
  agents: { label: 'Agents', description: 'Find Agents that remain available after their Tab closes', icon: Bot },
  'browser-tools': { label: 'Browser Tools', description: 'Open browsers and configure their tools', icon: Globe2 }
}

const BOARD_TOOL: ToolDefinition<'branch-board'> = {
  id: 'branch-board',
  label: 'Branch Board',
  description: 'Inspect project Branches by run status',
  icon: Columns3
}

function ToolActionSurface({
  icon,
  eyebrow,
  title,
  description,
  actionLabel,
  busy,
  onAction,
  children
}: {
  icon: ReactNode
  eyebrow: string
  title: string
  description: string
  actionLabel: string
  busy?: boolean
  onAction: () => void
  children?: ReactNode
}) {
  return (
    <section className="surface-tool-action-surface">
      <div className="surface-tool-action-surface__icon">{icon}</div>
      <div className="eyebrow">{eyebrow}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      <button className="primary-button" type="button" disabled={busy} onClick={onAction}>
        {busy ? <LoaderCircle className="spin" size={14} /> : icon}
        {busy ? 'Opening…' : actionLabel}
      </button>
      {children}
    </section>
  )
}

export function BrowserToolbarPreferences({
  toolbar,
  saving,
  onSave
}: {
  toolbar: BrowserToolbarConfig
  saving: boolean
  onSave(toolbar: BrowserToolbarConfig): Promise<void>
}) {
  const [draft, setDraft] = useState(toolbar)

  useEffect(() => setDraft(toolbar), [toolbar])

  const dirty = BROWSER_TOOLBAR_ITEM_ORDER.some((item) => draft[item] !== toolbar[item])

  function setItem(item: BrowserToolbarItem, shown: boolean): void {
    setDraft((current) => ({ ...current, [item]: shown }))
  }

  return (
    <section className="browser-tools-preferences" aria-label="Browser bar visibility">
      <header><SlidersHorizontal size={14} /><span><strong>Browser bar</strong><small>External open is always visible.</small></span></header>
      <div>
        {BROWSER_TOOLBAR_ITEM_ORDER.map((item) => (
          <label key={item}>
            <input
              type="checkbox"
              checked={draft[item]}
              disabled={saving}
              onChange={(event) => setItem(item, event.target.checked)}
            />
            <span>{BROWSER_TOOLBAR_ITEM_LABELS[item]}</span>
          </label>
        ))}
      </div>
      <button
        className="small-button"
        type="button"
        disabled={!dirty || saving}
        onClick={() => void onSave(draft)}
      >
        {saving ? <LoaderCircle className="spin" size={12} /> : null}
        {saving ? 'Saving…' : 'Save Browser bar'}
      </button>
    </section>
  )
}

export function BrowserAnnotationsPanel({
  annotations,
  currentNavigationByBrowserId,
  agentSessions,
  onDelete,
  onClear,
  onAddToComposer
}: {
  annotations: BrowserAnnotation[]
  currentNavigationByBrowserId: Readonly<Record<string, string>>
  agentSessions: Array<Extract<SessionSnapshot, { kind: 'agent' }>>
  onDelete(browserId: string, annotationId: string): void
  onClear(): void
  onAddToComposer(sessionId: string, annotations: BrowserAnnotation[]): void
}) {
  const eligibleAgents = agentSessions.filter((session) => !agentComposerAvailability(session).disabled)
  const [targetSessionId, setTargetSessionId] = useState('')
  const currentAnnotations = annotations.filter((annotation) => (
    currentNavigationByBrowserId[annotation.browserId] === annotation.navigationId
  ))

  useEffect(() => {
    if (eligibleAgents.some(({ id }) => id === targetSessionId)) return
    setTargetSessionId(eligibleAgents.length === 1 ? eligibleAgents[0]!.id : '')
  }, [eligibleAgents, targetSessionId])

  return (
    <section className="browser-annotations" aria-label="Browser annotations">
      <header><MessageSquarePlus size={14} /><span><strong>Element annotations</strong><small>Desktop drafts stay out of Activity until you send them.</small></span></header>
      {annotations.length === 0 ? (
        <p>Select an element in a Browser tab, then add an annotation.</p>
      ) : (
        <div className="browser-annotations__list">
          {annotations.map((annotation, index) => {
            const current = currentNavigationByBrowserId[annotation.browserId] === annotation.navigationId
            return (
              <article key={annotation.id} className={current ? '' : 'stale'}>
                <b>{browserAnnotationDisplayNumber(annotations, index)}</b>
                <span>
                  <strong>{annotation.selection.accessibleName || `<${annotation.selection.tagName}>`}</strong>
                  <small>{current ? annotation.note || annotation.selection.selector : 'Page changed · annotation is stale'}</small>
                </span>
                <button type="button" aria-label="Delete annotation" onClick={() => onDelete(annotation.browserId, annotation.id)}><Trash2 size={12} /></button>
              </article>
            )
          })}
        </div>
      )}
      {annotations.length > 0 ? (
        <div className="browser-annotations__handoff">
          <label>
            <span>Agent Composer</span>
            <select value={targetSessionId} onChange={(event) => setTargetSessionId(event.target.value)}>
              <option value="">Choose an Agent…</option>
              {eligibleAgents.map((session) => <option key={session.id} value={session.id}>{session.label}</option>)}
            </select>
          </label>
          <div>
            <button className="small-button" type="button" onClick={onClear}>Clear all</button>
            <button
              className="primary-button"
              type="button"
              disabled={!targetSessionId || currentAnnotations.length === 0}
              onClick={() => onAddToComposer(targetSessionId, currentAnnotations)}
            >
              <Send size={12} /> Add to Composer
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function WorkspaceFilesTool({
  workspace,
  isScratch
}: {
  workspace: WorkspaceRecord
  isScratch: boolean
}) {
  const presentation = contentSlotPresentation(isScratch)
  const [explorerRevealRequest, setExplorerRevealRequest] = useState<FileExplorerRevealRequest>()
  const explorerRevealRequestId = useRef(0)
  // The content slot's bottom half is Branches by default (unchanged behavior); a real project can
  // switch it to Source Control changes. Scratch never shows this — it renders Topics instead.
  const [bottomView, setBottomView] = useState<'branches' | 'changes'>('branches')

  function revealDirectoryInExplorer(path: string): void {
    explorerRevealRequestId.current += 1
    setExplorerRevealRequest({
      workspaceId: workspace.id,
      path,
      requestId: explorerRevealRequestId.current
    })
  }

  return (
    <div className="workspace-tool-explorer">
      <div className="workspace-tool-context">
        <span>
          <strong>{workspace.name}</strong>
          <small>{isScratch ? 'Topic wiki' : (workspace.branch ?? workspace.path)}</small>
        </span>
        {workspace.hostId !== 'local' ? (
          <em><RadioTower size={11} /> {workspace.hostId}</em>
        ) : null}
      </div>
      <PanelGroup
        direction="vertical"
        className="workspace-tools-split"
        key={presentation.showTopics ? 'content-slot-topics' : 'content-slot-branches'}
      >
        <Panel defaultSize={presentation.fileTreeDefaultSize} minSize={presentation.fileTreeMinSize}>
          <FileExplorer key={workspace.id} revealRequest={explorerRevealRequest} />
        </Panel>
        <PanelResizeHandle className="workspace-tools-resize-handle" />
        <Panel defaultSize={100 - presentation.fileTreeDefaultSize} minSize={20}>
          {presentation.showTopics ? (
            <WorkspaceTopicsPanel
              workspace={workspace}
              onRevealDirectory={revealDirectoryInExplorer}
            />
          ) : (
            <div className="content-slot-source-control">
              <div className="source-control-switch" role="tablist" aria-label="Source control view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={bottomView === 'branches'}
                  className={bottomView === 'branches' ? 'selected' : ''}
                  onClick={() => setBottomView('branches')}
                >
                  Branches
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={bottomView === 'changes'}
                  className={bottomView === 'changes' ? 'selected' : ''}
                  onClick={() => setBottomView('changes')}
                >
                  Changes
                </button>
              </div>
              {bottomView === 'branches' ? (
                <BranchesPanel workspace={workspace} />
              ) : (
                <ChangesPanel workspace={workspace} />
              )}
            </div>
          )}
        </Panel>
      </PanelGroup>
    </div>
  )
}

// working / needs-you 的措辞取自 BOARD_COLUMN_DESCRIPTIONS：这两组就是 Board 那两列按 workspace 收窄，
// 同一个归类却在两个面上说两句话是漂移的入口（needs-you 这句原先手抄成 "Waiting or blocked"，漏掉了
// 那一列同样收着的 disconnected 与 error）。recent 有自己的话，因为它是 done 列在这里换了个名字。
const AGENT_GROUP_META: Record<WorkspaceAgentGroupId, {
  label: string
  description: string
  icon: typeof Activity
}> = {
  working: { label: 'Working', description: BOARD_COLUMN_DESCRIPTIONS.working, icon: Activity },
  'needs-you': { label: 'Needs You', description: BOARD_COLUMN_DESCRIPTIONS['needs-you'], icon: BellRing },
  recent: { label: 'Recent', description: 'Finished Agents', icon: History }
}

export function WorkspaceAgentsTool({
  workspace,
  sessions,
  onOpen
}: {
  workspace: WorkspaceRecord
  sessions: readonly SessionSnapshot[]
  onOpen(sessionId: string): void
}) {
  const groups = workspaceAgentGroups(sessions, workspace)
  const count = groups.reduce((total, group) => total + group.sessions.length, 0)

  return (
    <section className="workspace-agents-tool">
      <div className="workspace-tool-context">
        <span>
          <strong>{workspace.name}</strong>
          <small>Agent Sessions</small>
        </span>
        <em>{count}</em>
      </div>
      <div className="workspace-agents-tool__scroll">
        <p className="workspace-agents-tool__hint">Agents kept during Tab close remain available here.</p>
        {count === 0 ? (
          <div className="workspace-agents-tool__empty">
            <Bot size={18} />
            <strong>No Agents in this workspace</strong>
            <span>Start one from a new Tab. Choose “Keep Session” on close to leave it running here.</span>
          </div>
        ) : groups.map((group) => {
          if (group.sessions.length === 0) return null
          const meta = AGENT_GROUP_META[group.id]
          const Icon = meta.icon
          return (
            <section className="workspace-agent-group" key={group.id}>
              <header>
                <span><Icon size={11} /><strong>{meta.label}</strong><small>{meta.description}</small></span>
                <em>{group.sessions.length}</em>
              </header>
              <div>
                {group.sessions.map((session) => {
                  // 上下文压力：与花名册同源（agent-usage.ts 的 contextPressure/contextUsedPercent），
                  // 不在这里另立门槛。这是**空闲 Agent 也能看见压力**的地方——花名册那条 surface 已被
                  // 收进这个 dock，而 recent 组恰好收着跑完待机的 Agent，正是「快满却没人管」的那一类。
                  const percent = contextUsedPercent(session.turnUsage?.context)
                  const pressure = contextPressure(percent)
                  return (
                  <button
                    type="button"
                    className="workspace-agent-row"
                    key={session.id}
                    title={`Open or focus ${session.label}`}
                    onClick={() => onOpen(session.id)}
                  >
                    <span className="workspace-agent-row__mark">
                      <AgentProviderIcon providerId={session.providerId} size={15} />
                      <StatusDot status={session.status} />
                    </span>
                    <span className="workspace-agent-row__identity">
                      <strong>{session.label}</strong>
                      <small>
                        {agentProviderLabel(session.providerId)} · {session.status.state}
                        {/* 够上门槛才出现，且文案说的是下一步不是颜色名——沿用花名册那枚 data-pressure
                            标记（CSS 在 agent-panels.css），逻辑层不出现颜色。缺席即正常。 */}
                        {pressure ? (
                          <span
                            className="agent-roster__pressure"
                            data-pressure={pressure}
                            title={`Context window ${percent}% full — ${CONTEXT_PRESSURE_HINT[pressure]}`}
                          >
                            {percent}%
                          </span>
                        ) : null}
                      </small>
                    </span>
                    <time title={new Date(session.updatedAt).toLocaleString()}>{formatRelativeAge(Date.now() - session.updatedAt)}</time>
                    <ArrowUpRight size={11} />
                  </button>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Board 工具的次级面板：当前 Board 的工作清单。
 *
 * 用户打开它是来找一条具体的工作线，不是读一段介绍 Board 是什么的文案。行与 Board 主视图
 * 同源（`useBoardRows`），因此不会出现面板列了一条 Board 上没有的行。图例式静态说明降级为
 * 空态——没有任何行时它才有话说。
 */
export function BoardToolList({ hostId }: { hostId: string }) {
  const { rows, kind, loading, error } = useBoardRows()
  const selectSession = useAppStore((state) => state.selectSession)
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const { shown, hidden } = boardListSegments(rows, showAll)

  function toggleRow(id: string): void {
    setExpandedRows((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (error && rows.length === 0) {
    return <div className="surface-tool-error" role="alert">{error}</div>
  }

  if (rows.length === 0) {
    return (
      <section className="surface-tool-summary">
        <div className="surface-tool-summary__icon"><Columns3 size={18} /></div>
        <div className="eyebrow">Project board</div>
        <h2>{kind === 'topic' ? 'Topic × status' : 'Branch × status'}</h2>
        <p>
          {loading
            ? 'Reading the board…'
            : `No ${kind === 'topic' ? 'Topics' : 'branches'} yet. ${kind === 'topic' ? 'Create a Topic from the Topics panel' : 'Create a branch with Git'}, then it appears here as a row.`}
        </p>
        <div className="board-tool-legend">
          <div><MessageSquarePlus size={13} /><span><strong>Inbox</strong><small>Start a discussion</small></span></div>
          <div><Activity size={13} /><span><strong>Working</strong><small>Running now</small></span></div>
          <div><BellRing size={13} /><span><strong>Needs You</strong><small>{BOARD_COLUMN_DESCRIPTIONS['needs-you']}</small></span></div>
          <div><CheckCircle2 size={13} /><span><strong>Done</strong><small>Completed runs</small></span></div>
        </div>
      </section>
    )
  }

  return (
    <section className="board-tool-list">
      {error ? <div className="surface-tool-error" role="alert">{error}</div> : null}
      <div className="board-tool-context">
        <span><RadioTower size={12} /> {hostId === 'local' ? 'This Mac' : hostId}</span>
        <em>{rows.length} {kind === 'topic' ? 'topic' : 'branch'}{rows.length === 1 ? '' : 'es'}</em>
      </div>
      {shown.map((row) => {
        const isOpen = expandedRows.has(row.id)
        return (
          <div className="board-tool-row" key={row.id}>
            <button
              className="board-tool-row__head"
              type="button"
              aria-expanded={isOpen}
              onClick={() => toggleRow(row.id)}
              title={row.name}
            >
              {row.kind === 'topic' ? <NotebookText size={12} /> : <FolderGit2 size={12} />}
              <strong>{row.name}</strong>
              <em>{row.sessions.length}</em>
            </button>
            {isOpen ? (
              <div className="board-tool-row__agents">
                {row.sessions.length === 0
                  ? <small className="board-tool-row__empty">No agents on this row</small>
                  : row.sessions.map((session) => (
                    <button
                      className="board-tool-agent"
                      key={session.id}
                      type="button"
                      // 定位走全局那一个 selectSession，不新增第二条导航路径。
                      onClick={() => selectSession(session.id)}
                      aria-label={`Open ${session.label} · ${session.status.state}`}
                      title={`${session.label} · ${session.status.state}`}
                    >
                      <StatusDot status={session.status} />
                      {session.providerId ? <AgentProviderIcon providerId={session.providerId} size={11} /> : null}
                      <span>{session.label}</span>
                    </button>
                  ))}
              </div>
            ) : null}
          </div>
        )
      })}
      {hidden > 0 ? (
        <button className="board-tool-more" type="button" onClick={() => setShowAll(true)}>
          其余 {hidden} 条
        </button>
      ) : null}
    </section>
  )
}

export function SurfaceToolDock({
  surface,
  workspace
}: {
  surface: MainSurface
  workspace: WorkspaceRecord | undefined
}) {
  const workspaceTool = useAppStore((state) => state.workspaceTool)
  const projectRailOpen = useAppStore((state) => state.projectRailOpen)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const setConfig = useAppStore((state) => state.setConfig)
  const layout = useAppStore((state) => workspace ? state.layouts[workspace.id] : undefined)
  const createBrowser = useAppStore((state) => state.createBrowser)
  const selectSession = useAppStore((state) => state.selectSession)
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const tabs = useAppStore((state) => state.tabs)
  const browserAnnotationsByBrowserId = useAppStore((state) => state.browserAnnotationsByBrowserId)
  const deleteBrowserAnnotation = useAppStore((state) => state.deleteBrowserAnnotation)
  const clearBrowserAnnotations = useAppStore((state) => state.clearBrowserAnnotations)
  const appendAgentComposerDraft = useAppStore((state) => state.appendAgentComposerDraft)
  const [startingBrowser, setStartingBrowser] = useState(false)
  const [savingBrowserToolbar, setSavingBrowserToolbar] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isBoard = surface === 'board'
  const fileEditingProbe = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('agentmux-file-editing-report') === '1'
  // Scratch is a wiki-first workspace: the content slot keeps its `files-branches` role but is
  // re-skinned as `Files + Topics` (see contentSlotPresentation), so the tool set never diverges
  // and the global workspaceTool is never mutated.
  const isScratch = Boolean(workspace && isScratchWorkspaceId(workspace.id))
  const { tools: workspaceToolIds, effective: effectiveWorkspaceTool } = resolveWorkspaceTools({
    workspaceTool,
    isScratch
  })
  const contentSlot = contentSlotPresentation(isScratch)
  const tools: ToolDefinition<string>[] = isBoard
    ? [BOARD_TOOL]
    : workspaceToolIds.map((id) => {
        const meta = WORKSPACE_TOOL_META[id]
        // Re-skin the content slot for Scratch without changing its enum id.
        if (id === 'files-branches' && isScratch) {
          return { id, ...meta, label: contentSlot.label, description: 'Browse the topic wiki and collaborators', icon: NotebookText }
        }
        return { id, ...meta }
      })
  const selectedTool = isBoard ? BOARD_TOOL.id : fileEditingProbe ? 'files-branches' : effectiveWorkspaceTool
  const activePaneId = layout?.activeGroupId
  const project = workspace
    ? projectWorkspaces(config?.workspaces ?? []).find((candidate) =>
        candidate.workspaces.some((item) => item.id === workspace.id)
      )
    : null
  const allBrowserSurfaces = Object.values(tabs).flatMap((tab) => workbenchSurfaces(tab))
    .flatMap((candidate) => candidate.kind === 'browser' ? [candidate] : [])
  const browserSurfaces = allBrowserSurfaces.filter((candidate) => candidate.workspaceId === workspace?.id)
  const currentNavigationByBrowserId = Object.fromEntries(browserSurfaces.map((browser) => [
    browser.browserId,
    browser.navigationId
  ]))
  const browserAnnotations = Object.values(browserAnnotationsByBrowserId).flat()
    .filter((annotation) => annotation.workspaceId === workspace?.id)
  const workspaceAgentSessions = sessions.flatMap((session) => (
    workspace && session.kind === 'agent' && workspaceOwnsSessionPath(workspace, session) ? [session] : []
  ))

  async function openBrowser(): Promise<void> {
    if (startingBrowser) return
    const focusError = browserOpenError(activePaneId)
    if (focusError || !activePaneId) {
      setError(focusError ?? browserOpenError(undefined)!)
      return
    }
    setStartingBrowser(true)
    setError(null)
    try {
      await createBrowser(activePaneId)
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setStartingBrowser(false)
    }
  }

  async function saveBrowserToolbar(toolbar: BrowserToolbarConfig): Promise<void> {
    if (savingBrowserToolbar) return
    const current = useAppStore.getState().config
    if (!current) return
    setSavingBrowserToolbar(true)
    setError(null)
    try {
      setConfig(await api.config.save({ ...current, browser: { ...current.browser, toolbar } }))
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setSavingBrowserToolbar(false)
    }
  }

  return (
    <aside className="surface-tool-panel" aria-label={`${isBoard ? 'Board' : 'Workspace'} tools`}>
      <header className={`surface-tool-activitybar ${projectRailOpen ? '' : 'surface-tool-activitybar--compact-chrome'}`}>
        {!projectRailOpen ? <SidebarToggleChrome /> : null}
        <nav aria-label={`${isBoard ? 'Board' : 'Workspace'} tool selection`}>
          {tools.map((tool) => {
            const Icon = tool.icon
            return (
              <button
                key={tool.id}
                type="button"
                className={selectedTool === tool.id ? 'selected' : ''}
                aria-label={tool.label}
                aria-pressed={selectedTool === tool.id}
                title={`${tool.label} — ${tool.description}`}
                onClick={() => {
                  if (!isBoard) setWorkspaceTool(tool.id as WorkspaceTool)
                }}
              >
                <Icon size={15} />
              </button>
            )
          })}
        </nav>
        <span>{tools.find((tool) => tool.id === selectedTool)?.label}</span>
      </header>
      <div className="surface-tool-content">
        {!isBoard && selectedTool === 'files-branches' && workspace ? (
          <WorkspaceFilesTool workspace={workspace} isScratch={isScratch} />
        ) : null}
        {!isBoard && effectiveWorkspaceTool === 'agents' && workspace ? (
          <WorkspaceAgentsTool
            workspace={workspace}
            sessions={sessions}
            onOpen={(sessionId) => selectSession(sessionId, activePaneId)}
          />
        ) : null}
        {!isBoard && effectiveWorkspaceTool === 'browser-tools' && workspace && config ? (
          <ToolActionSurface
            icon={<Globe2 size={17} />}
            eyebrow="Browser Tools"
            title="Open a browser tab"
            description="Open a Main-owned browser in the focused Universal Pane, then choose which controls stay on its Browser bar."
            actionLabel="New Browser"
            busy={startingBrowser}
            onAction={() => void openBrowser()}
          >
            <BrowserToolbarPreferences
              toolbar={config.browser.toolbar}
              saving={savingBrowserToolbar}
              onSave={saveBrowserToolbar}
            />
            <BrowserProfilesPanel browsers={browserSurfaces} allBrowsers={allBrowserSurfaces} />
            <BrowserAnnotationsPanel
              annotations={browserAnnotations}
              currentNavigationByBrowserId={currentNavigationByBrowserId}
              agentSessions={workspaceAgentSessions}
              onDelete={deleteBrowserAnnotation}
              onClear={() => {
                for (const browserId of new Set(browserAnnotations.map(({ browserId }) => browserId))) {
                  clearBrowserAnnotations(browserId)
                }
              }}
              onAddToComposer={(sessionId, currentAnnotations) => {
                appendAgentComposerDraft(sessionId, formatBrowserAnnotationsContext(currentAnnotations))
                selectSession(sessionId, activePaneId)
              }}
            />
          </ToolActionSurface>
        ) : null}
        {isBoard ? <BoardToolList hostId={project?.hostId ?? workspace?.hostId ?? 'local'} /> : null}
        {error ? <div className="surface-tool-error" role="alert">{error}</div> : null}
      </div>
    </aside>
  )
}
