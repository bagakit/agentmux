import {
  Activity,
  ArrowUpRight,
  BellRing,
  Bot,
  CheckCircle2,
  Columns3,
  Crosshair,
  FolderGit2,
  Globe2,
  History,
  LoaderCircle,
  MessageSquarePlus,
  NotebookText,
  Plus,
  RadioTower,
  Send,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  BrowserToolbarConfig,
  ScratchTopicSnapshot,
  SessionSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import {
  BROWSER_TOOLBAR_ITEM_LABELS,
  BROWSER_TOOLBAR_ITEM_ORDER,
  type BrowserToolbarItem
} from '../lib/browser-toolbar'
import {
  SCRATCH_TOPIC_TITLE_MAX_LENGTH,
  workspaceOwnsSessionPath
} from '../../../shared/scratch-topics'
import type { MainSurface } from '../store'
import {
  contentSlotPresentation,
  resolveWorkspaceTools,
  topicAgentPresentation,
  topicsWithAgents,
  workspaceAgentGroups,
  type WorkspaceAgentGroupId,
  type WorkspaceTool
} from '../lib/surface-tool-dock'
import { sessionBoardColumn } from '../lib/project-board'
import { projectWorkspaces } from '../lib/workspace-projects'
import { api } from '../lib/api'
import {
  browserAnnotationDisplayNumber,
  formatBrowserAnnotationsContext,
  type BrowserAnnotation
} from '../lib/browser-annotations'
import { workbenchSurfaces } from '../lib/workbench-tabs'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { orderTopics, reorderTopics } from '../lib/topic-order'
import { TopicContextMenu } from './TopicContextMenu'
import { useAppStore } from '../store'
import { agentComposerAvailability } from './AgentSessionComposer'
import { AgentAvatar } from './AgentAvatar'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'
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
          <FileExplorer revealRequest={explorerRevealRequest} />
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

function WorkspaceTopicsPanel({
  workspace,
  onRevealDirectory
}: {
  workspace: WorkspaceRecord
  onRevealDirectory(path: string): void
}) {
  const layout = useAppStore((state) => state.layouts[workspace.id])
  const activeTabId = layout?.groups.find((group) => group.id === layout.activeGroupId)?.activeTabId
  const topicId = useAppStore((state) => activeTabId ? state.tabs[activeTabId]?.topicId : undefined)
  const fileRevision = useAppStore((state) => state.workspaceFileRevisions[workspace.id] ?? 0)
  const sessions = useAppStore((state) => state.sessions)
  const createScratchTopic = useAppStore((state) => state.createScratchTopic)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const renameScratchTopic = useAppStore((state) => state.renameScratchTopic)
  // 头像点击走全局那一个 selectSession——跳转到某个 Agent 全窗口只有这一条路径，
  // 在这里另写一段"找到它的 Tab 再激活"就是第二条，两条迟早对不上。
  const selectSession = useAppStore((state) => state.selectSession)
  const [topics, setTopics] = useState<ScratchTopicSnapshot[] | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The Topic list is authoritative and comes from the filesystem snapshot. Live Sessions are
  // matched onto it here for display; they never add or remove a Topic.
  // 拖拽要有一小段距离才启动，否则点一下打开 Topic 会被误判成拖动。键盘 sensor 提供等价路径。
  const topicSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const topicOrder = useAppStore((state) => state.scratchTopicOrder)
  const setTopicOrder = useAppStore((state) => state.setScratchTopicOrder)
  // 文件系统仍是 Topic 存在与否的真相；用户顺序只决定怎么排。
  const projected = topics
    ? (() => {
        const withAgents = topicsWithAgents(topics, sessions, workspace)
        const shown = orderTopics(withAgents.map((topic) => topic.id), topicOrder)
        return shown.flatMap((id) => withAgents.filter((topic) => topic.id === id))
      })()
    : null
  const currentTopic = projected?.find((topic) => topic.id === topicId)
  const compact = topics === null || topics.length > 0

  useEffect(() => {
    let active = true
    setError(null)
    void api.scratch.listTopics(workspace.id).then((snapshots) => {
      if (active) setTopics(snapshots)
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [fileRevision, workspace.id])

  async function createTopic(): Promise<void> {
    if (pending) return
    setPending('create')
    setError(null)
    try {
      const created = await createScratchTopic()
      setTopics((current) => {
        const next = [...(current ?? []).filter((topic) => topic.id !== created.id), created]
        return next.sort((left, right) =>
          left.directoryPath < right.directoryPath ? -1 : left.directoryPath > right.directoryPath ? 1 : 0
        )
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  async function openTopic(nextTopicId: string): Promise<void> {
    if (pending) return
    setPending(nextTopicId)
    setError(null)
    try {
      await openScratchTopic(nextTopicId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  function beginRename(topic: ScratchTopicSnapshot): void {
    if (pending) return
    setError(null)
    setEditingTopicId(topic.id)
    setEditTitle(topic.title)
  }

  function cancelRename(): void {
    setEditingTopicId(null)
    setEditTitle('')
  }

  async function commitRename(topic: ScratchTopicSnapshot): Promise<void> {
    const title = editTitle.trim()
    if (pending) return
    if (!title) {
      setError('Scratch Topic title cannot be empty')
      return
    }
    if (title === topic.title) {
      cancelRename()
      return
    }
    const pendingId = `rename:${topic.id}`
    setPending(pendingId)
    setError(null)
    try {
      const renamed = await renameScratchTopic(topic.id, title)
      setTopics((current) => current?.map((entry) => entry.id === renamed.id ? renamed : entry) ?? null)
      cancelRename()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  return (
    <section className={`surface-tool-summary workspace-topics-panel workspace-topics-panel--${compact ? 'index' : 'empty'}`}>
      {compact ? (
        <header className="workspace-topic-index-header">
          <span>
            <NotebookText size={14} />
            <strong>Topics</strong>
            {topics ? <em>{topics.length}</em> : null}
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="Create new Topic"
            title="Create new Topic"
            disabled={pending !== null || topics === null}
            onClick={() => void createTopic()}
          >
            {topics === null || pending === 'create'
              ? <LoaderCircle className="spin" size={13} />
              : <Plus size={14} />}
          </button>
        </header>
      ) : (
        <>
          <div className="surface-tool-summary__icon"><NotebookText size={18} /></div>
          <div className="eyebrow">Topics</div>
          <h2>No Topics yet</h2>
          <p>A Topic is a real shared directory for a goal, outcomes, references, and collaborating Agents.</p>
          <button className="primary-button" type="button" disabled={pending !== null} onClick={() => void createTopic()}>
            {pending === 'create' ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}
            {pending === 'create' ? 'Creating…' : 'Create new Topic'}
          </button>
        </>
      )}
      {projected && projected.length > 0 ? (
        <DndContext
          sensors={topicSensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => {
            const movedId = String(event.active.id)
            const targetId = event.over ? String(event.over.id) : movedId
            setTopicOrder(reorderTopics(projected.map((entry) => entry.id), movedId, targetId))
          }}
        >
        <SortableContext
          items={projected.map((entry) => entry.id)}
          strategy={verticalListSortingStrategy}
        >
        <div className="workspace-topic-list" aria-label="Scratch Topics">
          {projected.map((topic) => {
            const isCurrent = topic.id === currentTopic?.id
            const editing = editingTopicId === topic.id
            return (
              <SortableTopicItem
                topicId={topic.id}
                isCurrent={isCurrent}
                key={topic.id}
                onCopyPath={() => void api.ui.writeClipboardText(topic.directoryPath)}
                onRename={() => beginRename(topic)}
                onReveal={() => onRevealDirectory(topic.directoryPath)}
              >
                {editing ? (
                  <form
                    className="workspace-topic-rename-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void commitRename(topic)
                    }}
                  >
                    <input
                      autoFocus
                      aria-label={`Rename ${topic.title}`}
                      value={editTitle}
                      maxLength={SCRATCH_TOPIC_TITLE_MAX_LENGTH}
                      onChange={(event) => setEditTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelRename()
                        }
                      }}
                    />
                  </form>
                ) : (
                  <button
                    className="workspace-topic-entry"
                    type="button"
                    disabled={pending !== null}
                    onClick={() => void openTopic(topic.id)}
                  >
                    {/* 行首不放 Topic 图标：一列全同的图标不携带信息，只在挤压标题宽度。
                        这个位置只在真的有话说时才占用——正在打开时的那枚 spinner。 */}
                    {pending === topic.id ? <LoaderCircle className="spin" size={14} /> : null}
                    <span>
                      <span className="workspace-topic-title-line">
                        <strong>{topic.title}</strong>
                        {/* 每个 Agent 一枚头像：身份看图标、状态看边框，一枚方块答完两件事。
                            这里不给 `N agents` 计数——头像逐个在场，计数是把同一事实说第二遍。 */}
                        {topic.agents.length > 0 ? (
                          <span className="workspace-topic-agents">
                            {topic.agents.map((agent) => {
                              const shown = topicAgentPresentation(agent)
                              return (
                                <AgentAvatar
                                  attention={shown.attention}
                                  key={agent.sessionId}
                                  label={agent.live?.label ?? agent.sessionId}
                                  onOpen={() => selectSession(agent.sessionId)}
                                  providerId={agent.providerId}
                                  state={shown.state}
                                />
                              )
                            })}
                          </span>
                        ) : null}
                      </span>
                      <small>
                        <span>{topic.summary || topic.directoryPath}</span>
                      </small>
                    </span>
                  </button>
                )}
                {/* 行上只留最高频的那个动作。改名收进右键菜单——它一天用不了一次，
                    占一个常驻图标位是在跟标题抢宽度。 */}
                <button
                  className="icon-button workspace-topic-reveal"
                  type="button"
                  aria-label={`Reveal ${topic.title} in Explorer`}
                  title="Reveal in Explorer"
                  disabled={pending !== null}
                  onClick={() => onRevealDirectory(topic.directoryPath)}
                >
                  <Crosshair size={13} />
                </button>
              </SortableTopicItem>
            )
          })}
        </div>
        </SortableContext>
        </DndContext>
      ) : null}
      {error ? <div className="new-tab-error" role="alert">{error}</div> : null}
    </section>
  )
}

const AGENT_GROUP_META: Record<WorkspaceAgentGroupId, {
  label: string
  description: string
  icon: typeof Activity
}> = {
  working: { label: 'Working', description: 'Running now', icon: Activity },
  'needs-you': { label: 'Needs You', description: 'Waiting or blocked', icon: BellRing },
  recent: { label: 'Recent', description: 'Finished Agents', icon: History }
}

function formatAgentAge(timestamp: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function WorkspaceAgentsTool({
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
                {group.sessions.map((session) => (
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
                      <small>{agentProviderLabel(session.providerId)} · {session.status.state}</small>
                    </span>
                    <time title={new Date(session.updatedAt).toLocaleString()}>{formatAgentAge(session.updatedAt)}</time>
                    <ArrowUpRight size={11} />
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </section>
  )
}

function BoardToolSummary({
  projectName,
  hostId,
  workspaceCount,
  workingCount,
  needsYouCount,
  doneCount
}: {
  projectName: string
  hostId: string
  workspaceCount: number
  workingCount: number
  needsYouCount: number
  doneCount: number
}) {
  return (
    <section className="surface-tool-summary">
      <div className="surface-tool-summary__icon"><Columns3 size={18} /></div>
      <div className="eyebrow">Project board</div>
      <h2>Branch × status</h2>
      <p>{projectName} uses Branches as rows and run state as columns. Inbox lives in the board itself.</p>
      <div className="board-tool-context">
        <span><RadioTower size={12} /> {hostId === 'local' ? 'This Mac' : hostId}</span>
        <em>{workspaceCount} worktree{workspaceCount === 1 ? '' : 's'}</em>
      </div>
      <div className="board-tool-legend">
        <div><MessageSquarePlus size={13} /><span><strong>Inbox</strong><small>Start a Branch discussion</small></span><em>Open</em></div>
        <div><Activity size={13} /><span><strong>Working</strong><small>Running now</small></span><em>{workingCount}</em></div>
        <div><BellRing size={13} /><span><strong>Needs You</strong><small>Waiting or blocked</small></span><em>{needsYouCount}</em></div>
        <div><CheckCircle2 size={13} /><span><strong>Done</strong><small>Completed runs</small></span><em>{doneCount}</em></div>
      </div>
    </section>
  )
}

/**
 * 一行 Topic，可拖拽重排。
 *
 * 复用 Tab 条已经在用的 @dnd-kit/sortable，不自写拖拽；键盘 sensor 一并挂上，
 * 使重排不因为"改成拖拽"而只剩鼠标一条路。
 */
function SortableTopicItem({
  topicId,
  isCurrent,
  children,
  onCopyPath,
  onRename,
  onReveal
}: {
  topicId: string
  isCurrent: boolean
  children: ReactNode
  onCopyPath(): void
  onRename(): void
  onReveal(): void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: topicId
  })
  return (
    <TopicContextMenu onCopyPath={onCopyPath} onRename={onRename} onReveal={onReveal}>
      <div
        ref={setNodeRef}
        className={`workspace-topic-item${isCurrent ? ' current' : ''}${isDragging ? ' dragging' : ''}`}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        {...attributes}
        {...listeners}
      >
        {children}
      </div>
    </TopicContextMenu>
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
  const selectedTool = isBoard ? BOARD_TOOL.id : effectiveWorkspaceTool
  const activePaneId = layout?.activeGroupId
  const project = workspace
    ? projectWorkspaces(config?.workspaces ?? []).find((candidate) =>
        candidate.workspaces.some((item) => item.id === workspace.id)
      )
    : null
  const workspaceCount = project?.workspaces.length ?? 0
  const projectSessions = sessions.filter((session) =>
    Boolean(project?.workspaces.some((item) => workspaceOwnsSessionPath(item, session)))
  )
  const runCounts = { working: 0, 'needs-you': 0, done: 0 }
  for (const session of projectSessions) runCounts[sessionBoardColumn(session)] += 1
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
    if (!activePaneId || startingBrowser) return
    setStartingBrowser(true)
    setError(null)
    try {
      await createBrowser(activePaneId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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
      setError(cause instanceof Error ? cause.message : String(cause))
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
        {!isBoard && effectiveWorkspaceTool === 'files-branches' && workspace ? (
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
        {isBoard && project ? (
          <BoardToolSummary
            projectName={project.name}
            hostId={project.hostId}
            workspaceCount={workspaceCount}
            workingCount={runCounts.working}
            needsYouCount={runCounts['needs-you']}
            doneCount={runCounts.done}
          />
        ) : null}
        {error ? <div className="surface-tool-error" role="alert">{error}</div> : null}
      </div>
    </aside>
  )
}
